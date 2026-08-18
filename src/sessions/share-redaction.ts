import type { EntryType, SessionEntry } from "../types.ts";

/**
 * What a public share link is allowed to contain.
 *
 * A shared transcript is read by people with no account, so this module is the
 * boundary between "what a member sees" and "what the world sees". Two rules
 * hold it together:
 *
 *   - It is an ALLOWLIST with an exhaustive switch. A twelfth entry type is a
 *     compile error here, not a silent leak in production. The failure mode is
 *     under-sharing, which is recoverable; over-sharing is not.
 *   - It never reads a payload field it has not named. Entries carry more than
 *     the product renders, and a shared page must not become the way to find
 *     that out.
 */

/** A file a reader may download, named by the share rather than by artifact id alone. */
export interface SharedFile {
  name: string;
  artifactId: string;
  mimetype?: string;
  sizeBytes?: number;
}

/**
 * One line of a shared transcript.
 *
 * `i` is a share-local index, deliberately not the entry's `seq`. Real seqs are
 * the store's per-session ordinal over EVERY entry including the dropped ones,
 * so publishing them would let a reader count exactly how much was withheld and
 * where — "seq 41 then seq 58" says seventeen things were hidden right there.
 */
export interface SharedEntry {
  i: number;
  role: "user" | "assistant";
  text: string;
  at: number;
  files?: SharedFile[];
}

const REDACTED = "[redacted link]";

/**
 * Patterns that carry a live credential in ordinary-looking prose.
 *
 * This is a net, not a wall — the walls are the entry allowlist and the sharer's
 * own participant window. It exists because the agent genuinely does paste
 * credential-bearing URLs into its replies, so message text alone is not safe
 * even after every tool entry has been dropped.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Secret-drop forms: the one place a bearer token in a URL is by design.
  /\bhttps?:\/\/\S*?\/drop\/[A-Za-z0-9-]{16,}\/form\S*/gi,
  /\/drop\/[A-Za-z0-9-]{16,}\/form(?:\?\S*)?/gi,
  // Connector consent redemption — carries the sharer's principal id.
  /\bhttps?:\/\/\S*?\/connect\/redeem\/\S+/gi,
  /\/v1\/connectors\/oauth\/consent\/redeem\/\S+/gi,
  // Any URL handing over a token-shaped value in a query parameter.
  /\bhttps?:\/\/\S*?[?&](?:t|token|code|key|access_token|secret)=[A-Za-z0-9._~+/=-]{20,}\S*/gi,
  // Three-part JWS — the shape this codebase mints capability tokens in.
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g,
  // Two-part signed payloads: portal identity and the legacy capability format.
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b/g,
  // Vendor key shapes worth catching even though we cannot catch them all.
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Replace anything credential-shaped with a visible marker.
 *
 * Visible on purpose: a reader who sees `[redacted link]` understands something
 * was removed, where a silently mangled URL just reads as a broken sentence.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Mirrors the product's own user-entry projection (core-bridge userEntryText). */
function userText(payload: Record<string, unknown>): string | null {
  // `hidden` marks a cron or trigger prompt: machinery, never something a person
  // typed, and the product drops it in three places already.
  if (payload.hidden === true) return null;
  const display = typeof payload.display === "string" && payload.display.trim() ? payload.display : null;
  // `text` on an automation- or Slack-origin turn is a <wake> envelope carrying
  // other people's messages and the channel's standing orders — never it alone.
  const raw = display ?? (typeof payload.text === "string" ? payload.text : "");
  return raw.trim() ? raw : null;
}

function filesOf(payload: Record<string, unknown>): SharedFile[] {
  const raw = Array.isArray(payload.files)
    ? payload.files
    : Array.isArray(payload.attachments)
      ? payload.attachments
      : [];
  const out: SharedFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const a = f as Record<string, unknown>;
    if (typeof a.name !== "string" || !a.name.trim()) continue;
    if (typeof a.artifactId !== "string" || !a.artifactId) continue;
    out.push({
      name: a.name,
      artifactId: a.artifactId,
      ...(typeof a.mimetype === "string" ? { mimetype: a.mimetype } : {}),
      ...(typeof a.sizeBytes === "number" ? { sizeBytes: a.sizeBytes } : {}),
    });
  }
  return out;
}

/**
 * Project a session's entries down to what a link holder may read.
 *
 * The switch is exhaustive against EntryType on purpose: the `never` tail turns
 * a new entry type into a build failure, so nobody can add one and have it
 * quietly appear on public pages.
 */
export function shareVisibleEntries(entries: readonly SessionEntry[]): SharedEntry[] {
  const out: SharedEntry[] = [];
  for (const entry of entries) {
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    const type: EntryType = entry.type;
    switch (type) {
      case "user": {
        const text = userText(payload);
        const files = filesOf(payload);
        if (!text && !files.length) break;
        out.push({
          i: out.length,
          role: "user",
          text: scrubSecrets(text ?? ""),
          at: entry.createdAt,
          ...(files.length ? { files } : {}),
        });
        break;
      }
      case "assistant": {
        const raw = typeof payload.text === "string" ? payload.text : "";
        if (!raw.trim()) break;
        out.push({ i: out.length, role: "assistant", text: scrubSecrets(raw), at: entry.createdAt });
        break;
      }
      case "delivery": {
        // Kept for its files alone — this is how an attachment reaches a reader.
        // The manifest text is regenerated from the names, never echoed.
        const files = filesOf(payload);
        if (!files.length) break;
        out.push({ i: out.length, role: "assistant", text: "", at: entry.createdAt, files });
        break;
      }
      // `text` is NOT assistant prose: the harness emits it only as narration
      // attached to a tool-using step, so it is tool activity wearing a message's
      // clothes. Sharing it would contradict "tool activity isn't included".
      case "text":
      case "thinking":
      case "tool_call":
      case "tool_result":
      case "soul":
      case "system":
      case "approval_request":
      case "approval_resolved":
        break;
      default: {
        const never: never = type;
        void never;
        break;
      }
    }
  }
  return out;
}
