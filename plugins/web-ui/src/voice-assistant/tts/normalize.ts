import type { VoiceLanguage } from "../protocol.ts";

const EMOJI =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

const MARKUP_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["–", "-"],
  ["‑", "-"],
  ["—", "-"],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["´", "'"],
  ["`", "'"],
  ["[", " "],
  ["]", " "],
  ["|", " "],
  ["#", " "],
  ["→", " "],
  ["←", " "],
  ["*", " "],
  ["~", " "],
];

const SUPERTONIC_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ...MARKUP_REPLACEMENTS,
  ["_", " "],
  ["/", " "],
];

const EXPRESSIONS: Readonly<Record<VoiceLanguage, ReadonlyArray<readonly [string, string]>>> = {
  en: [
    ["@", " at "],
    ["e.g.,", "for example, "],
    ["i.e.,", "that is, "],
  ],
  es: [
    ["@", " arroba "],
    ["p. ej.", "por ejemplo"],
  ],
};

const TERMINAL = /[.!?;:,'"')\]}…。」』】〉》›»]$/;

function stripSymbols(text: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let out = text.replace(/^[ \t]*[-•*+][ \t]+/gm, "").replace(EMOJI, "");
  for (const [from, to] of replacements) out = out.replaceAll(from, to);
  return out.replace(/[♥☆♡©\\]/g, "");
}

function tidy(text: string): string {
  const out = text
    .replace(/\s+/g, " ")
    .replace(/ ,/g, ",")
    .replace(/ \./g, ".")
    .replace(/ !/g, "!")
    .replace(/ \?/g, "?")
    .replace(/ ;/g, ";")
    .replace(/ :/g, ":")
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .trim();
  return out && !TERMINAL.test(out) ? `${out}.` : out;
}

export function cleanSpeechText(text: string): string {
  return tidy(stripSymbols(text, MARKUP_REPLACEMENTS));
}

export function normalizeSpeechText(text: string, language: VoiceLanguage): string {
  let out = stripSymbols(text.normalize("NFKD"), SUPERTONIC_REPLACEMENTS);
  for (const [from, to] of EXPRESSIONS[language]) out = out.replaceAll(from, to);
  return tidy(out);
}
