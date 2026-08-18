/**
 * Public share surfaces for the web-ui server.
 *
 * Three GET-only paths are answered ABOVE the identity gate at
 * `server/index.ts:808` (`if (path === "/me" || path.startsWith("/api/"))`).
 * Two of them live under `/api/`, one typo away from the authenticated relay
 * that sits below that gate, so every matcher here is an ANCHORED regex over
 * the raw `url.pathname` and never a `startsWith` prefix. `matchSharePath` is
 * the only sanctioned way to decide that a request is anonymous.
 *
 * Nothing in this module decides permissions. Core owns authorization: the
 * relays forward the share id and (when the portal supplied one) the caller's
 * `x-portal-identity`, and core alone computes anonymous / member / outsider
 * and what the sharer could see.
 *
 * There is no `?t=` capability token anywhere in this feature. The share id IS
 * the secret; core mints nothing else, so nothing here reads, validates or
 * forwards a second credential.
 *
 * The header builders exist because the server's shared helpers are wrong for
 * this feature in two specific ways:
 *   - `relay()` (index.ts:199-202) hardcodes its header object, so it cannot
 *     carry `cache-control: no-store` or `vary`. A share response with no cache
 *     directives is heuristically cacheable by any shared cache: a cached 200
 *     outlives Unshare, and the member-shaped body (the only one carrying a
 *     real sessionId) can be replayed to an anonymous link holder. Use
 *     `shareJsonHeaders()` and write the head directly.
 *   - `serveAppEditHtml()` (index.ts:670-692) exists to DELETE
 *     `x-frame-options` and widen `frame-ancestors`. That is the opposite of
 *     what a page rendering untrusted, auto-polling content needs. The share
 *     page is modelled on the plain `serveStatic` index.html branch
 *     (index.ts:649-655); `shareHtmlHeaders()` throws if it is handed headers
 *     that have been relaxed that way, so copying the wrong template fails loud
 *     instead of shipping a clickjackable transcript.
 */

/** Share ids are `randomUUID() + randomUUID().replace(/-/g,"")` — 68 chars of hex and hyphen. */
const SHARE_ID = "[A-Za-z0-9-]{32,80}";
/** Artifact ids are `<scope>:<path>`-derived opaque strings; colons and dots are legal, `..` is not. */
const ARTIFACT_ID = "[A-Za-z0-9_.:-]{1,200}";

/** GET the share page HTML. Private: `matchSharePath` is the only sanctioned way to ask. */
const SHARE_PAGE_PATH_RE = new RegExp(`^/share/(${SHARE_ID})$`);
/** GET the share transcript JSON. */
const SHARE_TRANSCRIPT_PATH_RE = new RegExp(`^/api/public/shares/(${SHARE_ID})$`);
/** GET a share-scoped attachment download. */
const SHARE_FILE_PATH_RE = new RegExp(`^/api/public/shares/(${SHARE_ID})/files/(${ARTIFACT_ID})$`);

export type ShareSurface =
  | { kind: "page"; shareId: string }
  | { kind: "transcript"; shareId: string }
  | { kind: "file"; shareId: string; artifactId: string };

/**
 * The single anonymous-surface decision. Returns null for everything else,
 * including every path that merely looks like a share path, so an unmatched
 * request falls through to the identity gate and 401s.
 *
 * Pass the RAW `url.pathname` — never a decoded string. Percent-escapes are
 * outside both charsets, so `%2e%2e` and friends can only fail to match.
 */
export function matchSharePath(method: string, pathname: string): ShareSurface | null {
  if (method !== "GET") return null;

  const page = SHARE_PAGE_PATH_RE.exec(pathname);
  if (page) return { kind: "page", shareId: page[1]! };

  const transcript = SHARE_TRANSCRIPT_PATH_RE.exec(pathname);
  if (transcript) return { kind: "transcript", shareId: transcript[1]! };

  const file = SHARE_FILE_PATH_RE.exec(pathname);
  if (file) {
    const artifactId = file[2]!;
    // `.` is legal inside an artifact id, so the charset alone admits `..`.
    // encodeURIComponent does not escape dots, so a `..` segment would survive
    // into the core path and could be normalised upstream. Refuse it here.
    if (artifactId === "." || artifactId.includes("..")) return null;
    return { kind: "file", shareId: file[1]!, artifactId };
  }

  return null;
}

/**
 * Applied to all three share responses.
 *
 * `no-store` is the whole containment story for a feature with no expiry:
 * "Unshare takes effect on the next request" is only true if there is a next
 * request. `vary` names every header the body varies by — core returns
 * anonymous / member / outsider from the same URL — so a shared cache can never
 * serve one standing's body to another. `cookie` is listed alongside the portal
 * identity header because in dev (`COOKIE_AUTH`) the identity arrives that way.
 */
export const SHARE_CACHE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0, private",
  pragma: "no-cache",
  expires: "0",
  vary: "x-portal-identity, cookie",
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
});

/**
 * Throws if the headers have been relaxed the way `serveAppEditHtml` relaxes
 * them. Called from `shareHtmlHeaders`, so an implementer who reaches for the
 * wrong template gets a 502 and a failing test rather than an embeddable share
 * page.
 */
export function assertNotFrameWidened(headers: Record<string, string>): void {
  if (!headers["x-frame-options"]) {
    throw new Error("share html: x-frame-options is missing — serveShareHtml must not be modelled on serveAppEditHtml");
  }
  const csp = headers["content-security-policy"] ?? "";
  const ancestors = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith("frame-ancestors"));
  if (ancestors !== "frame-ancestors 'self'") {
    throw new Error(`share html: frame-ancestors must remain exactly 'self', got ${JSON.stringify(ancestors ?? null)}`);
  }
}

/**
 * The share page's CSP, narrowed from the SPA's.
 *
 * The SPA policy allows `img-src ... https:` and `frame-src 'self' https:`
 * because a signed-in user's own workspace renders their own content. The share
 * page is the opposite situation: it renders text written by someone else to an
 * audience of strangers who never consented to anything. A remote `<img>`
 * survives the markdown sanitiser verbatim, and every anonymous reader loading
 * it hands the message author their IP, user-agent and a precise read timestamp
 * — a read receipt on a page whose whole premise is that the reader is
 * anonymous. Three directives are therefore tightened:
 *
 *   img-src 'self' data:   — no `https:`. Attachments and inline data URIs only.
 *   frame-src 'none'       — an iframe is the same beacon with a bigger payload.
 *   connect-src 'self'     — the page polls its own origin and nothing else.
 *
 * Everything else, including `frame-ancestors 'self'`, is left exactly as the
 * SPA has it: this narrows, it never widens.
 */
const SHARE_CSP_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "img-src": "img-src 'self' data:",
  "frame-src": "frame-src 'none'",
  "connect-src": "connect-src 'self'",
});

export function narrowShareCsp(csp: string): string {
  const seen = new Set<string>();
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const name = (d.split(/\s+/)[0] ?? "").toLowerCase();
      const override = SHARE_CSP_OVERRIDES[name];
      if (!override) return d;
      seen.add(name);
      return override;
    });
  // A policy that simply omitted one of these would fall back to default-src,
  // which the SPA sets to 'self' — safe for connect-src, but not a guarantee
  // worth inheriting. Append whatever was missing so the page's answer is
  // explicit either way.
  for (const [name, value] of Object.entries(SHARE_CSP_OVERRIDES)) {
    if (!seen.has(name)) directives.push(value);
  }
  return directives.join("; ");
}

/**
 * Headers for the share page HTML.
 *
 * `base` is `withSecurityHeaders({})` from index.ts — the same headers the
 * ordinary SPA index.html gets. Caching, indexing and the content type are
 * added on top, and the CSP is narrowed (never widened) by `narrowShareCsp`.
 */
export function shareHtmlHeaders(base: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    ...base,
    ...SHARE_CACHE_HEADERS,
    "content-type": "text/html; charset=utf-8",
  };
  const csp = headers["content-security-policy"];
  if (csp) headers["content-security-policy"] = narrowShareCsp(csp);
  assertNotFrameWidened(headers);
  return headers;
}

/** Headers for the share transcript JSON. The `relay()` helper cannot express these. */
export function shareJsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
    ...SHARE_CACHE_HEADERS,
  };
}

/**
 * Attachment bytes are attacker-influenced and are served from the app origin,
 * where the SPA CSP is `script-src 'self'`. A same-origin `<script src=…>` load
 * ignores `content-disposition` and is permitted by `nosniff` whenever the MIME
 * *is* a script MIME, so the upstream mimetype is discarded unconditionally —
 * `application/octet-stream` plus `nosniff` makes the subresource load fail.
 */
export const SHARE_FILE_CONTENT_TYPE = "application/octet-stream";

/** Fully sandboxed, no subresources, not framable. Applies if a browser renders the bytes as a document anyway. */
export const SHARE_FILE_CSP = [
  "default-src 'none'",
  "sandbox",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_LENGTH_RE = /^[0-9]{1,19}$/;

/**
 * RFC 6266 `attachment` disposition for an attacker-supplied filename.
 * The ASCII fallback is stripped of anything that could break out of the quoted
 * string or inject a header; the `filename*` form carries the real name.
 */
export function contentDispositionAttachment(rawName: string | null | undefined): string {
  const name = (rawName ?? "").trim();
  const ascii = name
    .replace(/[^\u0020-\u007e]/g, "")
    .replace(/["\\;/]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120)
    .trim();
  const fallback = ascii || "download";
  if (!name) return `attachment; filename="${fallback}"`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Pulls a filename out of the upstream `content-disposition`, preferring the
 * RFC 5987 `filename*` form. The result is untrusted and goes straight back
 * through `contentDispositionAttachment`, which is what sanitises it.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const ext = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(header);
  if (ext) {
    try {
      return decodeURIComponent(ext[1]!) || null;
    } catch {
      return null;
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1") || null;
  const bare = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return bare ? (bare[1] ?? null) : null;
}

/** Headers for a share-scoped attachment download. Forced download, forced octet-stream, no cache. */
export function shareFileHeaders(upstream: {
  filename?: string | null;
  contentLength?: string | null;
}): Record<string, string> {
  const len = upstream.contentLength ?? "";
  return {
    "content-type": SHARE_FILE_CONTENT_TYPE,
    "content-disposition": contentDispositionAttachment(upstream.filename),
    "content-security-policy": SHARE_FILE_CSP,
    "x-content-type-options": "nosniff",
    ...(CONTENT_LENGTH_RE.test(len) ? { "content-length": len } : {}),
    ...SHARE_CACHE_HEADERS,
  };
}

/**
 * The poll cursor, and nothing else.
 *
 * The relay must never forward `url.search` wholesale: the caller is anonymous
 * and would otherwise be able to append `&viewer=alice` or `&principalId=alice`
 * to a query core reads user-scoping from. This allowlist is the reason the
 * public relays build their core query from scratch.
 */
export function shareCursorFrom(search: URLSearchParams): number | null {
  const raw = search.get("sinceIndex");
  if (raw === null || !/^[0-9]{1,9}$/.test(raw)) return null;
  return Number(raw);
}

/** `GET /v1/shares/:shareId` — built from scratch, never from the inbound query string. */
export function shareTranscriptCorePath(shareId: string, sinceIndex: number | null): string {
  const search = sinceIndex === null ? "" : `?sinceIndex=${sinceIndex}`;
  return `/v1/shares/${encodeURIComponent(shareId)}${search}`;
}

/** `GET /v1/shares/:shareId/files/:artifactId` — same rule: no query at all. */
export function shareFileCorePath(shareId: string, artifactId: string): string {
  return `/v1/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(artifactId)}`;
}

/** Served at /robots.txt. Share links are unlisted; they must not become indexed. */
export const SHARE_ROBOTS_TXT = ["User-agent: *", "Disallow: /share/", "Disallow: /api/public/", ""].join("\n");

export const SHARE_ROBOTS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "public, max-age=3600",
  "x-content-type-options": "nosniff",
});
