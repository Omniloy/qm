import { xmlEscape } from "../util/message-tag.ts";
import { safeCutIndex, safeClip } from "./safe-cut.ts";

export function escapedClip(text: string, max: number): string {
  const escaped = xmlEscape(text);
  if (escaped.length <= max) return escaped;
  let cut = safeCutIndex(escaped, max - 1);
  const amp = escaped.lastIndexOf("&", cut - 1);
  if (amp >= 0 && escaped.indexOf(";", amp) >= cut) cut = amp;
  return `${escaped.slice(0, cut)}…`;
}

export function inlineCode(text: string, max = 1800): string {
  return `\`${escapedClip(text.replace(/`/g, "'"), max)}\``;
}

export function clip(text: string, max: number): string {
  return safeClip(text, max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
