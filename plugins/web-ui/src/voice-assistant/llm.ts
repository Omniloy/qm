import { webFetch, withBase } from "../core-bridge.ts";
import {
  VOICE_ACTIVITY_KINDS,
  VOICE_MAX_ACTIVITY,
  type VoiceActivity,
  type VoiceReplyErrorReason,
  type VoiceReplyFrame,
  type VoiceReplyRequest,
  type VoiceTranscriptEntry,
} from "./protocol.ts";

const FRAME_TYPES = new Set(["delta", "text_end", "tool_call", "written", "activity", "done", "error"]);

export class VoiceReplyError extends Error {
  readonly reason: VoiceReplyErrorReason;
  readonly status: number;

  constructor(reason: VoiceReplyErrorReason, status = 0) {
    super(reason);
    this.name = "VoiceReplyError";
    this.reason = reason;
    this.status = status;
  }
}

const KNOWN_REASONS: ReadonlySet<string> = new Set<VoiceReplyErrorReason>([
  "feature_disabled",
  "voice_model_unsupported",
  "invalid_request",
  "over_budget",
  "rate_limited",
  "upstream_error",
  "aborted",
]);

function reasonOf(value: unknown): VoiceReplyErrorReason {
  return typeof value === "string" && KNOWN_REASONS.has(value) ? (value as VoiceReplyErrorReason) : "upstream_error";
}

export function parseSseEvent(block: string): VoiceReplyFrame | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return null;
  try {
    const frame = JSON.parse(data) as { type?: unknown; activity?: unknown };
    if (!frame || typeof frame.type !== "string" || !FRAME_TYPES.has(frame.type)) return null;
    if (frame.type !== "activity") return frame as VoiceReplyFrame;
    const activity = parseVoiceActivity(frame.activity);
    return activity ? { type: "activity", activity } : null;
  } catch {
    return null;
  }
}

async function* readVoiceReply(body: ReadableStream<Uint8Array>): AsyncGenerator<VoiceReplyFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (blocks.pop() ?? "");
      for (const block of blocks) {
        const frame = parseSseEvent(block);
        if (!frame) continue;
        yield frame;
        if (frame.type === "done" || frame.type === "error") return;
      }
      if (done) throw new VoiceReplyError("upstream_error");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function* streamVoiceReply(
  request: VoiceReplyRequest,
  signal: AbortSignal,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = webFetch,
): AsyncGenerator<VoiceReplyFrame> {
  const response = await fetcher(withBase("/api/voice/reply"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new VoiceReplyError(reasonOf(body?.error), response.status);
  }
  yield* readVoiceReply(response.body);
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function parseVoiceActivity(value: unknown): VoiceActivity | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const kind = VOICE_ACTIVITY_KINDS.find((known) => known === raw.kind);
  if (!kind) return null;
  const title = optionalText(raw.title);
  const taskRef = optionalText(raw.taskRef);
  const count = Number.isInteger(raw.count) && (raw.count as number) > 0 ? (raw.count as number) : undefined;
  return { kind, ...(title ? { title } : {}), ...(taskRef ? { taskRef } : {}), ...(count ? { count } : {}) };
}

export function parseVoiceTranscript(value: unknown): VoiceTranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    const entry = raw as (Partial<VoiceTranscriptEntry> & { activity?: unknown }) | null;
    if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string") return [];
    if (entry.role !== "user" && entry.role !== "assistant") return [];
    const activity = Array.isArray(entry.activity)
      ? entry.activity.flatMap((item: unknown) => parseVoiceActivity(item) ?? []).slice(0, VOICE_MAX_ACTIVITY)
      : [];
    return [
      {
        id: entry.id,
        role: entry.role,
        text: entry.text,
        at: typeof entry.at === "number" ? entry.at : 0,
        ...(activity.length ? { activity } : {}),
      },
    ];
  });
}
