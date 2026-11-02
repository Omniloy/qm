import {
  VOICE_LANGUAGES,
  type TtsEngineId,
  type TtsVoice,
  type VoiceChoice,
  type VoiceGender,
  type VoiceLanguage,
  type VoiceLocale,
  type VoiceSettings,
} from "./protocol.ts";

const GENDER_WORDS: Record<VoiceGender, Record<VoiceLanguage, string>> = {
  female: { es: "femenina", en: "Female" },
  male: { es: "masculina", en: "Male" },
};

function presetVoice(gender: VoiceGender, number: number): TtsVoice {
  const id = `${gender === "female" ? "F" : "M"}${number}`;
  return {
    engine: "supertonic-3",
    id,
    name: id,
    gender,
    languages: VOICE_LANGUAGES,
    locale: null,
    labels: { es: `Voz ${GENDER_WORDS[gender].es} ${number}`, en: `${GENDER_WORDS[gender].en} ${number}` },
  };
}

const PRESET_NUMBERS = [1, 2, 3, 4, 5] as const;

export const SUPERTONIC_VOICES: readonly TtsVoice[] = [
  ...PRESET_NUMBERS.map((n) => presetVoice("female", n)),
  ...PRESET_NUMBERS.map((n) => presetVoice("male", n)),
];

const PHONON_CATALOG: readonly (readonly [string, string, VoiceLocale, VoiceGender])[] = [
  ["u2UscyAnHilpiwmf", "Alba", "es-ES", "female"],
  ["4701YgRXjkBcg6sL", "Alicia", "es-ES", "female"],
  ["c9wqBDmQiBie5q6Y", "Candela", "es-ES", "female"],
  ["rmLBOdHrfkFym9MM", "Celia", "es-ES", "female"],
  ["3p0eIGbkmny71GlA", "Lucía-Sol", "es-ES", "female"],
  ["EQcQFGkYfMn5YJgx", "Nerea", "es-ES", "female"],
  ["b6FvJAiokjdqIti4", "Noa", "es-ES", "female"],
  ["tIjCgP8v3RY8UpgM", "Borja", "es-ES", "male"],
  ["FaLVVqpFQcDOtq45", "Guillermo", "es-ES", "male"],
  ["t-_TS1e-0GzDAX02", "Iker", "es-ES", "male"],
  ["Ejb29qHnSOK0cIHY", "Izan", "es-ES", "male"],
  ["jvPx8j8zLGQ3utZz", "Marcos", "es-ES", "male"],
  ["fghJGlv90qu8OJ36", "Nuno", "es-ES", "male"],
  ["KJpIQlbYrZPA4aLq", "Azucena", "es-MX", "female"],
  ["evfxKSxpDIhmsNoq", "Danae", "es-MX", "female"],
  ["qG5BXOJYrKEnXLIX", "Jimena", "es-MX", "female"],
  ["Sx8m6WdXBG06zwZT", "Rebeca", "es-MX", "female"],
  ["s58clrg2fe0MO7Y-", "Regina", "es-MX", "female"],
  ["VDwnGxAo68C8U8vC", "Ximena", "es-MX", "female"],
  ["ax7dW1XB0eiMfHgO", "Aldo", "es-MX", "male"],
  ["F05gqkzX7WhKVpSL", "Lalo", "es-MX", "male"],
  ["BkuASiOJRrJEB5qA", "Leonel", "es-MX", "male"],
  ["PwgPEaweQILZdGc4", "Nico", "es-MX", "male"],
  ["G5HLUsQd659UtRe7", "Ulises", "es-MX", "male"],
  ["ALczEazoF4n6PmGl", "Yael", "es-MX", "male"],
  ["nGzMHMPAWGaJFHOo", "Delia", "en-US", "female"],
  ["vjFyp2BcCyTlUmYb", "Everly", "en-US", "female"],
  ["bXwrkHhURL1VFJdG", "Hadley", "en-US", "female"],
  ["4SZHfMpw-p46Ywgs", "Harper", "en-US", "female"],
  ["NIWIOv5vTi5eRMj8", "Juniper", "en-US", "female"],
  ["NbpkqMVS3CJeq2j8", "Zoey", "en-US", "female"],
  ["LMDIYE0Oa377Qh6Z", "Easton", "en-US", "male"],
  ["40QrMVgAxFiUnP9f", "Micah", "en-US", "male"],
  ["d9XCyhjo4JhkHF1d", "Miles", "en-US", "male"],
  ["qIxlZ7Ei8KvWlyQH", "Preston", "en-US", "male"],
  ["_6Aslh2DxfmnRLmP", "Russell", "en-US", "male"],
  ["0zLApsZfVLLNaEGl", "Trevor", "en-US", "male"],
  ["gfP44RlHwr2kEwk7", "Bryony", "en-GB", "female"],
  ["y9bQqIDnyxwqK01t", "Elodie-Rose", "en-GB", "female"],
  ["GgfEkEJtxZR7gnpy", "Freya", "en-GB", "female"],
  ["gDT1nz7Ie36ZhL-C", "Imogen", "en-GB", "female"],
  ["m9MxpY6IUGXtWp76", "Lottie", "en-GB", "female"],
  ["6PWnV0Nq4wu7RVBT", "Maeve", "en-GB", "female"],
  ["uem82D50GRv2Dwma", "Pippa", "en-GB", "female"],
  ["X6NceqF285Gr04gb", "Alfie", "en-GB", "male"],
  ["zUCxzrOrugTSis03", "Edwin", "en-GB", "male"],
  ["YyKcxPG7iIgS3jsK", "Hugh", "en-GB", "male"],
  ["JOW0vchyswkQUMDS", "Spencer", "en-GB", "male"],
  ["Zn7g6NxLqXlJb7Qi", "Teddy", "en-GB", "male"],
  ["dME3IWyZBvmh1n1q", "Toby", "en-GB", "male"],
];

const REGION_LABELS: Readonly<Record<VoiceLocale, Readonly<Record<VoiceLanguage, string>>>> = {
  "es-ES": { es: "España", en: "Spain" },
  "es-MX": { es: "México", en: "Mexico" },
  "en-US": { es: "EE. UU.", en: "US" },
  "en-GB": { es: "Reino Unido", en: "UK" },
};

export const PHONON_VOICES: readonly TtsVoice[] = PHONON_CATALOG.map(([id, name, locale, gender]) => ({
  engine: "phonon-40m",
  id,
  name,
  gender,
  languages: [locale.slice(0, 2) as VoiceLanguage],
  locale,
  labels: { es: `${name} (${REGION_LABELS[locale].es})`, en: `${name} (${REGION_LABELS[locale].en})` },
}));

export const VOICE_LOCALE_LABELS: Readonly<Record<VoiceLocale, Readonly<Record<VoiceLanguage, string>>>> = {
  "es-ES": { es: "Español (España)", en: "Spanish (Spain)" },
  "es-MX": { es: "Español (México)", en: "Spanish (Mexico)" },
  "en-US": { es: "Inglés (EE. UU.)", en: "English (US)" },
  "en-GB": { es: "Inglés (Reino Unido)", en: "English (UK)" },
};

const DEFAULT_VOICES: Readonly<
  Record<TtsEngineId, Readonly<Record<VoiceLanguage, Readonly<Record<VoiceGender, string>>>>>
> = {
  "phonon-40m": {
    es: { female: "rmLBOdHrfkFym9MM", male: "jvPx8j8zLGQ3utZz" },
    en: { female: "4SZHfMpw-p46Ywgs", male: "qIxlZ7Ei8KvWlyQH" },
  },
  "supertonic-3": { es: { female: "F1", male: "M1" }, en: { female: "F1", male: "M1" } },
};

const ALL_VOICES: readonly TtsVoice[] = [...PHONON_VOICES, ...SUPERTONIC_VOICES];

export function voicesFor(engine: TtsEngineId, language: VoiceLanguage): TtsVoice[] {
  return ALL_VOICES.filter((voice) => voice.engine === engine && voice.languages.includes(language));
}

export function knownVoice(language: VoiceLanguage, voice: unknown): voice is string {
  return ALL_VOICES.some((option) => option.id === voice && option.languages.includes(language));
}

export function supportedVoice(engine: TtsEngineId, language: VoiceLanguage, voice: unknown): string {
  if (voicesFor(engine, language).some((option) => option.id === voice)) return voice as string;
  const gender = ALL_VOICES.find((option) => option.id === voice)?.gender ?? "female";
  return DEFAULT_VOICES[engine][language][gender];
}

export function voiceChoices(settings: Pick<VoiceSettings, "ttsEngine" | "language">): VoiceChoice[] {
  return voicesFor(settings.ttsEngine, settings.language).map((voice) => ({
    id: voice.id,
    label: voice.labels[settings.language],
    gender: voice.gender,
    ...(voice.locale ? { locale: voice.locale } : {}),
  }));
}

export function voiceLabel(settings: Pick<VoiceSettings, "ttsEngine" | "language" | "voice">): string {
  return voiceChoices(settings).find((voice) => voice.id === settings.voice)?.label ?? settings.voice;
}

export function pickVoice(
  settings: Pick<VoiceSettings, "ttsEngine" | "language" | "voice">,
  want: { voice?: string; gender?: VoiceGender; next?: true },
): string | null {
  const voices = voiceChoices(settings);
  if (want.voice !== undefined) return voices.some((voice) => voice.id === want.voice) ? want.voice : null;
  const pool = want.gender ? voices.filter((voice) => voice.gender === want.gender) : voices;
  if (!pool.length) return null;
  const at = pool.findIndex((voice) => voice.id === settings.voice);
  return pool[(at + 1) % pool.length]!.id;
}
