import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";

export const VOICE_TRANSCRIPT_MAX_ENTRIES = 100;

export interface VoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface VoiceTranscript {
  principalId: string;
  entries: VoiceTranscriptEntry[];
}

const appendQueue = createKeyedQueue();

export function appendVoiceTranscript(
  store: DurableMap<VoiceTranscript>,
  principalId: string,
  entry: Pick<VoiceTranscriptEntry, "role" | "text">,
): Promise<VoiceTranscriptEntry> {
  return appendQueue(principalId, async () => {
    const saved: VoiceTranscriptEntry = { id: randomUUID(), role: entry.role, text: entry.text, at: Date.now() };
    const entries = [...((await store.get(principalId))?.entries ?? []), saved].slice(-VOICE_TRANSCRIPT_MAX_ENTRIES);
    await store.put(principalId, { principalId, entries });
    return saved;
  });
}
