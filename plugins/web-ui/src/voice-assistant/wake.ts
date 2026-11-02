export const WAKE_THRESHOLD = 0.8;

const GREETING_VARIANTS = ["hey", "hola", "oye", "hoy", "hi", "ola", "ey", "oiga", "okay", "ok", "hej"] as const;
const MAX_NAME_TOKENS = 2;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const LEADING_SEPARATORS = /^[\s,.;:!?…\-–—"'»)\]]+/u;

export interface WakeMatch {
  matched: boolean;
  score: number;
  remainder: string;
}

interface Token {
  text: string;
  phonetic: string;
  end: number;
}

interface Candidate {
  score: number;
  consumed: number;
}

const NO_MATCH: WakeMatch = { matched: false, score: 0, remainder: "" };

const CONFIRMATION_YES = new Set([
  "si",
  "si si",
  "si por favor",
  "si hazlo",
  "si adelante",
  "si confirmo",
  "vale",
  "confirmo",
  "adelante",
  "hazlo",
  "claro",
  "de acuerdo",
  "yes",
  "yes please",
  "yeah",
  "yep",
  "sure",
  "ok",
  "okay",
  "confirm",
  "do it",
  "go ahead",
]);
const CONFIRMATION_NO = new Set(["no", "no gracias", "no lo hagas", "cancela", "nope", "no thanks", "cancel", "don t"]);

export function normalizeSpeech(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function phonetic(word: string): string {
  return word
    .replace(/ph/g, "f")
    .replace(/[cs]h/g, "x")
    .replace(/qu/g, "k")
    .replace(/ll/g, "y")
    .replace(/d?j/g, "y")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/h/g, "")
    .replace(/y/g, "i")
    .replace(/v/g, "b")
    .replace(/w/g, "u")
    .replace(/z/g, "s")
    .replace(/(.)\1+/g, "$1");
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function blended(word: string): string {
  return word.replace(/mn/g, "m");
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - editDistance(a, b) / longest;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    const normalized = normalizeSpeech(match[0]).replace(/\s+/g, "");
    if (!normalized) continue;
    tokens.push({ text: normalized, phonetic: phonetic(normalized), end: match.index + match[0].length });
  }
  return tokens;
}

function bestName(tokens: readonly Token[], start: number, name: string): Candidate {
  let best: Candidate = { score: 0, consumed: 0 };
  let joined = "";
  for (let n = 1; n <= MAX_NAME_TOKENS && start + n <= tokens.length; n++) {
    joined += tokens[start + n - 1].text;
    const said = phonetic(joined);
    const score = n === 1 ? similarity(blended(said), blended(name)) : similarity(said, name);
    if (score > best.score) best = { score, consumed: n };
  }
  return best;
}

function greetingScore(token: Token, greetings: readonly string[]): number {
  let best = 0;
  for (const greeting of greetings) best = Math.max(best, similarity(token.phonetic, greeting));
  return best;
}

export function matchWake(transcript: string, phrase: string): WakeMatch {
  const phraseWords = normalizeSpeech(phrase).split(" ").filter(Boolean).map(phonetic);
  const tokens = tokenize(transcript);
  const name = phraseWords.at(-1);
  if (!name || tokens.length === 0) return NO_MATCH;
  const configuredGreeting = phraseWords.slice(0, -1);
  const variants = GREETING_VARIANTS.map((g) => phonetic(g));

  const candidates: Candidate[] = [];
  const bare = bestName(tokens, 0, name);
  if (bare.consumed > 0) candidates.push(bare);
  if (configuredGreeting.length > 0 && tokens.length > configuredGreeting.length) {
    let greeting = 1;
    configuredGreeting.forEach((word, i) => {
      greeting = Math.min(greeting, similarity(tokens[i].phonetic, word));
    });
    const after = bestName(tokens, configuredGreeting.length, name);
    if (after.consumed > 0) {
      candidates.push({ score: Math.min(greeting, after.score), consumed: configuredGreeting.length + after.consumed });
    }
  }
  for (const greeting of [configuredGreeting.join(""), ...variants]) {
    if (greeting)
      candidates.push({ score: similarity(blended(tokens[0].phonetic), blended(greeting + name)), consumed: 1 });
  }
  if (tokens.length > 1) {
    const greeting = greetingScore(tokens[0], variants);
    const after = bestName(tokens, 1, name);
    if (after.consumed > 0) candidates.push({ score: Math.min(greeting, after.score), consumed: 1 + after.consumed });
  }

  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.consumed < best.consumed)
    ) {
      best = candidate;
    }
  }
  if (!best) return NO_MATCH;
  const score = Math.round(best.score * 1000) / 1000;
  if (score < WAKE_THRESHOLD) return { matched: false, score, remainder: "" };
  return { matched: true, score, remainder: remainderAfter(transcript, tokens[best.consumed - 1].end) };
}

function remainderAfter(transcript: string, end: number): string {
  const rest = transcript.slice(end).replace(LEADING_SEPARATORS, "").trim();
  return /[\p{L}\p{N}]/u.test(rest) ? rest : "";
}

export function confirmationAnswer(text: string): "yes" | "no" | null {
  const said = normalizeSpeech(text);
  if (CONFIRMATION_YES.has(said)) return "yes";
  return CONFIRMATION_NO.has(said) ? "no" : null;
}
