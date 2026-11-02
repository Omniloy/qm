import type { App } from "../api/app-types.ts";
import { entrySecurityTainted, isHiddenEntry, isOverheardEntry } from "../sessions/session-store.ts";
import type { Session, SessionEntry } from "../types.ts";
import type { VoiceActivity } from "./voice-transcript.ts";

export const VOICE_CONVERSATIONS_MAX = 10;
const READ_TAIL_TURNS = 6;
const READ_MAX_CHARS = 3_000;
const MESSAGE_MAX_CHARS = 600;
const TITLE_MAX_CHARS = 120;

type ConversationReader = Pick<App, "listSessions" | "getSessionForViewer">;

export interface VoiceToolResult {
  content: string;
  isError?: true;
  conversations?: string[];
  activity?: VoiceActivity;
}

export function voiceUsageThread(principalId: string): string {
  return `voice:${principalId}`;
}

const clipped = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const conversationTitle = (session: Pick<Session, "title" | "channelName">): string =>
  clipped((session.title ?? session.channelName ?? "").trim(), TITLE_MAX_CHARS);

const conversationState = (session: Session): "working" | "awaiting_input" | "idle" => {
  if (session.awaitingInput) return "awaiting_input";
  return session.working ? "working" : "idle";
};

const activity = (session: Session): number => session.lastActivityAt ?? session.createdAt;

function failure(error: string): VoiceToolResult {
  return { content: JSON.stringify({ ok: false, error }), isError: true };
}

function conversationLimit(value: unknown): number | null {
  if (value === undefined) return VOICE_CONVERSATIONS_MAX;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= VOICE_CONVERSATIONS_MAX
    ? (value as number)
    : null;
}

export async function recentConversations(
  app: ConversationReader,
  principalId: string,
  args: Record<string, unknown>,
): Promise<VoiceToolResult> {
  const limit = conversationLimit(args.limit);
  if (limit === null) return failure(`limit must be an integer from 1 to ${VOICE_CONVERSATIONS_MAX}`);
  const usage = voiceUsageThread(principalId);
  const conversations = (await app.listSessions(principalId))
    .filter((session) => !session.archived && !session.parentSessionId && session.threadRef !== usage)
    .sort((a, b) => activity(b) - activity(a))
    .slice(0, limit)
    .map((session) => ({
      conversation: session.id,
      title: conversationTitle(session),
      lastActivity: new Date(activity(session)).toISOString(),
      state: conversationState(session),
    }));
  return { content: JSON.stringify({ ok: true, conversations }) };
}

interface ReadMessage {
  role: "user" | "assistant";
  author?: string;
  text: string;
}

function spokenEntry(entry: SessionEntry): ReadMessage | null {
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  if (entrySecurityTainted(entry) || isOverheardEntry(entry) || isHiddenEntry(entry)) return null;
  const payload = entry.payload as { text?: unknown; name?: unknown } | null;
  const text = payload?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  const author = entry.type === "user" && typeof payload?.name === "string" ? payload.name.trim() : "";
  return { role: entry.type, ...(author ? { author } : {}), text: clipped(text.trim(), MESSAGE_MAX_CHARS) };
}

export async function readConversation(
  app: ConversationReader,
  principalId: string,
  args: Record<string, unknown>,
): Promise<VoiceToolResult> {
  const id = typeof args.conversation === "string" ? args.conversation.trim() : "";
  if (!id) return failure("conversation must be an id from recent_conversations");
  const found = await app.getSessionForViewer(id, principalId, { tailTurns: READ_TAIL_TURNS });
  if (!found || found.session.threadRef === voiceUsageThread(principalId)) return failure("conversation_not_found");
  const kept: ReadMessage[] = [];
  let used = 0;
  const messages = found.entries.flatMap((entry) => spokenEntry(entry) ?? []);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (used + message.text.length > READ_MAX_CHARS) break;
    used += message.text.length;
    kept.unshift(message);
  }
  return {
    content: JSON.stringify({
      ok: true,
      conversation: found.session.id,
      title: conversationTitle(found.session),
      earlier: kept.length < messages.length || (found.earlierEntries ?? 0) > 0,
      messages: kept,
    }),
    conversations: [found.session.id],
  };
}
