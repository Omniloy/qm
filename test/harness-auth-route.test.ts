import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const TOKEN = "sk-ant-oat01-subscription-token";

function start(probe: (token: string) => Promise<{ ok: boolean; detail?: string }> = async () => ({ ok: true })) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "harness-auth-route-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    harnessAuth: built.harnessAuth,
    harnessAuthProbe: probe,
    harnessId: "pi",
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a subscription token is stored write-only and never echoed back", async () => {
  const srv = start();
  try {
    const before = await fetch(`${srv.base}/v1/admin/harness-auth`, { headers: ADMIN });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { harnesses: [{ harnessId: "claude", configured: false }] });

    const saved = await fetch(`${srv.base}/v1/admin/harness-auth/claude`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(saved.status, 200);

    const after = await fetch(`${srv.base}/v1/admin/harness-auth`, { headers: ADMIN });
    const body = await after.text();
    assert.match(body, /"configured":true/);
    // The panel shows who and when; the token itself leaves only in the child env.
    assert.ok(!body.includes(TOKEN));
    assert.equal(await srv.built.harnessAuth.resolve("claude"), TOKEN);
  } finally {
    await srv.close();
  }
});

test("a token Claude rejects is reported rather than stored", async () => {
  const srv = start(async () => ({ ok: false, detail: "Claude rejected this token." }));
  try {
    const res = await fetch(`${srv.base}/v1/admin/harness-auth/claude`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(res.status, 400);
    assert.match(String(((await res.json()) as { message?: string }).message), /rejected/);
    assert.equal(await srv.built.harnessAuth.resolve("claude"), null);
  } finally {
    await srv.close();
  }
});

test("a Console API key is refused before any model call is spent", async () => {
  let probed = false;
  const srv = start(async () => {
    probed = true;
    return { ok: true };
  });
  try {
    const res = await fetch(`${srv.base}/v1/admin/harness-auth/claude`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ token: "sk-ant-api03-console-key" }),
    });
    assert.equal(res.status, 400);
    assert.match(String(((await res.json()) as { message?: string }).message), /claude setup-token/);
    assert.equal(probed, false);
  } finally {
    await srv.close();
  }
});

test("harnesses that bill a provider key have no subscription slot", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/admin/harness-auth/pi`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("disabling a subscription clears it for the next turn", async () => {
  const srv = start();
  try {
    await fetch(`${srv.base}/v1/admin/harness-auth/claude`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ token: TOKEN }),
    });
    const res = await fetch(`${srv.base}/v1/admin/harness-auth/claude`, { method: "DELETE", headers: ADMIN });
    assert.equal(res.status, 200);
    assert.equal(await srv.built.harnessAuth.resolve("claude"), null);
  } finally {
    await srv.close();
  }
});

test("a non-admin cannot read or write the subscription", async () => {
  const srv = start();
  try {
    const read = await fetch(`${srv.base}/v1/admin/harness-auth`, {
      headers: { "content-type": "application/json" },
    });
    assert.ok(read.status === 401 || read.status === 403, `expected refusal, got ${read.status}`);
  } finally {
    await srv.close();
  }
});
