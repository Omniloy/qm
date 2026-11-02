import { fetchUiState, putUiState, type UiStateRecord } from "../core-bridge.ts";
import {
  ANNOUNCE_SCOPES,
  ASR_ENGINE_IDS,
  DEFAULT_VOICE_ORG_CONFIG,
  DEFAULT_VOICE_PREFERENCES,
  MIC_MODES,
  PTT_STYLES,
  TTS_ENGINE_IDS,
  VOICE_LANGUAGES,
  VOICE_MUTED_STORAGE_KEY,
  VOICE_SETTINGS_UI_STATE_KEY,
  WAKE_PHRASE_MAX_CHARS,
  type AsrEngineId,
  type TtsEngineId,
  type VoiceOrgConfig,
  type VoicePreferences,
  type VoiceSettings,
} from "./protocol.ts";
import { ttsEngineFiles } from "./tts/models.ts";
import { knownVoice, supportedVoice } from "./voices.ts";

const SAVE_ATTEMPTS = 3;

type Listener = (preferences: VoicePreferences) => void;

let current: VoicePreferences = { ...DEFAULT_VOICE_PREFERENCES };
let updatedAt = 0;
let loading: Promise<VoicePreferences> | null = null;
let saving: Promise<unknown> = Promise.resolve();
const listeners = new Set<Listener>();

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanWakePhrase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phrase = value.replace(/\s+/g, " ").trim();
  return phrase && phrase.length <= WAKE_PHRASE_MAX_CHARS ? phrase : null;
}

export function parseVoicePreferences(value: unknown): VoicePreferences {
  const raw = record(value);
  const language = member(VOICE_LANGUAGES, raw.language) ? raw.language : DEFAULT_VOICE_PREFERENCES.language;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_VOICE_PREFERENCES.enabled,
    language,
    voice: knownVoice(language, raw.voice)
      ? raw.voice
      : supportedVoice(DEFAULT_VOICE_ORG_CONFIG.ttsEngine, language, raw.voice ?? DEFAULT_VOICE_PREFERENCES.voice),
    micMode: member(MIC_MODES, raw.micMode) ? raw.micMode : DEFAULT_VOICE_PREFERENCES.micMode,
  };
}

export function parseVoiceOrgConfig(value: unknown): VoiceOrgConfig {
  const raw = record(value);
  return {
    ttsEngine: member(TTS_ENGINE_IDS, raw.ttsEngine) ? raw.ttsEngine : DEFAULT_VOICE_ORG_CONFIG.ttsEngine,
    asrEngine: member(ASR_ENGINE_IDS, raw.asrEngine) ? raw.asrEngine : DEFAULT_VOICE_ORG_CONFIG.asrEngine,
    wakePhrase: cleanWakePhrase(raw.wakePhrase) ?? DEFAULT_VOICE_ORG_CONFIG.wakePhrase,
    pttStyle: member(PTT_STYLES, raw.pttStyle) ? raw.pttStyle : DEFAULT_VOICE_ORG_CONFIG.pttStyle,
    announceScope: member(ANNOUNCE_SCOPES, raw.announceScope)
      ? raw.announceScope
      : DEFAULT_VOICE_ORG_CONFIG.announceScope,
  };
}

export const FALLBACK_ASR_ENGINE: AsrEngineId = "qwen3-asr-0.6b";
export const FALLBACK_TTS_ENGINE: TtsEngineId = "supertonic-3";

export function runnableVoiceSettings(
  settings: VoiceSettings,
  gatedModels: boolean,
  failed: ReadonlySet<AsrEngineId | TtsEngineId> = new Set(),
): VoiceSettings {
  const asrEngine = failed.has(settings.asrEngine) ? FALLBACK_ASR_ENGINE : settings.asrEngine;
  const gated = !gatedModels && ttsEngineFiles(settings.ttsEngine).some((file) => file.gated);
  const ttsEngine = gated || failed.has(settings.ttsEngine) ? FALLBACK_TTS_ENGINE : settings.ttsEngine;
  const voice = supportedVoice(ttsEngine, settings.language, settings.voice);
  if (asrEngine === settings.asrEngine && ttsEngine === settings.ttsEngine && voice === settings.voice) return settings;
  return { ...settings, asrEngine, ttsEngine, voice };
}

export function currentVoicePreferences(): VoicePreferences {
  return current;
}

function adopt(stored: UiStateRecord): VoicePreferences {
  if (stored.updatedAt > updatedAt) {
    current = parseVoicePreferences(stored.value);
    updatedAt = stored.updatedAt;
  }
  return current;
}

export function loadVoicePreferences(): Promise<VoicePreferences> {
  loading ??= fetchUiState(VOICE_SETTINGS_UI_STATE_KEY).then(adopt, (error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function saveVoiceSettings(
  patch: Partial<VoicePreferences>,
  prepare?: (next: VoicePreferences) => Promise<void>,
): Promise<VoicePreferences> {
  const saved = saving.then(async () => {
    await prepare?.(parseVoicePreferences({ ...current, ...patch }));
    return writeVoicePreferences(patch);
  });
  saving = saved.catch(() => undefined);
  return saved;
}

async function writeVoicePreferences(patch: Partial<VoicePreferences>): Promise<VoicePreferences> {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const next = parseVoicePreferences({ ...adopt(await fetchUiState(VOICE_SETTINGS_UI_STATE_KEY)), ...patch });
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
  current = { ...DEFAULT_VOICE_PREFERENCES };
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
