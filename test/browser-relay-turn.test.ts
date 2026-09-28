import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { BROWSER_RELAY_CDP_AUD } from "../src/browser-relay/server.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

const actor = { externalId: "U1" };

function relayApp() {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "relay-turn-")),
      signingSecret: "test-secret",
      apiBaseUrl: "https://core.example.com",
      relayPublicUrl: "https://relay.example.com",
    }),
  );
  let captured: ProvisionOptions | undefined;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (layers, opts) => {
    captured = opts;
    return provision(layers, opts);
  };
  for (const s of [scopeId("personal", "U1"), scopeId("channel", "C1")])
    built.config.setBrowserProvider(s, "extension");
  return { app: built.app, env: () => captured?.env ?? {} };
}

const dm = (extra: Partial<TurnRequest> = {}): TurnRequest => ({
  surface: "test",
  actor,
  conversation: { kind: "dm", threadRef: "dm:U1:relay" },
  text: "!run echo go",
  liveActor: true,
  ...extra,
});

test("a live DM turn gets a dedicated short-lived relay token, not its control-plane token", async () => {
  const { app, env } = relayApp();
  assert.equal((await app.turn(dm())).status, "ok");
  const url = new URL(env().QM_RELAY_URL!);
  assert.equal(url.origin, "wss://relay.example.com");
  assert.equal(url.pathname, "/v1/browser-relay/cdp");
  const token = url.searchParams.get("t")!;
  assert.notEqual(token, env().AGENT_API_TOKEN);
  const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.aud, BROWSER_RELAY_CDP_AUD);
  assert.equal(claims?.liveActor, true);
  assert.equal(claims?.scopeId, `personal:${claims?.actorId}`);
  assert.ok(claims!.exp - Date.now() <= 60 * 60_000);
});

test("channel and automated turns get no relay at all", async () => {
  const channel = relayApp();
  const result = await channel.app.turn({
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef: "ch:C1:relay", channelRef: "C1", audience: [actor] },
    text: "!run echo go",
    liveActor: true,
  });
  assert.equal(result.status, "ok");
  assert.ok(channel.env().AGENT_API_TOKEN);
  assert.equal(channel.env().QM_RELAY_URL, undefined);

  const cron = relayApp();
  assert.equal((await cron.app.turn(dm({ origin: { kind: "automation" }, triggered: true }))).status, "ok");
  assert.ok(cron.env().AGENT_API_TOKEN);
  assert.equal(cron.env().QM_RELAY_URL, undefined);
});
