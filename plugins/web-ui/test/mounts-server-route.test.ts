import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

/**
 * The /api/mounts proxy forwards only the verbs the mount API actually has.
 *
 * That allowlist is a boundary, not a formality: this proxy rewrites any
 * /api/mounts* path straight onto /v1/mounts*, so a verb it forwards is a verb
 * anyone can reach on core. Widening it for PATCH is worth pinning, as is the
 * fact that it still refuses everything else.
 */

interface Call {
  method: string;
  url: string;
  body: string;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", body: raw });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mount: { id: "m1", enabled: false } }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "mounts-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "mounts-web-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("a PATCH reaches core with its body intact", async () => {
  // Turning a folder off is the only thing that needs this verb, and it
  // carries the whole decision in its body — dropping it would silently
  // turn every request into a no-op.
  const before = calls.length;
  const r = await fetch(`${base}/api/mounts/m1`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(r.status, 200);

  const forwarded = calls.slice(before).find((c) => c.method === "PATCH");
  assert.ok(forwarded, "the PATCH was forwarded");
  assert.match(forwarded.url, /^\/v1\/mounts\/m1/);
  assert.deepEqual(JSON.parse(forwarded.body), { enabled: false });
});

test("verbs the mount API does not have are refused at the surface", async () => {
  for (const method of ["PUT", "HEAD", "OPTIONS"]) {
    const before = calls.length;
    const r = await fetch(`${base}/api/mounts/m1`, { method, headers });
    assert.equal(r.status, 405, `${method} should be refused`);
    assert.equal(calls.length, before, `${method} must not reach core`);
  }
});

test("the verbs the mount API does have still pass", async () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const before = calls.length;
    await fetch(`${base}/api/mounts/m1`, {
      method,
      headers,
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.ok(
      calls.slice(before).some((c) => c.method === method),
      `${method} should still reach core`,
    );
  }
});
