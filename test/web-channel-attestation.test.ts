import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import type { ProvisionOptions } from "../src/sandbox/sandbox.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { SHARED_SKILL_TRIGGER_REFUSAL } from "../src/api/artifact-share.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

function start(overrides: Partial<Config> = {}) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webattest-")), ...overrides }));
  const server = createInsecureTestServer(built.app, { capabilitySecret: TEST_CAPABILITY_SECRET });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    built,
    base,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await built.runtime.stop();
    },
  };
}

async function seed(s: ReturnType<typeof start>) {
  await s.built.app.upsertDirectory([
    { principalId: "alice@acme.test", displayName: "Alice", type: "internal" },
    { principalId: "bob@acme.test", displayName: "Bob", type: "internal" },
    { principalId: "UBOT1", displayName: "Deploybot", type: "internal" },
    { principalId: "mallory@acme.test", displayName: "Mallory", type: "internal" },
  ]);
  await s.built.app.upsertDirectory([
    { principalId: "alice@acme.test", displayName: "Alice", type: "internal" },
    { principalId: "bob@acme.test", displayName: "Bob", type: "internal" },
    { principalId: "UBOT1", displayName: "Deploybot", type: "internal" },
  ]);
  await s.built.app.upsertChannels(
    [
      { channelId: "C-PUB", name: "eng", isPrivate: false },
      { channelId: "C-PRIV", name: "sekrit", isPrivate: true },
      { channelId: "C-GUEST", name: "mixed", isPrivate: true },
      { channelId: "C-BOTS", name: "maria-tech-team", isPrivate: true },
    ],
    [
      { channelId: "C-PRIV", principalId: "alice@acme.test" },
      { channelId: "C-PRIV", principalId: "bob@acme.test" },
      { channelId: "C-GUEST", principalId: "alice@acme.test" },
      { channelId: "C-GUEST", principalId: "mallory@acme.test" },
      { channelId: "C-BOTS", principalId: "alice@acme.test" },
      { channelId: "C-BOTS", principalId: "UBOT1" },
    ],
  );
}

async function enqueuedWebTurn(
  s: ReturnType<typeof start>,
  actor: string,
  channelRef: string,
  threadRef: string,
): Promise<{ publishMembers?: Array<{ id: string; type: string }> }> {
  const res = await fetch(`${s.base}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      surface: "web",
      actor: { externalId: actor },
      conversation: { kind: "channel", threadRef, channelRef },
      text: "hi",
      liveActor: true,
      async: true,
    }),
  });
  assert.equal(res.status, 202);
  const { runId } = (await res.json()) as { runId: string };
  const run = await s.built.runs.get(runId);
  assert.ok(run, "the queued run is readable");
  return run!.request.conversation;
}

test("a web turn into a private all-internal channel carries the synced roster as publishMembers", async () => {
  const s = start();
  try {
    await seed(s);
    const conversation = await enqueuedWebTurn(s, "alice@acme.test", "C-PRIV", "web:alice@acme.test:t1");
    assert.deepEqual(
      conversation.publishMembers?.map((p) => ({ id: p.id, type: p.type })).sort((a, b) => (a.id < b.id ? -1 : 1)),
      [
        { id: "alice@acme.test", type: "internal" },
        { id: "bob@acme.test", type: "internal" },
      ],
      "the private-channel roster attests the audience so the orchestrator can stamp liveActor",
    );
    const bob = conversation.publishMembers?.find((p) => p.id === "bob@acme.test") as
      { displayName?: string } | undefined;
    assert.equal(bob?.displayName, "Bob", "roster members carry their directory display name, like the project path");
  } finally {
    await s.close();
  }
});

test("a web turn into a public channel leaves publishMembers unset", async () => {
  const s = start();
  try {
    await seed(s);
    const conversation = await enqueuedWebTurn(s, "bob@acme.test", "C-PUB", "web:bob@acme.test:t1");
    assert.equal(conversation.publishMembers, undefined, "no membership rows exist for public channels — fail closed");
  } finally {
    await s.close();
  }
});

test("a web turn into a private channel with a deactivated (guest) member leaves publishMembers unset", async () => {
  const s = start();
  try {
    await seed(s);
    const conversation = await enqueuedWebTurn(s, "alice@acme.test", "C-GUEST", "web:alice@acme.test:t2");
    assert.equal(conversation.publishMembers, undefined, "one non-internal roster member blocks attestation");
  } finally {
    await s.close();
  }
});

test("a driven web turn in an attested private channel mints a live-person capability that creates a shared skill; a public channel stays refused", async () => {
  const s = start({ signingSecret: "test-secret", apiBaseUrl: "https://core.example.com" });
  try {
    await seed(s);
    let captured: ProvisionOptions | undefined;
    const realProvision = s.built.sandbox.provision.bind(s.built.sandbox);
    s.built.sandbox.provision = (layers, opts) => {
      captured = opts;
      return realProvision(layers, opts);
    };

    const webTurn = (channelRef: string, threadRef: string) =>
      s.built.app.turn({
        surface: "web",
        actor: { externalId: "alice@acme.test" },
        conversation: { kind: "channel", threadRef, channelRef },
        text: "!run echo hi",
        liveActor: true,
      });

    assert.equal((await webTurn("C-PRIV", "web:alice@acme.test:e2e-priv")).status, "ok");
    const privToken = captured!.env!.AGENT_API_TOKEN!;
    const privClaims = await verifyCapabilityToken(privToken, TEST_CAPABILITY_SECRET);
    assert.equal(privClaims!.liveActor, true, "the attested roster lets the orchestrator stamp liveActor");
    const create = await fetch(`${s.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": privToken },
      body: JSON.stringify({ name: "from-web-channel", description: "d", body: "# b" }),
    });
    assert.equal(create.status, 201, "a person attested from the web UI may create a shared-channel skill");
    assert.ok(
      (await s.built.skills.list()).find((sk) => sk.manifest.name === "from-web-channel"),
      "the skill exists in the channel scope",
    );

    captured = undefined;
    assert.equal((await webTurn("C-PUB", "web:alice@acme.test:e2e-pub")).status, "ok");
    const pubToken = captured!.env!.AGENT_API_TOKEN!;
    const pubClaims = await verifyCapabilityToken(pubToken, TEST_CAPABILITY_SECRET);
    assert.equal(pubClaims!.liveActor, undefined, "a public channel stays unattested — fail closed");
    const refused = await fetch(`${s.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": pubToken },
      body: JSON.stringify({ name: "from-public-channel", description: "d", body: "# b" }),
    });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { message: string }).message, SHARED_SKILL_TRIGGER_REFUSAL);
  } finally {
    await s.close();
  }
});

test("a bot roster member classified internal does not block web attestation, matching the Slack surface", async () => {
  const s = start();
  try {
    await seed(s);
    const conversation = await enqueuedWebTurn(s, "alice@acme.test", "C-BOTS", "web:alice@acme.test:t3");
    assert.deepEqual(
      conversation.publishMembers?.map((p) => ({ id: p.id, type: p.type })).sort((a, b) => (a.id < b.id ? -1 : 1)),
      [
        { id: "UBOT1", type: "internal" },
        { id: "alice@acme.test", type: "internal" },
      ],
    );
  } finally {
    await s.close();
  }
});
