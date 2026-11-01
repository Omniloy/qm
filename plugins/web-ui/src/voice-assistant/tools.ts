import { SUBAGENT_THREAD_PREFIX, type CoreSession, type PendingApproval } from "../core-bridge.ts";
import { VOICE_MAX_RUNNING_TASKS, type VoiceTaskSummary, type VoiceToolCall } from "./protocol.ts";

export interface VoiceToolOutcome {
  content: string;
  isError?: boolean;
}

export interface TaskTail {
  title: string | null;
  reply: string;
  failed: boolean;
}

export interface VoiceToolDeps {
  user: string;
  sessions(): Promise<CoreSession[]>;
  startTurn(body: { text: string; threadRef: string; idempotencyKey: string }): Promise<{
    runId?: string;
    status?: string;
  }>;
  tail(sessionId: string): Promise<TaskTail>;
  approvals(sessionId: string): Promise<PendingApproval[]>;
  resolveApproval(decision: { requestId: string; approved: boolean }): Promise<unknown>;
  activeRun(threadRef: string): Promise<string | null>;
  abortRun(runId: string): Promise<void>;
  open(session: CoreSession): void;
  delegated(threadRef: string, title: string): void;
  newId(): string;
}

const RESULT_CHARS = 2_500;

export function taskState(session: Pick<CoreSession, "working" | "awaitingInput">): VoiceTaskSummary["state"] {
  if (session.awaitingInput) return "awaiting_approval";
  return session.working ? "working" : "idle";
}

export function taskTitle(session: Pick<CoreSession, "title" | "channelName">): string {
  return (session.title ?? session.channelName ?? "").trim().slice(0, 200) || "Untitled";
}

export function taskSummaries(sessions: readonly CoreSession[], limit = VOICE_MAX_RUNNING_TASKS): VoiceTaskSummary[] {
  const rank = { awaiting_approval: 0, working: 1, idle: 2 } as const;
  return sessions
    .filter((session) => !session.archived && !session.threadRef.startsWith(SUBAGENT_THREAD_PREFIX))
    .map((session) => ({ session, state: taskState(session) }))
    .sort(
      (a, b) =>
        rank[a.state] - rank[b.state] ||
        (b.session.lastActivityAt ?? b.session.createdAt) - (a.session.lastActivityAt ?? a.session.createdAt),
    )
    .slice(0, limit)
    .map(({ session, state }) => ({ taskRef: session.threadRef, title: taskTitle(session), state }));
}

function ok(value: Record<string, unknown>): VoiceToolOutcome {
  return { content: JSON.stringify({ ok: true, ...value }) };
}

function fail(error: string): VoiceToolOutcome {
  return { content: JSON.stringify({ ok: false, error }), isError: true };
}

async function findTask(deps: VoiceToolDeps, taskRef: string): Promise<CoreSession | null> {
  const sessions = await deps.sessions();
  return sessions.find((session) => session.threadRef === taskRef || session.id === taskRef) ?? null;
}

async function decide(deps: VoiceToolDeps, taskRef: string, approved: boolean): Promise<VoiceToolOutcome> {
  const session = await findTask(deps, taskRef);
  if (!session?.id) return fail("task_not_found");
  const [pending] = await deps.approvals(session.id);
  if (!pending) return fail("nothing_to_approve");
  await deps.resolveApproval({ requestId: pending.requestId, approved });
  return ok({ taskRef: session.threadRef, approved });
}

export async function runVoiceTool(call: VoiceToolCall, deps: VoiceToolDeps): Promise<VoiceToolOutcome> {
  try {
    switch (call.name) {
      case "delegate_task": {
        const instruction = String(call.args.instruction ?? "").trim();
        if (!instruction) return fail("empty_instruction");
        const title = String(call.args.title ?? "").trim() || instruction.slice(0, 60);
        const threadRef = `web:${deps.user}:${deps.newId()}`;
        const submit = await deps.startTurn({ text: instruction, threadRef, idempotencyKey: deps.newId() });
        if (!submit.runId && submit.status !== "pending_approval") return fail("not_started");
        deps.delegated(threadRef, title);
        return ok({
          taskRef: threadRef,
          title,
          state: submit.status === "pending_approval" ? "awaiting_approval" : "working",
        });
      }
      case "check_tasks":
        return ok({ tasks: taskSummaries(await deps.sessions()) });
      case "task_result": {
        const session = await findTask(deps, call.args.taskRef);
        if (!session) return fail("task_not_found");
        if (!session.id) return ok({ taskRef: call.args.taskRef, state: "working", result: "" });
        const tail = await deps.tail(session.id);
        return ok({
          taskRef: session.threadRef,
          title: tail.title ?? taskTitle(session),
          state: taskState(session),
          failed: tail.failed,
          result: tail.reply.slice(0, RESULT_CHARS),
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
      case "open_task": {
        const session = await findTask(deps, call.args.taskRef);
        if (!session) return fail("task_not_found");
        deps.open(session);
        return ok({ taskRef: session.threadRef, opened: true });
      }
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message.slice(0, 200) : "tool_failed");
  }
  return fail("unknown_tool");
}
