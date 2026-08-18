/**
 * The web-ui server's anonymous share surfaces, over real HTTP.
 *
 * The unit tests next door prove the matchers and header builders are right.
 * They proved exactly that in the previous round too, while every one of those
 * helpers had zero call sites and the feature did not exist. This file boots the
 * actual request handler against a fake core that records what it was asked for,
 * so the claims under test are the ones the wiring can get wrong:
 *
 *   - the three share paths answer WITHOUT a session, i.e. they really do sit
 *     above the identity gate, and everything else still 401s;
 *   - the core query is built from scratch — no viewer, no principalId, no `?t=`;
 *   - `x-portal-identity` IS forwarded to core when the portal minted one, which
 *     is the only way core can answer member or outsider rather than anonymous;
 *   - attachment bytes come back forced to a download regardless of what core
 *     said they were.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";

/** A share id in the shape the store mints: randomUUID() + randomUUID() with hyphens stripped. */
const ID = "b3f2c1a0-4d5e-4f6a-8b9c-0d1e2f3a4b5c" + "9f8e7d6c5b4a39281706f5e4d3c2b1a0";

interface CoreHit {
  method: string;
  url: string;
  identity: string | undefined;
}

const hits: CoreHit[] = [];
let nextCoreResponse: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
};

const core = createHttpServer((req, res) => {
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  hits.push({
    method: req.method ?? "",
    url: req.url ?? "",
    identity: Array.isArray(raw) ? raw[0] : raw,
  });
  req.resume();
  nextCoreResponse(req, res);
});
core.listen(0);

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "share-webui-server-signing-secret".repeat(2);
process.env.WEB_UI_PRINCIPALS = "";

const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const base = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

/** The last request the fake core saw, which is the thing worth asserting on. */
function lastHit(): CoreHit {
  const hit = hits.at(-1);
  assert.ok(hit, "core was never called");
  return hit;
}

function cspDirective(csp: string | null, name: string): string | undefined {
  return (csp ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.toLowerCase() === name || d.toLowerCase().startsWith(`${name} `));
}

// ---------------------------------------------------------------------------

test("the identity gate is still closed for everything that is not a share surface", async () => {
  for (const path of [
    "/me",
    "/api/sessions",
    `/api/public/shares`,
    `/api/public/shares/`,
    `/api/public/sessions/${ID}`,
  ])
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
});

test("an anonymous GET of the transcript reaches core rather than the 401", async () => {
  nextCoreResponse = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access: "anonymous", entries: [] }));
  };
  const r = await fetch(`${base}/api/public/shares/${ID}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { access: "anonymous", entries: [] });

  // Above the identity gate, and no credential invented on the way.
  assert.equal(lastHit().identity, undefined, "an anonymous reader must stay anonymous to core");
  assert.ok(lastHit().url.startsWith(`/v1/shares/${ID}`), lastHit().url);
});

test("core's refusal is relayed verbatim — a revoked link is a 404, not a 401", async () => {
  nextCoreResponse = (_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
  const r = await fetch(`${base}/api/public/shares/${ID}`);
  assert.equal(r.status, 404);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
});

test("the transcript response is unstoreable and varies by identity", async () => {
  nextCoreResponse = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=600" });
    res.end("{}");
  };
  const r = await fetch(`${base}/api/public/shares/${ID}`);
  // Core's header is NOT copied through — a cached 200 would outlive Unshare.
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.match(r.headers.get("vary") ?? "", /x-portal-identity/);
  assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("a signed-in reader's x-portal-identity IS forwarded, which is what makes member and outsider reachable", async () => {
  nextCoreResponse = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access: "member" }));
  };
  const r = await fetch(`${base}/api/public/shares/${ID}`, {
    headers: { [PORTAL_IDENTITY_HEADER]: "portal-identity-token-from-the-portal" },
  });
  assert.equal(r.status, 200);
  assert.equal(
    lastHit().identity,
    "portal-identity-token-from-the-portal",
    "without this core sees every reader as anonymous and two of the three access states are dead code",
  );
});

test("the core query is built from scratch: no viewer, no principalId, no capability token", async () => {
  nextCoreResponse = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  };
  await fetch(`${base}/api/public/shares/${ID}?viewer=alice&principalId=alice&t=stolen-token&sinceIndex=12&admin=1`);
  const url = lastHit().url;
  assert.ok(!url.includes("viewer"), url);
  assert.ok(!url.includes("principalId"), url);
  assert.ok(!url.includes("stolen-token"), url);
  assert.ok(!url.includes("admin"), url);
  assert.match(url, /sinceIndex=12/);

  await fetch(`${base}/api/public/shares/${ID}?sinceIndex=notanumber`);
  assert.ok(!lastHit().url.includes("sinceIndex"), lastHit().url);
});

test("an attachment is forced to a download no matter what core called it", async () => {
  nextCoreResponse = (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/javascript",
      "content-length": "5",
      "content-disposition": 'attachment; filename="payload.js"',
    });
    res.end("alert");
  };
  const r = await fetch(`${base}/api/public/shares/${ID}/files/scope-x:out:0`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "alert");
  assert.equal(
    r.headers.get("content-type"),
    "application/octet-stream",
    "text/javascript from the app origin is loadable through the SPA's script-src 'self'",
  );
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  // The artifact id is url-encoded into the path; the only query core sees is
  // the source-auth nonce coreFetch's signing helper appends.
  const url = lastHit().url;
  assert.ok(url.startsWith(`/v1/shares/${ID}/files/scope-x%3Aout%3A0`), url);
  assert.equal(url.split("?")[1]?.replace(/=.*/, ""), "_sourceAuthNonce", url);
});

test("a traversal in the artifact id never reaches core", async () => {
  const before = hits.length;
  for (const bad of ["..", "../../secrets", "a..b", "."]) {
    const r = await fetch(`${base}/api/public/shares/${ID}/files/${bad}`);
    assert.equal(r.status, 401, bad);
  }
  assert.equal(hits.length, before, "no core round-trip should have happened");
});

test("the share page renders anonymously, unindexed, and cannot beacon its readers", async () => {
  const r = await fetch(`${base}/share/${ID}`);
  assert.equal(r.status, 200, await r.text());
  assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(r.headers.get("cache-control") ?? "", /no-store/);
  assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);

  // Modelled on the static index.html branch, not serveAppEditHtml.
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  const csp = r.headers.get("content-security-policy");
  assert.equal(cspDirective(csp, "frame-ancestors"), "frame-ancestors 'self'");

  // Narrowed for untrusted content rendered to strangers.
  assert.equal(cspDirective(csp, "img-src"), "img-src 'self' data:");
  assert.equal(cspDirective(csp, "frame-src"), "frame-src 'none'");
  assert.equal(cspDirective(csp, "connect-src"), "connect-src 'self'");
});

test("only GET is anonymous; a write to a share path falls through to the gate", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await fetch(`${base}/api/public/shares/${ID}`, { method });
    assert.equal(r.status, 401, `${method} must not be anonymous`);
  }
});

test("robots.txt is served without a login bounce and disallows the share surfaces", async () => {
  const r = await fetch(`${base}/robots.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await r.text();
  assert.match(body, /^Disallow: \/share\/$/m);
  assert.match(body, /^Disallow: \/api\/public\/$/m);
});

test("the SPA bundle the share page pulls is not behind the identity gate on this hop either", async () => {
  // The portal now relays /assets/<file> anonymously (share-passthrough.ts), which is only
  // useful if web-ui answers it without a session. `serveStatic` sits below the gate but
  // outside it — a 404 here means "not built in this checkout", and anything but 401 means
  // the share page's <script> can load.
  for (const path of ["/assets/index-abc123.js", "/assets/index-abc123.css"]) {
    const r = await fetch(`${base}${path}`, { headers: { accept: "*/*" } });
    assert.notEqual(r.status, 401, `${path} must not need a session — the share page would render blank`);
  }
});
