import { SUBAGENT_THREAD_PREFIX, type CoreSession, type PendingApproval, type SignalOutcome } from "../core-bridge.ts";
import {
  VOICE_GENDERS,
  VOICE_LANGUAGES,
  VOICE_MAX_RUNNING_TASKS,
  type VoiceActivity,
  type VoiceLanguage,
  type VoicePreferences,
  type VoiceSettings,
  type VoiceTaskSummary,
  type VoiceToolCall,
  resultExcerpt,
} from "./protocol.ts";
import { pickVoice, voiceLabel } from "./voices.ts";

export interface HeldOutput {
  source: string;
  category: string;
}

export interface VoiceConfirmation {
  approved: boolean;
  title: string;
  summary: string;
  hold?: HeldOutput;
  execute(): Promise<VoiceToolOutcome>;
}

export interface VoiceToolOutcome {
  content: string;
  isError?: boolean;
  confirm?: VoiceConfirmation;
  ask?: true;
  activity?: VoiceActivity;
}

export interface TaskTail {
  title: string | null;
  reply: string;
  failed: boolean;
}

export interface VoiceToolDeps {
  user: string;
  settings(): VoiceSettings;
  saveSettings(patch: Partial<VoicePreferences>): Promise<VoiceSettings>;
  sessions(): Promise<CoreSession[]>;
  titles: ReadonlyMap<string, string>;
  startingTasks(): ReadonlyMap<string, VoiceTaskSummary["state"]>;
  startTurn(body: { text: string; threadRef: string; idempotencyKey: string }): Promise<{
    runId?: string;
    status?: string;
    steered?: boolean;
  }>;
  tail(sessionId: string): Promise<TaskTail>;
  approvals(sessionId: string): Promise<PendingApproval[]>;
  resolveApproval(decision: { requestId: string; approved: boolean; scope?: "once" }): Promise<unknown>;
  activeRun(threadRef: string): Promise<string | null>;
  abortRun(runId: string): Promise<void>;
  steer(runId: string, queuedRunId: string, threadRef: string, text: string): Promise<SignalOutcome>;
  open(session: CoreSession): void;
  delegated(threadRef: string, title: string): void;
  newId(): string;
}

const TASK_MESSAGE_CHARS = 2_000;
const CONFIRM_SUMMARY_CHARS = 200;

function voiceThreadRef(user: string, id: string): string {
  return `web:${user}:voice:${id}`;
}

export function isVoiceThread(user: string, threadRef: string): boolean {
  return threadRef.startsWith(voiceThreadRef(user, ""));
}

export function taskState(
  session: Pick<CoreSession, "working" | "awaitingInput" | "securityHeld">,
): VoiceTaskSummary["state"] {
  if (session.awaitingInput) return session.securityHeld ? "held" : "awaiting_approval";
  return session.working ? "working" : "idle";
}

const HOLD_CATEGORIES: Record<VoiceLanguage, Record<string, string>> = {
  es: {
    instruction_override: "anulación de instrucciones",
    credential_request: "petición de credenciales",
    data_exfiltration: "exfiltración de datos",
    security_weakening: "debilitar la seguridad",
    hidden_behavior: "comportamiento oculto",
    other: "instrucciones no fiables",
  },
  en: {},
};

export function heldOutput(pending: PendingApproval | undefined, language: VoiceLanguage): HeldOutput | null {
  const view = pending?.securityHoldView;
  if (!view) return null;
  const category = (view.category && HOLD_CATEGORIES[language][view.category]) || view.categoryLabel.toLowerCase();
  return { source: view.held, category };
}

export function heldSubagents(sessions: readonly CoreSession[]): Map<string, CoreSession> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const held = new Map<string, CoreSession>();
  for (const session of sessions) {
    if (!session.threadRef.startsWith(SUBAGENT_THREAD_PREFIX) || taskState(session) !== "held") continue;
    let root = session;
    for (let hops = 0; hops < sessions.length && root.threadRef.startsWith(SUBAGENT_THREAD_PREFIX); hops++) {
      const parent = root.parentSessionId ? byId.get(root.parentSessionId) : undefined;
      if (!parent) break;
      root = parent;
    }
    if (root !== session && !held.has(root.id)) held.set(root.id, session);
  }
  return held;
}

export function leadingApproval(approvals: readonly PendingApproval[]): PendingApproval | undefined {
  return approvals.find((approval) => approval.securityHoldView) ?? approvals[0];
}

export function taskTitle(session: Pick<CoreSession, "title" | "channelName">): string {
  return (session.title ?? session.channelName ?? "").trim().slice(0, 200) || "Untitled";
}

export function taskSummaries(
  sessions: readonly CoreSession[],
  titles: ReadonlyMap<string, string> = new Map(),
  unlisted: ReadonlyMap<string, VoiceTaskSummary["state"]> = new Map(),
  limit = VOICE_MAX_RUNNING_TASKS,
): VoiceTaskSummary[] {
  const rank = { awaiting_approval: 0, held: 0, working: 1, idle: 2 } as const;
  const listed = new Set(sessions.map((session) => session.threadRef));
  const heldBelow = heldSubagents(sessions);
  const starting = [...unlisted]
    .filter(([threadRef, state]) => state !== "idle" && !listed.has(threadRef))
    .map(([threadRef, state]) => ({
      taskRef: threadRef,
      title: titles.get(threadRef) ?? "",
      state,
      at: Number.MAX_SAFE_INTEGER,
    }));
  const known = sessions
    .filter((session) => !session.archived && !session.threadRef.startsWith(SUBAGENT_THREAD_PREFIX))
    .map((session) => ({
      taskRef: session.threadRef,
      title: titles.get(session.threadRef) || taskTitle(session),
      state: heldBelow.has(session.id) ? ("held" as const) : taskState(session),
      at: session.lastActivityAt ?? session.createdAt,
    }));
  return [...starting, ...known]
    .sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at)
    .slice(0, limit)
    .map(({ taskRef, title, state }) => ({ taskRef, title, state }));
}

function ok(value: Record<string, unknown>): VoiceToolOutcome {
  return { content: JSON.stringify({ ok: true, ...value }) };
}

function fail(error: string): VoiceToolOutcome {
  return { content: JSON.stringify({ ok: false, error }), isError: true };
}

function failed(error: unknown): VoiceToolOutcome {
  return fail(error instanceof Error ? error.message.slice(0, 200) : "tool_failed");
}

function titleOf(deps: VoiceToolDeps, session: CoreSession): string {
  return deps.titles.get(session.threadRef) || taskTitle(session);
}

async function findTask(deps: VoiceToolDeps, taskRef: string): Promise<CoreSession | null> {
  const sessions = await deps.sessions();
  return sessions.find((session) => session.threadRef === taskRef || session.id === taskRef) ?? null;
}

async function heldTarget(deps: VoiceToolDeps, session: CoreSession): Promise<CoreSession> {
  return heldSubagents(await deps.sessions()).get(session.id) ?? session;
}

async function decide(deps: VoiceToolDeps, taskRef: string, approved: boolean): Promise<VoiceToolOutcome> {
  const session = await findTask(deps, taskRef);
  if (!session?.id) return fail("task_not_found");
  const sessionId = (await heldTarget(deps, session)).id;
  const pending = leadingApproval(await deps.approvals(sessionId));
  if (!pending) return fail("nothing_to_approve");
  const hold = heldOutput(pending, deps.settings().language);
  const title = titleOf(deps, session);
  const activity = (): VoiceActivity | undefined => {
    if (hold) return { kind: approved ? "allowed" : "kept_blocked", title, taskRef: session.threadRef };
    return approved ? { kind: "approved", title, taskRef: session.threadRef } : undefined;
  };
  return {
    ...ok({ taskRef: session.threadRef, awaitingConfirmation: true, ...(hold ? { hold } : {}) }),
    confirm: {
      approved,
      title,
      summary: hold
        ? hold.category
        : (pending.summary ?? pending.purpose ?? pending.command).trim().slice(0, CONFIRM_SUMMARY_CHARS),
      ...(hold ? { hold } : {}),
      async execute() {
        try {
          const current = await deps.approvals(sessionId);
          if (!current.some((approval) => approval.requestId === pending.requestId)) return fail("approval_changed");
          await deps.resolveApproval({
            requestId: pending.requestId,
            approved,
            ...(hold && approved ? { scope: "once" } : {}),
          });
          const done = ok({ taskRef: session.threadRef, approved });
          const did = activity();
          return did ? { ...done, activity: did } : done;
        } catch (error) {
          return failed(error);
        }
      },
    },
  };
}

const SET_VOICE_KEYS = new Set(["voice", "gender", "next"]);

function voiceRequest(
  args: Record<string, unknown>,
): { voice?: string; gender?: (typeof VOICE_GENDERS)[number]; next?: true } | null {
  const keys = Object.keys(args);
  if (keys.length !== 1 || !SET_VOICE_KEYS.has(keys[0]!)) return null;
  if (typeof args.voice === "string") return { voice: args.voice };
  if ((VOICE_GENDERS as readonly unknown[]).includes(args.gender))
    return { gender: args.gender as (typeof VOICE_GENDERS)[number] };
  return args.next === true ? { next: true } : null;
}

async function delivery(
  deps: VoiceToolDeps,
  threadRef: string,
  queuedRunId: string,
  text: string,
  when: "now" | "after_run",
): Promise<"steered" | "queued" | "sent"> {
  const live = await deps.activeRun(threadRef);
  if (!live || live === queuedRunId) return "sent";
  if (when === "after_run") return "queued";
  const outcome = await deps.steer(live, queuedRunId, threadRef, text);
  if (outcome.ok) return "steered";
  return outcome.replayed || outcome.reason === "queued_started" ? "sent" : "queued";
}

export async function runVoiceTool(call: VoiceToolCall, deps: VoiceToolDeps): Promise<VoiceToolOutcome> {
  try {
    switch (call.name) {
      case "delegate_task": {
        const instruction = String(call.args.instruction ?? "").trim();
        if (!instruction) return fail("empty_instruction");
        const title =
          String(call.args.title ?? "")
            .trim()
            .slice(0, 200) || instruction.slice(0, 60);
        const threadRef = voiceThreadRef(deps.user, deps.newId());
        const submit = await deps.startTurn({ text: instruction, threadRef, idempotencyKey: deps.newId() });
        if (!submit.runId && submit.status !== "pending_approval") return fail("not_started");
        deps.delegated(threadRef, title);
        return {
          ...ok({
            taskRef: threadRef,
            title,
            state: submit.status === "pending_approval" ? "awaiting_approval" : "working",
          }),
          activity: { kind: "task_created", title, taskRef: threadRef },
        };
      }
      case "check_tasks":
        return ok({ tasks: taskSummaries(await deps.sessions(), deps.titles, deps.startingTasks()) });
      case "task_result": {
        const session = await findTask(deps, call.args.taskRef);
        if (!session) return fail("task_not_found");
        if (!session.id) return ok({ taskRef: call.args.taskRef, state: "working", result: "" });
        const target = await heldTarget(deps, session);
        const state = target === session ? taskState(session) : "held";
        const [tail, hold] = await Promise.all([
          deps.tail(session.id),
          state === "held"
            ? deps.approvals(target.id).then((list) => heldOutput(leadingApproval(list), deps.settings().language))
            : null,
        ]);
        return ok({
          taskRef: session.threadRef,
          title: deps.titles.get(session.threadRef) || tail.title || taskTitle(session),
          state,
          failed: tail.failed,
          ...resultExcerpt(tail.reply),
          ...(hold ? { hold } : {}),
        });
      }
      case "approve_task":
        return await decide(deps, call.args.taskRef, true);
      case "reject_task":
        return await decide(deps, call.args.taskRef, false);
      case "stop_task": {
        const runId = await deps.activeRun(call.args.taskRef);
        if (!runId) return fail("not_running");
        await deps.abortRun(runId);
        return ok({ taskRef: call.args.taskRef, stopped: true });
      }
      case "send_task_message": {
        const text = String(call.args.text ?? "")
          .trim()
          .slice(0, TASK_MESSAGE_CHARS);
        if (!text) return fail("empty_message");
        const when = call.args.when;
        if (when !== "now" && when !== "after_run") return fail("invalid_when");
        const session = await findTask(deps, call.args.taskRef);
        if (!session) return fail("task_not_found");
        const submit = await deps.startTurn({ text, threadRef: session.threadRef, idempotencyKey: deps.newId() });
        if (submit.status === "pending_approval")
          return fail(taskState(session) === "held" ? "held_by_security" : "awaiting_approval");
        if (!submit.runId) return fail("not_sent");
        const status = submit.steered ? "steered" : await delivery(deps, session.threadRef, submit.runId, text, when);
        return {
          ...ok({ taskRef: session.threadRef, status }),
          activity: { kind: "message_sent", title: titleOf(deps, session), taskRef: session.threadRef },
        };
      }
      case "ask_user":
        return { ...ok({ status: "waiting_for_user" }), ask: true };
      case "open_task": {
        const session = await findTask(deps, call.args.taskRef);
        if (!session) return fail("task_not_found");
        deps.open(session);
        return ok({ taskRef: session.threadRef, opened: true });
      }
      case "set_language": {
        const args = call.args as Record<string, unknown>;
        const language = args.language;
        if (Object.keys(args).length !== 1 || !(VOICE_LANGUAGES as readonly unknown[]).includes(language))
          return fail("invalid_language");
        const saved = await deps.saveSettings({ language: language as VoicePreferences["language"] });
        return ok({ language: saved.language, voice: saved.voice });
      }
      case "set_voice": {
        const want = voiceRequest(call.args as Record<string, unknown>);
        const voice = want ? pickVoice(deps.settings(), want) : null;
        if (!voice) return fail("invalid_voice");
        const saved = await deps.saveSettings({ voice });
        return ok({ voice: saved.voice, label: voiceLabel(saved) });
      }
    }
  } catch (error) {
    return failed(error);
  }
  return fail("unknown_tool");
}
