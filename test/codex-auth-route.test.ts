import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { codexAccountState } from "../src/model/codex-proxy.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const RESETS_AT = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
const LIMITED = JSON.stringify({
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    plan_type: "prolite",
    resets_at: RESETS_AT,
    limit_window_minutes: 10080,
    secret_detail: "not for the panel",
  },
});

async function withRoute(files: unknown[], run: (base: string) => Promise<void>) {
  const proxy = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/v0/management/auth-files" ? JSON.stringify({ files }) : "{}");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "codex-auth-route-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    codexProxy: { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, managementKey: "k" },
  });
  server.listen(0);
  try {
    await run(`http://localhost:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
}

test("the codex account list carries the plan and usage-limit reset but never the raw status message", async () => {
  await withRoute(
    [
      {
        name: "codex-a.json",
        provider: "codex",
        email: "ops@acme.test",
        status: "error",
        status_message: LIMITED,
        access_token: "tok",
      },
      { name: "codex-b.json", provider: "codex", status: "active", status_message: "" },
      { name: "codex-c.json", provider: "codex", status: "active", status_message: LIMITED },
      {
        name: "codex-d.json",
        provider: "codex",
        status: "error",
        status_message: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 1_000_000_000 } }),
      },
      { name: "gemini.json", provider: "gemini", status: "error", status_message: LIMITED },
    ],
    async (base) => {
      const response = await fetch(`${base}/v1/admin/codex-auth`, { headers: ADMIN });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /not for the panel|usage limit has been reached|tok"|status_message/);
      assert.deepEqual(JSON.parse(text), {
        accounts: [
          {
            name: "codex-a.json",
            email: "ops@acme.test",
            status: "error",
            disabled: false,
            plan: "prolite",
            usageLimit: { windowMinutes: 10080, resetsAt: RESETS_AT * 1000 },
          },
          { name: "codex-b.json", status: "active", disabled: false },
          { name: "codex-c.json", status: "active", disabled: false, plan: "prolite" },
          { name: "codex-d.json", status: "error", disabled: false },
        ],
      });
    },
  );
});

test("codexAccountState keeps only a known shape from the status message", () => {
  const now = Date.now();
  assert.deepEqual(codexAccountState(LIMITED, now), {
    planType: "prolite",
    limitReached: true,
    limitWindowMinutes: 10080,
    resetsAt: RESETS_AT * 1000,
  });
  assert.deepEqual(codexAccountState('{"error":{"resets_in_seconds":60}}', now), {
    limitReached: false,
    resetsAt: now + 60_000,
  });
  assert.deepEqual(
    codexAccountState(
      '{"error":{"type":"usage_limit_reached","plan_type":"<b>Pro</b>","limit_window_minutes":-1}}',
      now,
    ),
    { limitReached: true },
  );
  assert.deepEqual(codexAccountState('{"error":{"resets_at":1e13}}', now), {
    limitReached: false,
  });
  assert.deepEqual(codexAccountState("not json", now), { limitReached: false });
  assert.deepEqual(codexAccountState(undefined, now), { limitReached: false });
  assert.deepEqual(codexAccountState('{"error":"flat"}', now), { limitReached: false });
});
