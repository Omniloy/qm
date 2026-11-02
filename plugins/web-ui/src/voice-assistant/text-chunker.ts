export interface TextChunker {
  push(delta: string): string[];
  flush(): string[];
}

export const FIRST_CHUNK_MIN_CHARS = 12;
export const CHUNK_MIN_CHARS = 20;
export const CHUNK_TARGET_CHARS = 120;
export const CHUNK_MAX_CHARS = 300;
const FIRST_CHUNK_STEPS = 3;
const LATER_CHUNK_STEPS = 5;

const FIRST_BREAK = /[,.?!;:]/;
const SENTENCE_BREAK = /[.?!;:]/;
const CLAUSE_BREAK = /[,;:]/;
const CLOSERS = /["')\]»”’]/;
const ABBREVIATIONS = new Set([
  "sr",
  "sra",
  "srta",
  "dr",
  "dra",
  "ud",
  "uds",
  "vd",
  "vds",
  "lic",
  "ing",
  "etc",
  "pág",
  "núm",
  "mr",
  "mrs",
  "ms",
  "prof",
  "jr",
  "st",
  "vs",
  "inc",
  "ltd",
  "co",
  "corp",
  "eg",
  "ie",
]);

export function withoutClosingPunctuation(text: string): string {
  return text.replace(/[\s.!?…:;,]+$/u, "");
}

export function stepsForChunk(chunkIndex: number): number {
  return chunkIndex === 0 ? FIRST_CHUNK_STEPS : LATER_CHUNK_STEPS;
}

function speakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function isAbbreviation(text: string, dotIndex: number): boolean {
  const word = /([\p{L}.]+)$/u.exec(text.slice(0, dotIndex))?.[1] ?? "";
  const bare = word.replace(/\./g, "").toLowerCase();
  if (!bare) return false;
  if (/^\p{Lu}$/u.test(word)) return true;
  return ABBREVIATIONS.has(bare);
}

function breakEnd(text: string, index: number, pattern: RegExp): number {
  const ch = text[index];
  if (ch === "\n") return index + 1;
  if (!pattern.test(ch)) return -1;
  let end = index + 1;
  while (end < text.length && (pattern.test(text[end]) || text[end] === "." || CLOSERS.test(text[end]))) end++;
  if (end >= text.length || !/\s/.test(text[end])) return -1;
  if (ch === "." && end === index + 1 && isAbbreviation(text, index)) return -1;
  return end;
}

function firstBreak(text: string, pattern: RegExp, limit: number, min: number): number {
  for (let i = 0; i < Math.min(text.length, limit); i++) {
    const end = breakEnd(text, i, pattern);
    if (end >= 0 && end <= limit && text.slice(0, end).trim().length >= min) return end;
    if (end > i) i = end - 1;
  }
  return -1;
}

function openingBreak(text: string): number {
  const breaks = [
    firstBreak(text, SENTENCE_BREAK, CHUNK_TARGET_CHARS, FIRST_CHUNK_MIN_CHARS),
    firstBreak(text, FIRST_BREAK, CHUNK_TARGET_CHARS, CHUNK_MIN_CHARS),
  ].filter((end) => end >= 0);
  return breaks.length ? Math.min(...breaks) : -1;
}

function lastBreak(text: string, pattern: RegExp, limit: number): number {
  let best = -1;
  for (let i = 0; i < Math.min(text.length, limit); i++) {
    const end = breakEnd(text, i, pattern);
    if (end >= 0 && end <= limit && text.slice(0, end).trim().length >= CHUNK_MIN_CHARS) best = end;
  }
  return best;
}

function lastSpace(text: string, limit: number): number {
  for (let i = Math.min(text.length, limit) - 1; i >= CHUNK_MIN_CHARS; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}

export function createTextChunker(): TextChunker {
  let buffer = "";
  let emitted = 0;

  const cut = (final: boolean): number => {
    const sentence =
      emitted === 0 ? openingBreak(buffer) : firstBreak(buffer, SENTENCE_BREAK, CHUNK_TARGET_CHARS, CHUNK_MIN_CHARS);
    if (sentence >= 0) return sentence;
    if (buffer.length <= CHUNK_TARGET_CHARS) return final ? buffer.length : -1;
    const clause = lastBreak(buffer, CLAUSE_BREAK, CHUNK_TARGET_CHARS);
    if (clause >= 0) return clause;
    const space = lastSpace(buffer, CHUNK_TARGET_CHARS);
    if (space >= 0) return space;
    if (buffer.length >= CHUNK_MAX_CHARS) return CHUNK_MAX_CHARS;
    return final ? buffer.length : -1;
  };

  const drain = (final: boolean): string[] => {
    const out: string[] = [];
    for (let end = cut(final); end > 0; end = cut(final)) {
      const chunk = buffer.slice(0, end).replace(/\s+/g, " ").trim();
      buffer = buffer.slice(end);
      if (speakable(chunk)) {
        out.push(chunk);
        emitted++;
      }
    }
    return out;
  };

  return {
    push(delta) {
      buffer += delta;
      return drain(false);
    },
    flush() {
      const out = drain(true);
      buffer = "";
      emitted = 0;
      return out;
    },
  };
}
