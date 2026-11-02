import { randomUUID } from "node:crypto";
import { requireAtomic, type DurableMap } from "../persistence/durable-map.ts";

export const VOICE_TRANSCRIPT_MAX_ENTRIES = 100;
const VOICE_MAX_ACTIVITY = 8;
const ACTIVITY_TITLE_MAX_CHARS = 200;
const ACTIVITY_REF_MAX_CHARS = 300;
const ACTIVITY_MAX_COUNT = 100;

const VOICE_ACTIVITY_KINDS = [
  "task_created",
  "message_sent",
  "conversations_read",
  "memory_saved",
  "memory_compacted",
  "approved",
] as const;
type VoiceActivityKind = (typeof VOICE_ACTIVITY_KINDS)[number];

export interface VoiceActivity {
  kind: VoiceActivityKind;
  title?: string;
  taskRef?: string;
  count?: number;
}

export interface VoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  activity?: VoiceActivity[];
}

export interface VoiceTranscript {
  principalId: string;
  entries: VoiceTranscriptEntry[];
}

export type VoiceTranscriptNote = Pick<VoiceTranscriptEntry, "role" | "text" | "activity">;

const boundedText = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
};

function parseActivityItem(value: unknown): VoiceActivity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = VOICE_ACTIVITY_KINDS.find((known) => known === raw.kind);
  const title = boundedText(raw.title, ACTIVITY_TITLE_MAX_CHARS);
  const taskRef = boundedText(raw.taskRef, ACTIVITY_REF_MAX_CHARS);
  const count = raw.count;
  const countOk =
    count === undefined ||
    (Number.isInteger(count) && (count as number) >= 1 && (count as number) <= ACTIVITY_MAX_COUNT);
  if (!kind || title === null || taskRef === null || !countOk) return null;
  return {
    kind,
    ...(title ? { title } : {}),
    ...(taskRef ? { taskRef } : {}),
    ...(count !== undefined ? { count: count as number } : {}),
  };
}

export function parseVoiceActivity(value: unknown): VoiceActivity[] | null {
  if (!Array.isArray(value) || !value.length || value.length > VOICE_MAX_ACTIVITY) return null;
  const items = value.map(parseActivityItem);
  return items.every((item): item is VoiceActivity => item !== null) ? items : null;
}

const sameActivity = (a: VoiceActivity, b: VoiceActivity): boolean =>
  a.kind === b.kind && (a.kind === "conversations_read" || (a.taskRef === b.taskRef && a.title === b.title));

function mergeVoiceActivity(current: readonly VoiceActivity[], added: readonly VoiceActivity[]): VoiceActivity[] {
  let merged = [...current];
  for (const item of added) merged = [...merged.filter((known) => !sameActivity(known, item)), item];
  return merged.slice(-VOICE_MAX_ACTIVITY);
}

export async function appendVoiceTranscript(
  store: DurableMap<VoiceTranscript>,
  principalId: string,
  entry: VoiceTranscriptNote,
): Promise<VoiceTranscriptEntry> {
  const saved: VoiceTranscriptEntry = {
    id: randomUUID(),
    role: entry.role,
    text: entry.text,
    at: Date.now(),
    ...(entry.activity?.length ? { activity: mergeVoiceActivity([], entry.activity) } : {}),
  };
  const atomic = requireAtomic(store);
  await atomic.putIfAbsent(principalId, { principalId, entries: [] });
  await atomic.update(principalId, (current) => ({
    principalId,
    entries: [...current.entries, saved].slice(-VOICE_TRANSCRIPT_MAX_ENTRIES),
  }));
  return saved;
}

export async function addVoiceActivity(
  store: DurableMap<VoiceTranscript>,
  principalId: string,
  entryId: string,
  added: readonly VoiceActivity[],
): Promise<VoiceTranscriptEntry | null> {
  const result: { entry: VoiceTranscriptEntry | null } = { entry: null };
  await requireAtomic(store).update(principalId, (current) => ({
    principalId,
    entries: current.entries.map((entry) => {
      if (entry.id !== entryId || entry.role !== "assistant") return entry;
      result.entry = { ...entry, activity: mergeVoiceActivity(entry.activity ?? [], added) };
      return result.entry;
    }),
  }));
  return result.entry;
}
