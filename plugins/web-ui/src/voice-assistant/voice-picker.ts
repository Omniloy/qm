import { html, type TemplateResult } from "lit";
import {
  VOICE_GENDERS,
  VOICE_LANGUAGES,
  VOICE_LOCALES,
  type VoiceChoice,
  type VoiceLanguage,
  type VoiceSettings,
} from "./protocol.ts";
import { VOICE_LOCALE_LABELS, voicesFor } from "./voices.ts";

export const ALL_VOICES_OPTION = "*";

const MORE_VOICES: Record<VoiceLanguage, string> = {
  es: "Ver voces de otros idiomas…",
  en: "Show voices in other languages…",
};

export function pickerVoices(settings: Pick<VoiceSettings, "ttsEngine" | "language">): VoiceChoice[] {
  const voices = VOICE_LANGUAGES.flatMap((language) => voicesFor(settings.ttsEngine, language));
  return [...new Map(voices.map((voice) => [voice.id, voice])).values()].map((voice) => ({
    id: voice.id,
    label: voice.labels[settings.language],
    gender: voice.gender,
    ...(voice.locale ? { locale: voice.locale } : {}),
  }));
}

export function languageForVoice(
  settings: Pick<VoiceSettings, "ttsEngine" | "language">,
  voice: string,
): VoiceLanguage {
  const locale = pickerVoices(settings).find((choice) => choice.id === voice)?.locale;
  return VOICE_LANGUAGES.find((language) => locale?.startsWith(language)) ?? settings.language;
}

function speaks(choice: VoiceChoice, language: VoiceLanguage): boolean {
  return !choice.locale || choice.locale.startsWith(language);
}

function femaleFirst(choices: readonly VoiceChoice[]): VoiceChoice[] {
  return [...choices].sort((a, b) => VOICE_GENDERS.indexOf(a.gender) - VOICE_GENDERS.indexOf(b.gender));
}

export function voiceOptions(
  voices: readonly VoiceChoice[],
  view: { language: VoiceLanguage; voice: string; showAll: boolean },
): TemplateResult[] {
  const shown = view.showAll ? voices : voices.filter((choice) => speaks(choice, view.language));
  const option = (choice: VoiceChoice) =>
    html`<option value=${choice.id} ?selected=${choice.id === view.voice}>${choice.label}</option>`;
  const groups = VOICE_LOCALES.flatMap((locale) => {
    const members = shown.filter((choice) => choice.locale === locale);
    return members.length
      ? [
          html`<optgroup label=${VOICE_LOCALE_LABELS[locale][view.language]}>
            ${femaleFirst(members).map(option)}
          </optgroup>`,
        ]
      : [];
  });
  const more =
    shown.length < voices.length
      ? [html`<option value=${ALL_VOICES_OPTION}>${MORE_VOICES[view.language]}</option>`]
      : [];
  return [...femaleFirst(shown.filter((choice) => !choice.locale)).map(option), ...groups, ...more];
}
