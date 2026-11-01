import {
  VOICE_LANGUAGES,
  type TtsEngineId,
  type TtsVoice,
  type VoiceChoice,
  type VoiceGender,
  type VoiceLanguage,
  type VoiceSettings,
} from "./protocol.ts";

const GENDER_WORDS: Record<VoiceGender, Record<VoiceLanguage, string>> = {
  female: { es: "femenina", en: "Female" },
  male: { es: "masculina", en: "Male" },
};

function presetVoice(gender: VoiceGender, number: number): TtsVoice {
  return {
    id: `${gender === "female" ? "F" : "M"}${number}`,
    gender,
    languages: VOICE_LANGUAGES,
    labels: { es: `Voz ${GENDER_WORDS[gender].es} ${number}`, en: `${GENDER_WORDS[gender].en} ${number}` },
  };
}

const PRESET_NUMBERS = [1, 2, 3, 4, 5] as const;

export const SUPERTONIC_VOICES: readonly TtsVoice[] = [
  ...PRESET_NUMBERS.map((n) => presetVoice("female", n)),
  ...PRESET_NUMBERS.map((n) => presetVoice("male", n)),
];

const ENGINE_VOICES: Readonly<Record<TtsEngineId, readonly TtsVoice[]>> = { "supertonic-3": SUPERTONIC_VOICES };

function voicesFor(engine: TtsEngineId, language: VoiceLanguage): TtsVoice[] {
  return ENGINE_VOICES[engine].filter((voice) => voice.languages.includes(language));
}

export function supportedVoice(engine: TtsEngineId, language: VoiceLanguage, voice: unknown): string {
  const voices = voicesFor(engine, language);
  if (voices.some((option) => option.id === voice)) return voice as string;
  const gender = ENGINE_VOICES[engine].find((option) => option.id === voice)?.gender;
  return (voices.find((option) => option.gender === gender) ?? voices[0])?.id ?? "";
}

export function voiceChoices(settings: Pick<VoiceSettings, "ttsEngine" | "language">): VoiceChoice[] {
  return voicesFor(settings.ttsEngine, settings.language).map((voice) => ({
    id: voice.id,
    label: voice.labels[settings.language],
    gender: voice.gender,
  }));
}

export function voiceLabel(settings: Pick<VoiceSettings, "ttsEngine" | "language" | "voice">): string {
  return voiceChoices(settings).find((voice) => voice.id === settings.voice)?.label ?? settings.voice;
}

export function pickVoice(
  settings: Pick<VoiceSettings, "ttsEngine" | "language" | "voice">,
  want: { voice?: string; gender?: VoiceGender; next?: true },
): string | null {
  const voices = voicesFor(settings.ttsEngine, settings.language);
  if (want.voice !== undefined) return voices.some((voice) => voice.id === want.voice) ? want.voice : null;
  const pool = want.gender ? voices.filter((voice) => voice.gender === want.gender) : voices;
  if (!pool.length) return null;
  const at = pool.findIndex((voice) => voice.id === settings.voice);
  return pool[(at + 1) % pool.length]!.id;
}
