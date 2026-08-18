import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  matchSharePath,
  SHARE_CACHE_HEADERS,
  SHARE_FILE_CONTENT_TYPE,
  SHARE_FILE_CSP,
  SHARE_ROBOTS_HEADERS,
  SHARE_ROBOTS_TXT,
  assertNotFrameWidened,
  contentDispositionAttachment,
  filenameFromContentDisposition,
  shareCursorFrom,
  shareFileCorePath,
  shareFileHeaders,
  shareHtmlHeaders,
  shareJsonHeaders,
  narrowShareCsp,
  shareTranscriptCorePath,
} from "../plugins/web-ui/server/share-routes.ts";

// A share id as the store mints it: randomUUID() + randomUUID() with hyphens stripped.
const ID = "b3f2c1a0-4d5e-4f6a-8b9c-0d1e2f3a4b5c" + "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
assert.equal(ID.length, 68);

// ---------------------------------------------------------------------------
// Anchored matching. The two /api/ surfaces sit above the identity gate at
// server/index.ts:808, so anything the matcher wrongly accepts is anonymous.
// ---------------------------------------------------------------------------

test("the three anonymous surfaces match, and only as GET", () => {
  assert.deepEqual(matchSharePath("GET", `/share/${ID}`), { kind: "page", shareId: ID });
  assert.deepEqual(matchSharePath("GET", `/api/public/shares/${ID}`), { kind: "transcript", shareId: ID });
  assert.deepEqual(matchSharePath("GET", `/api/public/shares/${ID}/files/scope-x:out%3A0`.replace("%3A", ":")), {
    kind: "file",
    shareId: ID,
    artifactId: "scope-x:out:0",
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "get", ""]) {
    assert.equal(matchSharePath(method, `/api/public/shares/${ID}`), null, method);
  }
});

test("every authenticated relay path in the server falls through to the identity gate", () => {
  // Lifted from plugins/web-ui/server/index.ts — the paths that must stay behind auth.
  const authed = [
    "/me",
    "/api/sessions",
    "/api/sessions/abc",
    "/api/sessions/abc/entries/7",
    "/api/files",
    "/api/files/abc/content",
    "/api/files/upload",
    "/api/blobs",
    "/api/contexts",
    "/api/deliveries/events",
    "/api/runtime-config",
    "/api/workspace/tree",
    "/api/public",
    "/api/public/",
    "/api/public/shares",
    "/api/public/shares/",
    "/api/publicshares/" + ID,
    "/api/public/sessions/" + ID,
    "/share",
    "/share/",
    "/sharex/" + ID,
    "/deployments/x/",
    "/app-edit",
  ];
  for (const p of authed) assert.equal(matchSharePath("GET", p), null, p);
});

test("a crafted traversal never matches — the specific accident a prefix test would allow", () => {
  const crafted = [
    `/api/public/shares/${ID}/../sessions`,
    `/api/public/shares/${ID}/..%2fsessions`,
    `/api/public/shares/${ID}%2f..%2fsessions`,
    `/api/public/shares/%2e%2e/${ID}`,
    `/api/public/shares/${ID}/files/..`,
    `/api/public/shares/${ID}/files/../../secrets`,
    `/api/public/shares/${ID}/files/a..b`,
    `/api/public/shares/${ID}/files/.`,
    `/api/public/shares/${ID}/files/`,
    `/api/public/shares/${ID}/files`,
    `/api/public/shares/${ID}/files/a/b`,
    `/api/public/shares/${ID}?viewer=alice`, // query is never part of pathname; a match here means the caller passed url.href
    `/api/public/shares/${ID}#x`,
    `/api/public/shares/${ID}/`,
    `//api/public/shares/${ID}`,
    `/API/PUBLIC/SHARES/${ID}`,
    ` /api/public/shares/${ID}`,
    `/api/public/shares/${ID}\n/api/sessions`,
  ];
  for (const p of crafted) assert.equal(matchSharePath("GET", p), null, p);
});

test("share ids outside the minted shape are refused before any core round-trip", () => {
  for (const bad of [
    "short",
    "a".repeat(31),
    "a".repeat(81),
    "has_underscore".padEnd(40, "a"),
    "has.dot".padEnd(40, "a"),
    "a".repeat(20) + "/" + "b".repeat(20),
  ]) {
    assert.equal(matchSharePath("GET", `/api/public/shares/${bad}`), null, bad);
    assert.equal(matchSharePath("GET", `/share/${bad}`), null, bad);
  }
  assert.ok(matchSharePath("GET", `/share/${"a".repeat(32)}`));
  assert.ok(matchSharePath("GET", `/share/${"a".repeat(80)}`));
});

// ---------------------------------------------------------------------------
// Caching and standing. A cached 200 outlives Unshare; a body cached without
// Vary crosses anonymous / member / outsider.
// ---------------------------------------------------------------------------

function baseSecurityHeaders(): Record<string, string> {
  // Exactly what withSecurityHeaders() produces in plugins/web-ui/server/index.ts.
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self' https:",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
  };
}

test("all three share responses carry no-store, vary and noindex", () => {
  const responses = [
    shareHtmlHeaders(baseSecurityHeaders()),
    shareJsonHeaders(),
    shareFileHeaders({ filename: "notes.txt", contentLength: "12" }),
  ];
  for (const h of responses) {
    assert.match(h["cache-control"] ?? "", /no-store/);
    assert.match(h["cache-control"] ?? "", /private/);
    assert.match(h["vary"] ?? "", /x-portal-identity/);
    assert.match(h["x-robots-tag"] ?? "", /noindex/);
  }
});

test("SHARE_CACHE_HEADERS cannot be mutated by a caller that spreads it", () => {
  assert.throws(() => {
    (SHARE_CACHE_HEADERS as Record<string, string>)["cache-control"] = "public, max-age=600";
  });
  assert.match(SHARE_CACHE_HEADERS["cache-control"] ?? "", /no-store/);
});

// ---------------------------------------------------------------------------
// The share page is the static index.html branch, not serveAppEditHtml.
// ---------------------------------------------------------------------------

test("share html keeps x-frame-options and an unmodified frame-ancestors 'self'", () => {
  const h = shareHtmlHeaders(baseSecurityHeaders());
  assert.equal(h["x-frame-options"], "SAMEORIGIN");
  assert.match(h["content-security-policy"] ?? "", /frame-ancestors 'self'(?:;|$)/);
  assert.equal(h["content-type"], "text/html; charset=utf-8");
});

test("headers relaxed the way serveAppEditHtml relaxes them are refused", () => {
  const widened = baseSecurityHeaders();
  widened["content-security-policy"] = widened["content-security-policy"]!.replace(
    "frame-ancestors 'self'",
    "frame-ancestors 'self' slug.apps.example.com",
  );
  delete widened["x-frame-options"];
  assert.throws(() => shareHtmlHeaders(widened), /serveAppEditHtml/);

  const onlyCspWidened = baseSecurityHeaders();
  onlyCspWidened["content-security-policy"] = onlyCspWidened["content-security-policy"]!.replace(
    "frame-ancestors 'self'",
    "frame-ancestors *",
  );
  assert.throws(() => shareHtmlHeaders(onlyCspWidened), /frame-ancestors must remain/);

  const noXfo = baseSecurityHeaders();
  delete noXfo["x-frame-options"];
  assert.throws(() => assertNotFrameWidened(noXfo), /x-frame-options/);
});

// ---------------------------------------------------------------------------
// Attachment bytes: forced download, forced octet-stream, restrictive CSP.
// ---------------------------------------------------------------------------

test("an attachment can never be loaded back as a same-origin script", () => {
  const h = shareFileHeaders({ filename: "payload.js", contentLength: "2048" });
  // The upstream mimetype is discarded: text/javascript + nosniff would still
  // permit <script src="/api/public/shares/…/files/…">.
  assert.equal(h["content-type"], SHARE_FILE_CONTENT_TYPE);
  assert.equal(h["content-type"], "application/octet-stream");
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["content-security-policy"], SHARE_FILE_CSP);
  assert.match(h["content-security-policy"] ?? "", /default-src 'none'/);
  assert.match(h["content-security-policy"] ?? "", /(?:^|; )sandbox(?:;|$)/);
  assert.match(h["content-disposition"] ?? "", /^attachment;/);
  assert.equal(h["content-length"], "2048");
});

test("an html or svg attachment is never served inline", () => {
  for (const name of ["report.html", "diagram.svg", "index.xhtml"]) {
    const h = shareFileHeaders({ filename: name, contentLength: null });
    assert.equal(h["content-type"], "application/octet-stream");
    assert.match(h["content-disposition"] ?? "", /^attachment;/);
    assert.equal(h["content-length"], undefined);
  }
});

test("a hostile filename cannot inject a header or break the quoted string", () => {
  const nasty = 'e"vil\r\nset-cookie: a=b\\;/../x.js';
  const cd = contentDispositionAttachment(nasty);
  assert.ok(!cd.includes("\r"), cd);
  assert.ok(!cd.includes("\n"), cd);
  const quoted = /^attachment; filename="([^"]*)"/.exec(cd);
  assert.ok(quoted, cd);
  assert.ok(!quoted[1]!.includes("\\"), cd);
  assert.ok(!quoted[1]!.includes("/"), cd);
  assert.ok(!quoted[1]!.includes(";"), cd);
});

test("a unicode filename survives via filename*, with an ascii fallback", () => {
  const cd = contentDispositionAttachment("informe año — resumen.pdf");
  assert.match(cd, /^attachment; filename="[ -~]*"; filename\*=UTF-8''/);
  assert.match(cd, /filename\*=UTF-8''informe%20a%C3%B1o/);
});

test("a missing or empty filename falls back rather than emitting a bare attachment", () => {
  assert.equal(contentDispositionAttachment(null), 'attachment; filename="download"');
  assert.equal(contentDispositionAttachment(""), 'attachment; filename="download"');
  assert.equal(contentDispositionAttachment("   "), 'attachment; filename="download"');
  assert.match(contentDispositionAttachment("....."), /filename="download"/);
});

test("the upstream filename is read back and re-sanitised, never echoed", () => {
  assert.equal(filenameFromContentDisposition(null), null);
  assert.equal(filenameFromContentDisposition("attachment"), null);
  assert.equal(filenameFromContentDisposition('attachment; filename="notes.txt"'), "notes.txt");
  assert.equal(filenameFromContentDisposition("attachment; filename=notes.txt"), "notes.txt");
  assert.equal(
    filenameFromContentDisposition("attachment; filename=\"a.txt\"; filename*=UTF-8''informe%20a%C3%B1o.pdf"),
    "informe año.pdf",
  );
  // A hostile upstream disposition cannot reach the wire unchanged.
  const injected = filenameFromContentDisposition('attachment; filename="a\\"; set-cookie: x=y"');
  const cd = shareFileHeaders({ filename: injected, contentLength: null })["content-disposition"] ?? "";
  assert.match(cd, /^attachment; filename="/);
  const quoted = /^attachment; filename="([^"]*)"/.exec(cd);
  assert.ok(quoted, cd);
  // The quote and semicolon that would have ended the parameter are gone, so
  // the injected text can only survive as inert bytes inside the quoted string.
  assert.ok(!quoted[1]!.includes('"'), cd);
  assert.ok(!quoted[1]!.includes(";"), cd);
  assert.ok(!/[\r\n]/.test(cd), cd);
});

// ---------------------------------------------------------------------------
// The core query is built from scratch — an anonymous caller must never be able
// to smuggle a viewer/principal into it.
// ---------------------------------------------------------------------------

test("only a numeric sinceIndex cursor is forwarded", () => {
  assert.equal(shareCursorFrom(new URLSearchParams("")), null);
  assert.equal(shareCursorFrom(new URLSearchParams("sinceIndex=abc")), null);
  assert.equal(shareCursorFrom(new URLSearchParams("sinceIndex=-1")), null);
  assert.equal(shareCursorFrom(new URLSearchParams("sinceIndex=1e9")), null);
  assert.equal(shareCursorFrom(new URLSearchParams("sinceIndex=7")), 7);
});

test("the core path carries the share id and the cursor and nothing the caller appended", () => {
  const search = new URLSearchParams(`t=${"a".repeat(40)}&viewer=alice&principalId=alice&sinceIndex=4`);
  const p = shareTranscriptCorePath(ID, shareCursorFrom(search));
  assert.equal(p, `/v1/shares/${ID}?sinceIndex=4`);
  assert.ok(!p.includes("viewer"), p);
  assert.ok(!p.includes("principalId"), p);
  // The share id IS the secret; core mints no `?t=` capability token, so an
  // inbound one must not be laundered into the core request either.
  assert.ok(!p.includes("t="), p);

  const f = shareFileCorePath(ID, "scope:out:0");
  assert.equal(f, `/v1/shares/${ID}/files/scope%3Aout%3A0`);
  assert.ok(!f.includes("?"), f);
});

test("a share id or artifact id is always url-encoded into the core path", () => {
  assert.equal(shareTranscriptCorePath("a b&c=d", null), "/v1/shares/a%20b%26c%3Dd");
  assert.equal(shareFileCorePath("id", "a b&c=d"), "/v1/shares/id/files/a%20b%26c%3Dd");
});

// ---------------------------------------------------------------------------
// The share page CSP. A shared message must not beacon its anonymous readers.
// ---------------------------------------------------------------------------

test("the share page CSP forbids remote images, frames and cross-origin connections", () => {
  const csp = shareHtmlHeaders(baseSecurityHeaders())["content-security-policy"] ?? "";
  const directive = (name: string): string | undefined =>
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.toLowerCase().startsWith(`${name} `) || d.toLowerCase() === name);

  assert.equal(directive("img-src"), "img-src 'self' data:", "a remote <img> is a read receipt on every reader");
  assert.equal(directive("frame-src"), "frame-src 'none'");
  assert.equal(directive("connect-src"), "connect-src 'self'");
  assert.ok(!/img-src[^;]*https:/.test(csp), csp);
  assert.ok(!/frame-src[^;]*https:/.test(csp), csp);
  // Narrowing only: everything the SPA policy already restricted survives.
  assert.match(csp, /frame-ancestors 'self'(?:;|$)/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test("narrowShareCsp appends a missing directive rather than inheriting default-src", () => {
  const narrowed = narrowShareCsp("default-src 'self'; frame-ancestors 'self'");
  assert.match(narrowed, /img-src 'self' data:/);
  assert.match(narrowed, /frame-src 'none'/);
  assert.match(narrowed, /connect-src 'self'/);
  assert.match(narrowed, /default-src 'self'/);
});

// ---------------------------------------------------------------------------

test("robots.txt disallows the share surfaces", () => {
  assert.match(SHARE_ROBOTS_TXT, /^User-agent: \*$/m);
  assert.match(SHARE_ROBOTS_TXT, /^Disallow: \/share\/$/m);
  assert.match(SHARE_ROBOTS_TXT, /^Disallow: \/api\/public\/$/m);
  assert.equal(SHARE_ROBOTS_HEADERS["content-type"], "text/plain; charset=utf-8");
  assert.equal(SHARE_ROBOTS_HEADERS["x-content-type-options"], "nosniff");
});

// ---------------------------------------------------------------------------
// The wiring itself. A previous round delivered every load-bearing block as a
// line-number anchor with no code, and every unit test above still passed, so
// these assertions read the server source: helpers with no call site are the
// exact failure mode this feature keeps reaching for.
// ---------------------------------------------------------------------------

const SERVER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "web-ui", "server", "index.ts"),
  "utf8",
);

test("the web-ui server actually calls the share matcher, above the identity gate", () => {
  const matcherAt = SERVER.indexOf("matchSharePath(method, path)");
  const gateAt = SERVER.indexOf('if (path === "/me" || path.startsWith("/api/"))');
  assert.ok(matcherAt > 0, "matchSharePath has no call site — the share surfaces are unreachable");
  assert.ok(gateAt > 0);
  assert.ok(matcherAt < gateAt, "the share matcher must run BEFORE the identity gate or every reader gets a 401");
  assert.ok(SERVER.includes("serveShareHtml(req, res)"), "serveShareHtml has no call site");
  assert.ok(SERVER.includes("shareTranscriptCorePath("), "the transcript relay is not wired");
  assert.ok(SERVER.includes("shareFileCorePath("), "the file relay is not wired");
});

test("the share responses use the header builders, never relay()", () => {
  const block = SERVER.slice(
    SERVER.indexOf("const shareSurface = matchSharePath"),
    SERVER.indexOf('if (path === "/me" || path.startsWith("/api/"))'),
  );
  assert.ok(block.length > 0);
  assert.ok(!block.includes("relay(res"), "relay() hardcodes its headers and cannot carry no-store/vary");
  assert.ok(block.includes("shareJsonHeaders()"));
  assert.ok(block.includes("shareFileHeaders("));
});

test("the share page is served from the static index.html template, not serveAppEditHtml", () => {
  const fn = SERVER.slice(SERVER.indexOf("async function serveShareHtml"), SERVER.indexOf("const APPS_FRAME_DOMAIN"));
  assert.ok(fn.includes("shareHtmlHeaders(withSecurityHeaders({}))"));
  assert.ok(!fn.includes("removeHeader"), "serveShareHtml must not strip x-frame-options");
  assert.ok(!fn.includes("frame-ancestors"), "serveShareHtml must not rewrite frame-ancestors");
});

test("the share management relay sits above the /api/sessions/ prefix relay that would swallow it", () => {
  const manageAt = SERVER.indexOf("const shareManage = ");
  const prefixAt = SERVER.indexOf('if (method === "GET" && path.startsWith("/api/sessions/")) {');
  assert.ok(manageAt > 0, "/api/sessions/:id/share is not relayed — the strip and the dialog have no data source");
  assert.ok(prefixAt > 0);
  assert.ok(manageAt < prefixAt, "the prefix relay would otherwise answer GET /api/sessions/:id/share");
  const block = SERVER.slice(manageAt, prefixAt);
  assert.ok(block.includes("principalId: user"), "the mint must assert the authenticated user, never a client value");
});
