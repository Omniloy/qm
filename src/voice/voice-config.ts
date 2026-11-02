const VOICE_TTS_ENGINES = ["phonon-40m", "supertonic-3"] as const;
const VOICE_ASR_ENGINES = ["phonon-2.5", "qwen3-asr-0.6b"] as const;
const VOICE_PTT_STYLES = ["hold", "toggle"] as const;
const VOICE_ANNOUNCE_SCOPES = ["all", "voice"] as const;
export const VOICE_WAKE_PHRASE_MAX_CHARS = 60;

export interface VoiceOrgConfig {
  ttsEngine: (typeof VOICE_TTS_ENGINES)[number];
  asrEngine: (typeof VOICE_ASR_ENGINES)[number];
  wakePhrase: string;
  pttStyle: (typeof VOICE_PTT_STYLES)[number];
  announceScope: (typeof VOICE_ANNOUNCE_SCOPES)[number];
}

export const DEFAULT_VOICE_ORG_CONFIG: VoiceOrgConfig = {
  ttsEngine: "phonon-40m",
  asrEngine: "phonon-2.5",
  wakePhrase: "Oye Omni",
  pttStyle: "hold",
  announceScope: "all",
};

const ENUM_FIELDS = {
  ttsEngine: VOICE_TTS_ENGINES,
  asrEngine: VOICE_ASR_ENGINES,
  pttStyle: VOICE_PTT_STYLES,
  announceScope: VOICE_ANNOUNCE_SCOPES,
} as const;

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

function cleanWakePhrase(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phrase = value.trim().replace(/\s+/g, " ");
  return phrase && phrase.length <= VOICE_WAKE_PHRASE_MAX_CHARS ? phrase : null;
}

export function parseVoiceOrgConfig(body: unknown): { value: VoiceOrgConfig } | { error: string } {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const [field, values] of Object.entries(ENUM_FIELDS)) {
    if (!oneOf(values, raw[field])) return { error: `voice-assistant ${field} must be one of ${values.join(", ")}` };
  }
  const wakePhrase = cleanWakePhrase(raw.wakePhrase);
  if (!wakePhrase) {
    return { error: `voice-assistant wakePhrase must be 1-${VOICE_WAKE_PHRASE_MAX_CHARS} characters` };
  }
  return {
    value: {
      ttsEngine: raw.ttsEngine as VoiceOrgConfig["ttsEngine"],
      asrEngine: raw.asrEngine as VoiceOrgConfig["asrEngine"],
      wakePhrase,
      pttStyle: raw.pttStyle as VoiceOrgConfig["pttStyle"],
      announceScope: raw.announceScope as VoiceOrgConfig["announceScope"],
    },
  };
}

export function resolveVoiceOrgConfig(stored: Partial<VoiceOrgConfig> | null | undefined): VoiceOrgConfig {
  const pick = <K extends keyof typeof ENUM_FIELDS>(field: K): VoiceOrgConfig[K] => {
    const value = stored?.[field];
    return (oneOf(ENUM_FIELDS[field], value) ? value : DEFAULT_VOICE_ORG_CONFIG[field]) as VoiceOrgConfig[K];
  };
  return {
    ttsEngine: pick("ttsEngine"),
    asrEngine: pick("asrEngine"),
    wakePhrase: cleanWakePhrase(stored?.wakePhrase) ?? DEFAULT_VOICE_ORG_CONFIG.wakePhrase,
    pttStyle: pick("pttStyle"),
    announceScope: pick("announceScope"),
  };
}
