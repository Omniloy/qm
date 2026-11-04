import {
  SUBAGENT_THREAD_PREFIX,
  type CoreSession,
  type PendingApproval,
  type SessionStateEvent,
} from "../core-bridge.ts";
import {
  VOICE_MAX_CONTENT_CHARS,
  VOICE_MAX_FOLLOWUPS_PER_TASK,
  type AnnounceScope,
  type VoiceLanguage,
  type VoiceReplyFrame,
  type VoiceReplyRequest,
  resultExcerpt,
} from "./protocol.ts";
import { withoutClosingPunctuation } from "./text-chunker.ts";
import { heldOutput, heldSubagents, taskState, taskTitle, type HeldOutput, type TaskTail } from "./tools.ts";

type TaskState = ReturnType<typeof taskState>;

export type AnnouncementKind = "done" | "failed" | "approval" | "held";

export interface Announcement {
  threadRef: string;
  kind: AnnouncementKind;
  title: string;
  text: string;
  detail: string;
  written?: string;
}

export interface TaskUpdate {
  taskRef: string;
  title: string;
  kind: ReviewedKind;
  detail: string;
}

export type ReviewOutcome = "done" | "interrupted" | "unheard";

export interface AnnouncerDeps {
  scope(): AnnounceScope;
  language(): VoiceLanguage;
  isVoiceThread(threadRef: string): boolean;
  foregroundThread(): string | null;
  sessions(): Promise<CoreSession[]>;
  tail(sessionId: string): Promise<TaskTail>;
  pendingApproval(sessionId: string): Promise<PendingApproval | undefined>;
  summarize(request: VoiceReplyRequest, signal: AbortSignal): AsyncIterable<VoiceReplyFrame>;
  review(update: TaskUpdate): Promise<ReviewOutcome>;
  title?(threadRef: string): string | undefined;
  deliver(announcement: Announcement): void;
}

export interface Announcer {
  start(): Promise<void>;
  handle(event: SessionStateEvent): void;
  resync(): Promise<void>;
  settled(): Promise<void>;
  states(): ReadonlyMap<string, TaskState>;
  dispose(): void;
}

type ReviewedKind = Exclude<AnnouncementKind, "held">;

const STATE_LABELS: Record<VoiceLanguage, Record<ReviewedKind, string>> = {
  es: { done: "terminada", failed: "no se pudo terminar", approval: "espera aprobación" },
  en: { done: "finished", failed: "could not be finished", approval: "awaiting approval" },
};

export function fallbackAnnouncement(kind: AnnouncementKind, task: string, language: VoiceLanguage): string {
  const title = withoutClosingPunctuation(task);
  if (language === "en") {
    if (kind === "held")
      return `The task “${title}” is paused: the security screen held back a result. Open it to decide, or tell me to continue.`;
    if (kind === "approval") return `${title} needs your approval.`;
    return kind === "failed" ? `Could not finish: ${title}.` : `Done: ${title}.`;
  }
  if (kind === "held")
    return `La tarea «${title}» está en pausa: el control de seguridad retuvo un resultado. Ábrela para decidir, o dime que continúe.`;
  if (kind === "approval") return `${title} necesita tu aprobación.`;
  return kind === "failed" ? `No se pudo terminar: ${title}.` : `Listo: ${title}.`;
}

function heldNote(task: string, hold: HeldOutput | null, language: VoiceLanguage): string {
  const title = withoutClosingPunctuation(task);
  if (language === "en")
    return [
      `**Held by security:** ${title}`,
      hold
        ? `The security screen held back ${hold.source} (${hold.category}).`
        : "The security screen held back a result.",
      "Open the task to decide, or tell me to continue or to keep it blocked.",
    ].join("\n\n");
  return [
    `**Retenido por seguridad:** ${title}`,
    hold
      ? `El control de seguridad retuvo un resultado (${hold.category}).`
      : "El control de seguridad retuvo un resultado.",
    "Abre la tarea para decidir, o dime que continúe o que lo mantenga bloqueado.",
  ].join("\n\n");
}

function heldState(event: Pick<SessionStateEvent, "state" | "securityHeld">): TaskState | "metadata" {
  return event.state === "awaiting_approval" && event.securityHeld ? "held" : event.state;
}

function announcePrompt(kind: ReviewedKind, title: string, detail: string, language: VoiceLanguage): VoiceReplyRequest {
  const head =
    language === "en"
      ? `Task: ${title}\nState: ${STATE_LABELS.en[kind]}\n\n`
      : `Tarea: ${title}\nEstado: ${STATE_LABELS.es[kind]}\n\n`;
  return {
    purpose: "announce",
    language,
    tools: false,
    messages: [{ role: "user", content: (head + resultExcerpt(detail).result).slice(0, VOICE_MAX_CONTENT_CHARS) }],
  };
}

async function collectText(frames: AsyncIterable<VoiceReplyFrame>): Promise<string> {
  let text = "";
  for await (const frame of frames) {
    if (frame.type === "delta") text += frame.text;
    else if (frame.type === "error") throw new Error(frame.reason);
    else if (frame.type === "done") break;
  }
  return text.replace(/\s+/g, " ").trim();
}

export function createAnnouncer(deps: AnnouncerDeps): Announcer {
  const states = new Map<string, TaskState>();
  const inFlight = new Map<string, object>();
  const followUps = new Map<string, number>();
  const controller = new AbortController();
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const announce = async (
    threadRef: string,
    sessionId: string | undefined,
    next: TaskState,
    release: () => void,
  ): Promise<void> => {
    const sessions = await deps.sessions();
    const session = sessions.find((s) => s.threadRef === threadRef || (sessionId && s.id === sessionId));
    const id = sessionId ?? session?.id;
    if (!id || disposed) return;
    const tail = await deps.tail(id).catch((): TaskTail => ({ title: null, reply: "", failed: false }));
    const title = deps.title?.(threadRef)?.trim() || tail.title?.trim() || (session ? taskTitle(session) : "");
    const language = deps.language();
    const below = heldSubagents(sessions).get(id);
    const pending =
      next === "awaiting_approval" || next === "held" || below
        ? await deps.pendingApproval(below?.id ?? id).catch(() => undefined)
        : undefined;
    const hold = heldOutput(pending, language);
    if (next === "held" || below || hold) {
      followUps.set(threadRef, VOICE_MAX_FOLLOWUPS_PER_TASK);
      release();
      if (disposed) return;
      deps.deliver({
        threadRef,
        kind: "held",
        title,
        text: fallbackAnnouncement("held", title, language),
        detail: "",
        written: heldNote(title, hold, language),
      });
      return;
    }
    let kind: ReviewedKind = tail.failed ? "failed" : "done";
    if (next === "awaiting_approval") kind = "approval";
    const asked = pending ? (pending.summary ?? pending.purpose ?? pending.command) : "";
    const detail = kind === "approval" ? asked : tail.reply;
    release();
    const reviewed = followUps.get(threadRef) ?? 0;
    if (reviewed < VOICE_MAX_FOLLOWUPS_PER_TASK) {
      followUps.set(threadRef, reviewed + 1);
      const outcome = await deps.review({ taskRef: threadRef, title, kind, detail }).catch(() => null);
      if (outcome === "interrupted" || outcome === "unheard") followUps.set(threadRef, VOICE_MAX_FOLLOWUPS_PER_TASK);
      if (outcome === "done" || outcome === "interrupted" || disposed) return;
    }
    const text = await collectText(
      deps.summarize(announcePrompt(kind, title, detail, language), controller.signal),
    ).catch(() => "");
    if (disposed) return;
    deps.deliver({ threadRef, kind, title, text: text || fallbackAnnouncement(kind, title, language), detail });
  };

  const consider = (
    threadRef: string,
    sessionId: string | undefined,
    previous: TaskState | undefined,
    next: TaskState,
  ) => {
    if (disposed || threadRef.startsWith(SUBAGENT_THREAD_PREFIX)) return;
    const finished = previous === "working" && next === "idle";
    const blocked = (next === "awaiting_approval" || next === "held") && previous !== undefined && previous !== next;
    if (!finished && !blocked) return;
    if (deps.scope() === "voice" && !deps.isVoiceThread(threadRef)) return;
    if (deps.foregroundThread() === threadRef) return;
    const key = `${threadRef}:${next}`;
    if (inFlight.has(key)) return;
    const token = {};
    inFlight.set(key, token);
    const release = () => {
      if (inFlight.get(key) === token) inFlight.delete(key);
    };
    chain = chain
      .then(() => announce(threadRef, sessionId, next, release))
      .catch(() => undefined)
      .finally(release);
  };

  const track = (threadRef: string, next: TaskState) => {
    states.set(threadRef, next);
    if (next === "held") followUps.set(threadRef, VOICE_MAX_FOLLOWUPS_PER_TASK);
  };

  const seed = (sessions: readonly CoreSession[]) => {
    for (const session of sessions) track(session.threadRef, taskState(session));
  };

  return {
    async start() {
      seed(await deps.sessions());
    },
    handle(event) {
      const next = heldState(event);
      if (next === "metadata") return;
      const previous = states.get(event.threadRef);
      track(event.threadRef, next);
      consider(event.threadRef, event.sessionId, previous, next);
    },
    async resync() {
      const sessions = await deps.sessions();
      for (const session of sessions) {
        const previous = states.get(session.threadRef);
        const next = taskState(session);
        track(session.threadRef, next);
        if (previous !== next) consider(session.threadRef, session.id || undefined, previous, next);
      }
    },
    settled() {
      return chain;
    },
    states() {
      return states;
    },
    dispose() {
      disposed = true;
      controller.abort();
      states.clear();
      followUps.clear();
    },
  };
}
