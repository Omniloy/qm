import { fetchUiState, putUiState } from "../core-bridge.ts";
import {
  ANNOUNCE_SCOPES,
  DEFAULT_VOICE_SETTINGS,
  SUPERTONIC_VOICES,
  TTS_ENGINE_IDS,
  VOICE_LANGUAGES,
  VOICE_MUTED_STORAGE_KEY,
  VOICE_SETTINGS_UI_STATE_KEY,
  type VoiceSettings,
} from "./protocol.ts";

export const WAKE_PHRASE_MAX_CHARS = 60;

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
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_VOICE_SETTINGS.enabled,
    wakePhrase: cleanWakePhrase(raw.wakePhrase) ?? DEFAULT_VOICE_SETTINGS.wakePhrase,
    language: member(VOICE_LANGUAGES, raw.language) ? raw.language : DEFAULT_VOICE_SETTINGS.language,
    announceScope: member(ANNOUNCE_SCOPES, raw.announceScope)
      ? raw.announceScope
      : DEFAULT_VOICE_SETTINGS.announceScope,
    voice: member(SUPERTONIC_VOICES, raw.voice) ? raw.voice : DEFAULT_VOICE_SETTINGS.voice,
    ttsEngine: member(TTS_ENGINE_IDS, raw.ttsEngine) ? raw.ttsEngine : DEFAULT_VOICE_SETTINGS.ttsEngine,
  };
}

export function currentVoiceSettings(): VoiceSettings {
  return current;
}

export function loadVoiceSettings(): Promise<VoiceSettings> {
  loading ??= fetchUiState(VOICE_SETTINGS_UI_STATE_KEY).then(
    (record) => {
      if (record.updatedAt > updatedAt) {
        current = parseVoiceSettings(record.value);
        updatedAt = record.updatedAt;
      }
      return current;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export async function saveVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const previous = current;
  const previousAt = updatedAt;
  current = parseVoiceSettings({ ...current, ...patch });
  updatedAt = Math.max(Date.now(), updatedAt + 1);
  const saved = current;
  for (const listener of listeners) listener(saved);
  try {
    await putUiState(VOICE_SETTINGS_UI_STATE_KEY, saved, updatedAt);
  } catch (error) {
    if (current === saved) {
      current = previous;
      updatedAt = previousAt;
      for (const listener of listeners) listener(previous);
    }
    throw error;
  }
  return saved;
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
