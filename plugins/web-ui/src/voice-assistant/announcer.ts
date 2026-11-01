import { SUBAGENT_THREAD_PREFIX, type CoreSession, type SessionStateEvent } from "../core-bridge.ts";
import {
  VOICE_MAX_CONTENT_CHARS,
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
}

export interface AnnouncerDeps {
  scope(): AnnounceScope;
  language(): VoiceLanguage;
  isVoiceThread(threadRef: string): boolean;
  foregroundThread(): string | null;
  sessions(): Promise<CoreSession[]>;
  tail(sessionId: string): Promise<TaskTail>;
  pendingApproval(sessionId: string): Promise<string>;
  summarize(request: VoiceReplyRequest, signal: AbortSignal): AsyncIterable<VoiceReplyFrame>;
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
  const inFlight = new Set<string>();
  const controller = new AbortController();
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const announce = async (threadRef: string, sessionId: string | undefined, next: TaskState): Promise<void> => {
    const sessions = await deps.sessions();
    const session = sessions.find((s) => s.threadRef === threadRef || (sessionId && s.id === sessionId));
    const id = sessionId ?? session?.id;
    if (!id || disposed) return;
    const tail = await deps.tail(id).catch((): TaskTail => ({ title: null, reply: "", failed: false }));
    let kind: AnnouncementKind = tail.failed ? "failed" : "done";
    if (next === "awaiting_approval") kind = "approval";
    const title = tail.title?.trim() || (session ? taskTitle(session) : "");
    const language = deps.language();
    const detail = kind === "approval" ? await deps.pendingApproval(id).catch(() => "") : tail.reply;
    const text = await collectText(
      deps.summarize(announcePrompt(kind, title, detail, language), controller.signal),
    ).catch(() => "");
    if (disposed) return;
    deps.deliver({ threadRef, kind, title, text: text || fallbackAnnouncement(kind, title, language) });
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
    inFlight.add(key);
    chain = chain
      .then(() => announce(threadRef, sessionId, next))
      .catch(() => undefined)
      .finally(() => inFlight.delete(key));
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
    },
  };
}
