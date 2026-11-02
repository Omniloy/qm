import { webFetch, withBase } from "../core-bridge.ts";
import type { VoiceReplyErrorReason, VoiceReplyFrame, VoiceReplyRequest } from "./protocol.ts";

const FRAME_TYPES = new Set(["delta", "tool_call", "done", "error"]);

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
    const frame = JSON.parse(data) as { type?: unknown };
    return frame && typeof frame.type === "string" && FRAME_TYPES.has(frame.type) ? (frame as VoiceReplyFrame) : null;
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
