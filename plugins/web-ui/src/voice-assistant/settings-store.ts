import { fetchUiState, putUiState, type UiStateRecord } from "../core-bridge.ts";
import {
  ANNOUNCE_SCOPES,
  DEFAULT_VOICE_SETTINGS,
  TTS_ENGINE_IDS,
  VOICE_LANGUAGES,
  VOICE_MUTED_STORAGE_KEY,
  VOICE_SETTINGS_UI_STATE_KEY,
  type VoiceSettings,
} from "./protocol.ts";
import { supportedVoice } from "./voices.ts";

export const WAKE_PHRASE_MAX_CHARS = 60;
const SAVE_ATTEMPTS = 3;

type Listener = (settings: VoiceSettings) => void;

let current: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };
let updatedAt = 0;
let loading: Promise<VoiceSettings> | null = null;
const listeners = new Set<Listener>();

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function cleanWakePhrase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phrase = value.replace(/\s+/g, " ").trim();
  return phrase && phrase.length <= WAKE_PHRASE_MAX_CHARS ? phrase : null;
}

export function parseVoiceSettings(value: unknown): VoiceSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const language = member(VOICE_LANGUAGES, raw.language) ? raw.language : DEFAULT_VOICE_SETTINGS.language;
  const ttsEngine = member(TTS_ENGINE_IDS, raw.ttsEngine) ? raw.ttsEngine : DEFAULT_VOICE_SETTINGS.ttsEngine;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_VOICE_SETTINGS.enabled,
    wakePhrase: cleanWakePhrase(raw.wakePhrase) ?? DEFAULT_VOICE_SETTINGS.wakePhrase,
    language,
    announceScope: member(ANNOUNCE_SCOPES, raw.announceScope)
      ? raw.announceScope
      : DEFAULT_VOICE_SETTINGS.announceScope,
    voice: supportedVoice(ttsEngine, language, raw.voice ?? DEFAULT_VOICE_SETTINGS.voice),
    ttsEngine,
  };
}

export function currentVoiceSettings(): VoiceSettings {
  return current;
}

function adopt(record: UiStateRecord): VoiceSettings {
  if (record.updatedAt > updatedAt) {
    current = parseVoiceSettings(record.value);
    updatedAt = record.updatedAt;
  }
  return current;
}

export function loadVoiceSettings(): Promise<VoiceSettings> {
  loading ??= fetchUiState(VOICE_SETTINGS_UI_STATE_KEY).then(adopt, (error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export async function saveVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const next = parseVoiceSettings({ ...adopt(await fetchUiState(VOICE_SETTINGS_UI_STATE_KEY)), ...patch });
    const at = Math.max(Date.now(), updatedAt + 1);
    const result = (await putUiState(VOICE_SETTINGS_UI_STATE_KEY, next, at)) as { ok?: unknown } | null;
    if (result?.ok === false) continue;
    current = next;
    updatedAt = at;
    for (const listener of listeners) listener(next);
    return next;
  }
  throw new Error("voice_settings_conflict");
}

export function onVoiceSettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetVoiceSettings(): void {
  current = { ...DEFAULT_VOICE_SETTINGS };
  updatedAt = 0;
  loading = null;
}

export function storedVoiceMuted(): boolean {
  try {
    return localStorage.getItem(VOICE_MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeVoiceMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(VOICE_MUTED_STORAGE_KEY, "1");
    else localStorage.removeItem(VOICE_MUTED_STORAGE_KEY);
  } catch {
    void 0;
  }
}
