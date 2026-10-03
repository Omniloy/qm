import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedFastModeAccess } from "../src/resolution/config-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { fastModeAllowed } from "../src/core/turn-options.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { Harness, HarnessTurnInput, RuntimeChoice } from "../src/harness/harness.ts";
import type { RuntimeControl } from "../src/harness/runtime-types.ts";
import { userPickerRuntimeConfig } from "../src/api/runtime-config.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createRuntimeService } from "../src/harness/runtime-control.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import type { RosterPerson } from "../src/directory/person.ts";
import type { ScopeId } from "../src/types.ts";

const ORG = "org:default-org" as ScopeId;
const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

async function directory() {
  const store = createDirectoryStore();
  await store.replace([
    { principalId: "carol@acme.com", displayName: "Carol", type: "internal", slackId: "U999" },
    { principalId: "dave@acme.com", displayName: "Dave", type: "internal" },
  ]);
  return store;
}

test("fast-mode access defaults to everyone and persists across instances", async () => {
  const fastModeAccess = createMemoryMap<PersistedFastModeAccess>();
  const first = createMemoryConfigStore("default-org", { fastModeAccess });
  assert.equal(await first.getFastModeAccess(), null);
  await first.setFastModeAccess(["Carol@Acme.com", "carol@acme.com", "U123", " "]);
  const second = createMemoryConfigStore("default-org", { fastModeAccess });
  assert.deepEqual(await second.getFastModeAccess(), ["carol@acme.com", "U123"]);
  await second.setFastModeAccess(null);
  assert.equal(await first.getFastModeAccess(), null);
});

test("only listed people pass, matched through the directory, and a missing actor never does", async () => {
  const config = createMemoryConfigStore("default-org");
  const people = await directory();
  assert.equal(await fastModeAllowed(config, people, undefined), true);
  await config.setFastModeAccess(["U999", "erin@acme.com"]);
  assert.equal(await fastModeAllowed(config, people, "carol@acme.com"), true);
  assert.equal(await fastModeAllowed(config, people, "ERIN@acme.com"), true);
  assert.equal(await fastModeAllowed(config, people, "dave@acme.com"), false);
  assert.equal(await fastModeAllowed(config, people, undefined), false);
  assert.equal(await fastModeAllowed(config, undefined, "erin@acme.com"), true);
});

test("an actor without a directory row costs one lookup per listed person", async () => {
  const config = createMemoryConfigStore("default-org");
  await config.setFastModeAccess(["a@acme.com", "b@acme.com", "carol@acme.com"]);
  const people = await directory();
  const looked: string[] = [];
  const counting = {
    get: (id: string): Promise<RosterPerson | null> => {
      looked.push(id);
      return people.get(id);
    },
  };
  assert.equal(await fastModeAllowed(config, counting, "U999"), true);
  assert.equal(looked.length, 4);
  looked.length = 0;
  assert.equal(await fastModeAllowed(config, counting, "U404"), false);
  assert.equal(looked.length, 4);
});

function capturingRouter(resolved: RuntimeChoice, allowed: (actorId: string | undefined) => Promise<boolean>) {
  const calls: HarnessTurnInput[] = [];
  const mock = createMockHarness();
  const adapter: Harness = {
    ...mock,
    profile: { ...mock.profile, capabilities: new Set(["goal-enforcement"]) },
    turns: {
      async runTurn(turn) {
        calls.push(turn);
        return { reply: "ok" };
      },
    },
  };
  const router = createHarnessRouter(new Map([["pi", adapter]]), mock, async () => resolved, allowed);
  const run = (extra: Partial<HarnessTurnInput>) =>
    router.turns.runTurn({
      session: { id: "s1" },
      input: "hi",
      systemPrompt: "",
      history: [],
      tools: {},
      scopeLabel: "personal:x" as ScopeId,
      orgScopeId: ORG,
      emit: async () => ({}),
      recordModelCall() {},
      ...extra,
    } as unknown as HarnessTurnInput);
  return { calls, run };
}

test("the router downgrades fast mode for anyone not allowed, on every turn kind, without failing", async () => {
  const config = createMemoryConfigStore("default-org");
  const people = await directory();
  await config.setFastModeAccess(["carol@acme.com"]);
  const fast: RuntimeChoice = { harnessId: "pi", modelId: "claude-opus-5-5", effortLevel: "high", fastMode: true };
  const { calls, run } = capturingRouter(fast, (actorId) => fastModeAllowed(config, people, actorId));
  const seen: RuntimeChoice[] = [];
  const runtimeControl: RuntimeControl = async (active) => {
    seen.push(active);
    return { ok: false, error: "runtime_unavailable" };
  };

  assert.deepEqual((await run({ runtimeActorId: "carol@acme.com" })).reply, "ok");
  await run({ runtimeActorId: "dave@acme.com", runtime: { fastMode: true }, runtimeControl });
  await run({ runtimeActorId: "dave@acme.com", runtimePurpose: "cron" });
  await run({ runtimeActorId: "dave@acme.com", runtimePurpose: "subagent" });
  await run({ runtimePurpose: "cron" });
  assert.deepEqual(
    calls.map((call) => call.runtime?.fastMode),
    [true, false, false, false, false],
  );
  assert.deepEqual(calls[1]!.runtime, { ...fast, fastMode: false });
  await calls[1]!.tools.runtime!({ action: "get" });
  assert.equal(seen[0]?.fastMode, false);

  await config.setFastModeAccess(null);
  await run({ runtimeActorId: "dave@acme.com", runtimePurpose: "cron" });
  assert.equal(calls.at(-1)!.runtime?.fastMode, true);
});

test("turns billed to the person's own account keep fast mode despite the access list", async () => {
  const config = createMemoryConfigStore("default-org");
  const people = await directory();
  await config.setFastModeAccess(["carol@acme.com"]);
  const fast: RuntimeChoice = { harnessId: "pi", modelId: "gpt-6-astra", effortLevel: "high", fastMode: true };
  const { calls, run } = capturingRouter(fast, (actorId) => fastModeAllowed(config, people, actorId));
  await run({ runtimeActorId: "dave@acme.com", providerKeys: { openai: "sk-own" } });
  await run({ runtimeActorId: "dave@acme.com", claudeOauthToken: "own-token" });
  await run({
    runtimeActorId: "dave@acme.com",
    codexAuth: { accessToken: "a", idToken: "i" },
  } as Partial<HarnessTurnInput>);
  await run({ runtimeActorId: "dave@acme.com" });
  assert.deepEqual(
    calls.map((call) => call.runtime?.fastMode),
    [true, true, true, false],
  );
});

test("restricted people cannot save fast mode into a shared scope through the runtime tool", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi"]);
  await config.flushScope(ORG);
  const people = await directory();
  await config.setFastModeAccess(["carol@acme.com"]);
  const service = createRuntimeService(
    { config, directory: people, harnessId: "pi", baseModelDefault: "claude-opus-5-5" },
    { authorizesCapabilityScope: async () => true },
  );
  const active: RuntimeChoice = { harnessId: "pi", modelId: "claude-opus-5-5", effortLevel: "high", fastMode: false };
  const setFast = async (actorId: string, scopeId: ScopeId) => {
    const claims = { actorId, scopeId, liveActor: true, exp: Date.now() + 60_000 };
    assert.equal((await service(claims, active, { action: "set", fastMode: true, lifetime: "scope" })).ok, true);
    return (await config.getRuntimeSelectionDurable(scopeId))?.fastMode;
  };
  assert.equal(await setFast("dave@acme.com", "channel:C1" as ScopeId), false);
  assert.equal(await setFast("carol@acme.com", "channel:C2" as ScopeId), true);
  assert.equal(await setFast("dave@acme.com", "personal:dave@acme.com" as ScopeId), true);
});

test("restricted people cannot save fast mode into a shared scope through the picker", async () => {
  const secret = "fast-mode-capability-secret";
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "fast-mode-put-")), capabilitySecret: secret, seedSkills: false }),
  );
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope(ORG);
  await built.directory.replace([{ principalId: "carol@acme.com", displayName: "Carol", type: "internal" }]);
  await built.directory.replaceGroups([
    { groupId: "C1", principalId: "dave@acme.com" },
    { groupId: "C2", principalId: "carol@acme.com" },
  ]);
  await built.config.setFastModeAccess(["carol@acme.com"]);
  const server = createInsecureTestServer(built.app, {
    capabilitySecret: secret,
    config: built.config,
    directory: built.directory,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const put = async (actorId: string, scopeId: string) => {
    const cap = await mintCapabilityToken(
      { actorId, scopeId, aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS, liveActor: true } as never,
      secret,
    );
    const res = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify({ harnessId: "pi", modelId: "claude-opus-5-5", fastMode: true }),
    });
    assert.equal(res.status, 200);
    return (await built.config.getRuntimeSelectionDurable(scopeId as ScopeId))?.fastMode;
  };
  try {
    assert.equal(await put("dave@acme.com", "group:C1"), false);
    assert.equal(await put("carol@acme.com", "group:C2"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the picker keeps fast mode for models billed to a restricted person's own account", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "fast-mode-personal-")) }));
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope(ORG);
  await built.config.setFastModeAccess(["carol@acme.com"]);
  await built.userModelCredentials.setApiKey("dave@acme.com", "openai", "synthetic-openai");
  await built.config.setModelAccountModes({ anthropic: "org", openai: "personal" });
  await built.config.setPersonalModelAuth("dave@acme.com", true, "openai");
  const ctx = {
    deps: {
      config: built.config,
      directory: built.directory,
      userModelCredentials: built.userModelCredentials,
      harnessId: "pi",
    },
  };
  const scope = "personal:dave@acme.com" as ScopeId;
  const personal = await userPickerRuntimeConfig(ctx, scope, "dave@acme.com");
  assert.equal("fastModeRestricted" in personal, false);
  assert.ok(personal.fastModeModelIds.includes("gpt-6-astra"));
  assert.equal(personal.fastModeModelIds.includes("claude-opus-5-5"), false);
  const company = await userPickerRuntimeConfig(ctx, scope, "dave@acme.com", true);
  assert.equal((company as { fastModeRestricted?: boolean }).fastModeRestricted, true);
  assert.deepEqual(company.fastModeModelIds, []);
});

test("the picker hides fast mode, with a reason, from people who may not use it", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi"]);
  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-5-5", fastMode: true });
  config.setInteractiveFastMode(true);
  await config.flushScope(ORG);
  const people = await directory();
  const ctx = { deps: { config, directory: people, harnessId: "pi" } };
  const everyone = await userPickerRuntimeConfig(ctx, "personal:dave@acme.com" as ScopeId, "dave@acme.com");
  assert.ok(everyone.fastModeModelIds.includes("claude-opus-5-5"));
  assert.equal(everyone.effective.fastMode, true);
  assert.equal("fastModeRestricted" in everyone, false);

  await config.setFastModeAccess(["carol@acme.com"]);
  for (const companyOnly of [false, true]) {
    const dave = await userPickerRuntimeConfig(ctx, "personal:dave@acme.com" as ScopeId, "dave@acme.com", companyOnly);
    assert.deepEqual(dave.fastModeModelIds, []);
    assert.equal(dave.effective.fastMode, false);
    assert.equal(dave.interactiveFastMode, false);
    assert.equal((dave as { fastModeRestricted?: boolean }).fastModeRestricted, true);
  }
  const carol = await userPickerRuntimeConfig(ctx, "personal:carol@acme.com" as ScopeId, "carol@acme.com");
  assert.ok(carol.fastModeModelIds.includes("claude-opus-5-5"));
  assert.equal(carol.effective.fastMode, true);
});

test("org admins read and write fast-mode access through the Models settings", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "fast-mode-access-")) }));
  await built.directory.replace([{ principalId: "carol@acme.com", displayName: "Carol", type: "internal" }]);
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    directory: built.directory,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}/v1/admin/scopes`;
  const put = (body: unknown, scope = ORG, headers = ADMIN) =>
    fetch(`${base}/${scope}/fast-mode-access`, { method: "PUT", headers, body: JSON.stringify(body) });
  const read = async () =>
    ((await (await fetch(`${base}/${ORG}?view=models`, { headers: ADMIN })).json()) as { fastModeAccess: unknown })
      .fastModeAccess;
  try {
    assert.deepEqual(await read(), {
      people: null,
      directory: [{ principalId: "carol@acme.com", displayName: "Carol" }],
    });
    for (const body of [{ people: [] }, { people: "carol" }, { people: ["a b"] }, { people: [1] }, {}])
      assert.equal((await put(body)).status, 400, JSON.stringify(body));
    assert.equal((await put({ people: ["carol@acme.com"] }, "personal:carol@acme.com" as ScopeId)).status, 400);
    assert.equal(
      (await put({ people: ["carol@acme.com"] }, ORG, { ...ADMIN, "x-admin-actor": "nobody@default-org" })).status,
      403,
    );
    assert.equal((await put({ people: [" Carol@Acme.com ", "U123"] })).status, 200);
    assert.deepEqual(await built.config.getFastModeAccess(), ["carol@acme.com", "U123"]);
    assert.deepEqual(((await read()) as { people: string[] }).people, ["carol@acme.com", "U123"]);
    assert.equal((await put({ people: null })).status, 200);
    assert.equal(await built.config.getFastModeAccess(), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
