import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createMemoryReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { createMemoryPortalSessions } from "../src/auth/portal-sessions.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "portal-sessions-test-secret".repeat(2);
const SID = "a".repeat(43);

test("memory portal sessions lease one refresh at a time and settle by lease", async () => {
  let now = 1_000_000;
  const store = createMemoryPortalSessions(() => now);
  await store.start(SID, { principal: "ana@laberit.com", refreshToken: "rt-1", expiresAtMs: now + 86_400_000 });
  assert.equal((await store.claim(SID, 60_000, 30_000)).state, "current");
  now += 120_000;
  const first = await store.claim(SID, 60_000, 30_000);
  assert.equal(first.state, "claimed");
  assert.equal(first.state === "claimed" && first.refreshToken, "rt-1");
  assert.equal((await store.claim(SID, 60_000, 30_000)).state, "busy");
  assert.equal(await store.settle(SID, "not-the-lease", { kind: "unavailable" }), false);
  const lease = first.state === "claimed" ? first.lease : "";
  assert.equal(
    await store.settle(SID, lease, { kind: "rotated", refreshToken: "rt-2", expiresAtMs: now + 86_400_000 }),
    true,
  );
  assert.equal(await store.settle(SID, lease, { kind: "unavailable" }), false);
  assert.equal((await store.claim(SID, 60_000, 30_000)).state, "current");
  now += 120_000;
  const second = await store.claim(SID, 60_000, 30_000);
  assert.equal(second.state === "claimed" && second.refreshToken, "rt-2");
  now += 31_000;
  const afterCrash = await store.claim(SID, 60_000, 30_000);
  assert.equal(afterCrash.state, "claimed");
  assert.equal(
    await store.settle(SID, afterCrash.state === "claimed" ? afterCrash.lease : "", { kind: "revoked" }),
    true,
  );
  assert.equal((await store.claim(SID, 60_000, 30_000)).state, "missing");
  assert.equal(await store.active(SID), false);
});

test("memory portal sessions expire at the MS-AUTH cap and end returns the token once", async () => {
  let now = 1_000_000;
  const store = createMemoryPortalSessions(() => now);
  await store.start(SID, { principal: "ana@laberit.com", refreshToken: "rt-1", expiresAtMs: now + 1000 });
  assert.equal(await store.active(SID), true);
  assert.equal(await store.end(SID), "rt-1");
  assert.equal(await store.end(SID), null);
  await store.start(SID, { principal: "ana@laberit.com", refreshToken: "rt-1", expiresAtMs: now + 1000 });
  now += 1000;
  assert.equal(await store.active(SID), false);
  assert.equal((await store.claim(SID, 0, 30_000)).state, "missing");
  assert.equal(await store.end(SID), null);
});

function start(): { base: string; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "portal-sessions-")), orgId: "acme" }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: createMemoryReplayDedupe(),
    portalSessions: createMemoryPortalSessions(),
    requireSignedPortalIdentity: true,
    portalIdentitySecret: SECRET + "identity",
    capabilitySecret: SECRET + "capability",
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function call(base: string, action: string, body: unknown, sign = true) {
  const path = `/v1/auth/portal-sessions${action}?nonce=${crypto.randomUUID()}`;
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sign) {
    headers["x-timestamp"] = String(ts);
    headers["x-signature"] = signRequest(SECRET, ts, `POST\n${path}\n${raw}`);
  }
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: raw });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("portal-session routes need a signed caller and validate their input", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const grant = {
    sessionId: SID,
    principal: "ana@laberit.com",
    refreshToken: "rt-1",
    expiresAtMs: Date.now() + 60_000,
  };
  assert.equal((await call(srv.base, "", grant, false)).status, 401);
  assert.equal((await call(srv.base, "", { ...grant, sessionId: "short" })).status, 400);
  assert.equal((await call(srv.base, "", { ...grant, expiresAtMs: Date.now() - 1 })).status, 400);
  assert.equal((await call(srv.base, "", { ...grant, refreshToken: "" })).status, 400);
  assert.equal((await call(srv.base, "/claim", { sessionId: SID, staleAfterMs: 0, leaseMs: 10 })).status, 400);
  assert.equal((await call(srv.base, "/settle", { sessionId: SID, lease: "x", outcome: "bogus" })).status, 400);
});

test("portal-session routes start, claim, settle, and end a session", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const grant = {
    sessionId: SID,
    principal: "ana@laberit.com",
    refreshToken: "rt-1",
    expiresAtMs: Date.now() + 60_000,
  };
  assert.deepEqual((await call(srv.base, "", grant)).json, { ok: true });
  const claimed = await call(srv.base, "/claim", { sessionId: SID, staleAfterMs: 0, leaseMs: 30_000 });
  assert.equal(claimed.json.state, "claimed");
  assert.equal(claimed.json.refreshToken, "rt-1");
  assert.equal(claimed.json.principal, "ana@laberit.com");
  const busy = await call(srv.base, "/claim", { sessionId: SID, staleAfterMs: 0, leaseMs: 30_000 });
  assert.equal(busy.json.state, "busy");
  assert.equal(busy.json.refreshToken, undefined);
  const settled = await call(srv.base, "/settle", {
    sessionId: SID,
    lease: claimed.json.lease,
    outcome: "rotated",
    refreshToken: "rt-2",
    expiresAtMs: Date.now() + 60_000,
  });
  assert.deepEqual(settled.json, { settled: true });
  assert.deepEqual((await call(srv.base, "/end", { sessionId: SID })).json, { refreshToken: "rt-2" });
  assert.equal(
    (await call(srv.base, "/claim", { sessionId: SID, staleAfterMs: 0, leaseMs: 30_000 })).json.state,
    "missing",
  );
});
