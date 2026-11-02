import { SUBAGENT_THREAD_PREFIX, type CoreSession, type SessionStateEvent } from "../core-bridge.ts";
import {
  VOICE_MAX_CONTENT_CHARS,
  VOICE_MAX_FOLLOWUPS_PER_TASK,
  type AnnounceScope,
  type VoiceLanguage,
  type VoiceReplyFrame,
  type VoiceReplyRequest,
} from "./protocol.ts";
import { withoutClosingPunctuation } from "./text-chunker.ts";
import { taskState, taskTitle, type TaskTail } from "./tools.ts";

type TaskState = ReturnType<typeof taskState>;

export type AnnouncementKind = "done" | "failed" | "approval";

export interface Announcement {
  threadRef: string;
  kind: AnnouncementKind;
  title: string;
  text: string;
  detail: string;
}

export interface TaskUpdate {
  taskRef: string;
  title: string;
  kind: AnnouncementKind;
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
  pendingApproval(sessionId: string): Promise<string>;
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
  dispose(): void;
}

const STATE_LABELS: Record<VoiceLanguage, Record<AnnouncementKind, string>> = {
  es: { done: "terminada", failed: "no se pudo terminar", approval: "espera aprobación" },
  en: { done: "finished", failed: "could not be finished", approval: "awaiting approval" },
};

export function fallbackAnnouncement(kind: AnnouncementKind, task: string, language: VoiceLanguage): string {
  const title = withoutClosingPunctuation(task);
  if (language === "en") {
    if (kind === "approval") return `${title} needs your approval.`;
    return kind === "failed" ? `Could not finish: ${title}.` : `Done: ${title}.`;
  }
  if (kind === "approval") return `${title} necesita tu aprobación.`;
  return kind === "failed" ? `No se pudo terminar: ${title}.` : `Listo: ${title}.`;
}

function announcePrompt(
  kind: AnnouncementKind,
  title: string,
  detail: string,
  language: VoiceLanguage,
): VoiceReplyRequest {
  const head =
    language === "en"
      ? `Task: ${title}\nState: ${STATE_LABELS.en[kind]}\n\n`
      : `Tarea: ${title}\nEstado: ${STATE_LABELS.es[kind]}\n\n`;
  return {
    purpose: "announce",
    language,
    tools: false,
    messages: [{ role: "user", content: (head + detail).slice(0, VOICE_MAX_CONTENT_CHARS) }],
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
    let kind: AnnouncementKind = tail.failed ? "failed" : "done";
    if (next === "awaiting_approval") kind = "approval";
    const title = deps.title?.(threadRef)?.trim() || tail.title?.trim() || (session ? taskTitle(session) : "");
    const language = deps.language();
    const detail = kind === "approval" ? await deps.pendingApproval(id).catch(() => "") : tail.reply;
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
    const blocked = next === "awaiting_approval" && previous !== undefined && previous !== "awaiting_approval";
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

  const seed = (sessions: readonly CoreSession[]) => {
    for (const session of sessions) states.set(session.threadRef, taskState(session));
  };

  return {
    async start() {
      seed(await deps.sessions());
    },
    handle(event) {
      if (event.state === "metadata") return;
      const previous = states.get(event.threadRef);
      states.set(event.threadRef, event.state);
      consider(event.threadRef, event.sessionId, previous, event.state);
    },
    async resync() {
      const sessions = await deps.sessions();
      for (const session of sessions) {
        const previous = states.get(session.threadRef);
        const next = taskState(session);
        states.set(session.threadRef, next);
        if (previous !== next) consider(session.threadRef, session.id || undefined, previous, next);
      }
    },
    settled() {
      return chain;
    },
    dispose() {
      disposed = true;
      controller.abort();
      states.clear();
      followUps.clear();
    },
  };
}
