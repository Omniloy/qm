import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as piHarness from "../src/harness/pi-harness.ts";
import * as mockHarness from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { defaultModelForHarness, resolveModel } from "../src/model/pi-models.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { testConfig } from "./support/test-config.ts";

const turns: HarnessTurnInput[] = [];
let personalRejection: string | null = null;
let rejectAfterUserEntry = false;
function observedHarness() {
  const harness = mockHarness.createMockHarness();
  const runTurn = harness.turns.runTurn;
  harness.turns.runTurn = async (turn) => {
    turns.push(turn);
    if (personalRejection && JSON.stringify(turn.providerKeys ?? {}).includes("personal-")) {
      if (rejectAfterUserEntry)
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
      throw new NonRetryableTurnError(personalRejection);
    }
    return runTurn(turn);
  };
  return harness;
}

mock.module("../src/harness/pi-harness.ts", {
  namedExports: { ...piHarness, createPiHarness: observedHarness },
});
mock.module("../src/harness/mock-harness.ts", {
  namedExports: { ...mockHarness, createMockHarness: observedHarness },
});
const { buildApp } = await import("../src/wiring.ts");

for (const provider of ["anthropic", "openai"] as const) {
  test(`queued personal ${provider} turns use only that provider's credentials after switching to company`, async () => {
    turns.length = 0;
    const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
    await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
    await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
    await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
    await built.config.setPersonalModelAuth("U1", true, provider);
    const submitted = await built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `execute-personal-${provider}` },
      text: "hello",
      liveActor: true,
      async: true,
    });
    await built.config.setPersonalModelAuth("U1", false);
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0]!.providerKeys, { [provider]: `personal-${provider}` });
      assert.equal(resolveModel(turns[0]!.runtime!.modelId!)?.provider, provider);
      assert.equal(turns[0]!.runtime!.harnessId, "pi");
    } finally {
      await built.runtime.stop();
    }
  });
}

test("disconnecting a queued personal account fails without invoking any main harness or another connected provider", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "execute-disconnected-personal" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  await built.userModelCredentials.delete("U1", "openai");
  await built.config.setPersonalModelAuth("U1", false);
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "failed");
    assert.match(JSON.stringify(finished), /personal AI account is unavailable/);
    assert.equal(turns.length, 0);
  } finally {
    await built.runtime.stop();
  }
});

async function disconnectedTurn(fallbackWhenUnavailable: boolean, companyKeys: boolean) {
  turns.length = 0;
  const built = buildApp(
    testConfig({
      harness: "pi",
      ...(companyKeys ? { anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" } : {}),
    }),
  );
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal", fallbackWhenUnavailable });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: `execute-fallback-${crypto.randomUUID()}` },
    text: "hello",
    liveActor: true,
    async: true,
  });
  await built.userModelCredentials.delete("U1", "openai");
  built.runtime.start();
  try {
    return await built.runs.waitFor(submitted.runId!, 5_000);
  } finally {
    await built.runtime.stop();
  }
}

test("an unavailable personal account runs the turn on the org account when the org allows that fallback", async () => {
  const finished = await disconnectedTurn(true, true);
  assert.equal(finished.status, "done", JSON.stringify(finished.result));
  assert.equal(turns.length, 1);
  assert.ok(!JSON.stringify(turns[0]!.providerKeys ?? {}).includes("personal-"));
});

test("the unavailable fallback stays closed when the org has no account for the provider", async () => {
  const finished = await disconnectedTurn(true, false);
  assert.equal(finished.status, "failed");
  assert.match(JSON.stringify(finished), /personal AI account is unavailable/);
  assert.equal(turns.length, 0);
});

async function rejectedTurn(
  fallbackWhenRejected: boolean,
  rejection: string,
  options: { afterUserEntry?: boolean; companyKeys?: Record<string, string>; orgModel?: string } = {},
) {
  turns.length = 0;
  personalRejection = rejection;
  rejectAfterUserEntry = options.afterUserEntry === true;
  const built = buildApp(
    testConfig({
      harness: "pi",
      ...(options.companyKeys ?? { anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }),
    }),
  );
  if (options.orgModel)
    await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "pi", modelId: options.orgModel });
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal", fallbackWhenRejected });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const threadRef = `execute-rejected-${crypto.randomUUID()}`;
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "hello",
    liveActor: true,
    async: true,
  });
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    const session = await built.sessions.getByThread(threadRef);
    const entries = session ? await built.sessions.getEntries(session.id) : [];
    const users = entries
      .filter((entry) => entry.type === "user")
      .map((entry) => (entry.payload as { text?: string }).text);
    return { finished, users };
  } finally {
    personalRejection = null;
    rejectAfterUserEntry = false;
    await built.runtime.stop();
  }
}

for (const rejection of [
  "Model provider API error (authentication_error): invalid x-api-key",
  "Claude API error (429): You've hit your usage limit",
]) {
  test(`a personal account rejected before the user entry lands reruns the original turn on the org account: ${rejection}`, async () => {
    const { finished, users } = await rejectedTurn(true, rejection);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0]!.providerKeys, { anthropic: "personal-anthropic" });
    assert.ok(!JSON.stringify(turns[1]!.providerKeys ?? {}).includes("personal-"));
    assert.equal(turns[1]!.input, turns[0]!.input);
    assert.ok(
      users.some((text) => text?.includes("hello")),
      JSON.stringify(users),
    );
    assert.ok(!users.some((text) => text?.includes("organization's AI account")), JSON.stringify(users));
  });
}

test("a personal account rejected after the user entry lands continues on the org account from the transcript", async () => {
  const { finished, users } = await rejectedTurn(
    true,
    "Model provider API error (authentication_error): invalid x-api-key",
    { afterUserEntry: true },
  );
  assert.equal(finished.status, "done", JSON.stringify(finished.result));
  assert.equal(turns.length, 2);
  assert.match(turns[1]!.input, /organization's AI account/);
  assert.doesNotMatch(turns[1]!.input, /Current request/);
  assert.equal(users.filter((text) => text?.includes("hello")).length, 1, JSON.stringify(users));
});

test("the rejected fallback checks and runs the same org runtime, not the personal model", async () => {
  const { finished } = await rejectedTurn(true, "Claude API error (401): invalid x-api-key", {
    companyKeys: { openaiApiKey: "company-openai" },
    orgModel: "gpt-6-astra",
  });
  assert.equal(finished.status, "done", JSON.stringify(finished.result));
  assert.equal(turns.length, 2);
  assert.equal(resolveModel(turns[0]!.runtime!.modelId!)?.provider, "anthropic");
  assert.equal(turns[1]!.runtime?.modelId, "gpt-6-astra");
  assert.ok(!JSON.stringify(turns[1]!.providerKeys ?? {}).includes("personal-"));
});

test("the rejected fallback stays closed when the org has no credential for the provider", async () => {
  const { finished } = await rejectedTurn(true, "Claude API error (401): invalid x-api-key", { companyKeys: {} });
  assert.equal(finished.status, "failed");
  assert.equal(turns.length, 1);
});

test("a rejected personal account fails the turn when the rejection fallback is off", async () => {
  const { finished } = await rejectedTurn(false, "Model provider API error (authentication_error): invalid x-api-key");
  assert.equal(finished.status, "failed");
  assert.equal(turns.length, 1);
});

test("errors that are not credential rejections never move a personal turn to the org account", async () => {
  const { finished } = await rejectedTurn(true, "Model provider API error (invalid_request_error): prompt is too long");
  assert.equal(finished.status, "failed");
  assert.equal(turns.length, 1);
});

for (const account of ["personal", "openai", "anthropic"] as const) {
  test(`web ${account} account honors the chosen model, effort and fast mode`, async () => {
    turns.length = 0;
    const provider = account === "anthropic" ? "anthropic" : "openai";
    const model = provider === "anthropic" ? "claude-sonnet-5-5" : "gpt-6-astra";
    const built = buildApp(testConfig({ openaiApiKey: "company-openai" }));
    built.config.setApprovedHarnesses(["pi"]);
    await built.config.flushScope("org:default-org");
    await built.userModelCredentials.setApiKey("U1", provider, `personal-${provider}`);
    await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
    await built.config.setPersonalModelAuth("U1", true, account === "personal" ? undefined : account);
    const submitted = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:picker-${account}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
      harness: "pi",
      thinkingLevel: "high",
      fastMode: true,
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const queued = await built.runs.get(submitted.runId!);
    assert.equal(queued?.request.model, model);
    assert.equal(queued?.request.harness, "pi");
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0]!.providerKeys, { [provider]: `personal-${provider}` });
      assert.deepEqual(turns[0]!.runtime, {
        harnessId: "pi",
        modelId: model,
        effortLevel: "high",
        fastMode: true,
      });
    } finally {
      await built.runtime.stop();
    }
  });
}

test("mixed provider modes run Claude on the personal key and ChatGPT on the org account", async () => {
  const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "org" });
  await built.config.setPersonalModelAuth("U1", true);
  const run = async (surface: "web" | "slack", model: string) => {
    turns.length = 0;
    const submitted = await built.app.turn({
      surface,
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `${surface === "web" ? "web:U1:" : ""}mixed-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
      harness: "pi",
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    return turns[0]!;
  };
  built.runtime.start();
  try {
    const claude = await run("web", "claude-sonnet-5-5");
    assert.deepEqual(claude.providerKeys, { anthropic: "personal-anthropic" });
    assert.equal(claude.runtime?.modelId, "claude-sonnet-5-5");
    const chatgpt = await run("web", "gpt-6-astra");
    assert.notDeepEqual(chatgpt.providerKeys, { openai: "personal-openai" });
    assert.ok(!JSON.stringify(chatgpt.providerKeys ?? {}).includes("personal-"));
    assert.equal(chatgpt.runtime?.modelId, "gpt-6-astra");
    const slack = await run("slack", "gpt-6-astra");
    assert.deepEqual(slack.providerKeys, { anthropic: "personal-anthropic" });
    await built.config.setModelAccountPolicy({ anthropic: "org", openai: "org" });
    const company = await run("slack", "gpt-6-astra");
    assert.ok(!JSON.stringify(company.providerKeys ?? {}).includes("personal-"));
    assert.equal(await built.userModelCredentials.get("U1", "anthropic").then((c) => c?.apiKey), "personal-anthropic");
  } finally {
    await built.runtime.stop();
  }
});

test("personal web selections reject wrong providers, harnesses, policy exclusions and disconnected keys", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "company-openai", anthropicApiKey: "company-anthropic" }));
  built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (model: string, harness = "pi") =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:invalid-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
      harness,
    });
  for (const [model, harness] of [
    ["claude-sonnet-5-5", "pi"],
    ["gpt-6-astra", "claude"],
    ["unknown", "pi"],
  ])
    assert.equal((await submit(model!, harness!)).status, "refused");
  built.config.setWebuiModels("org:default-org", ["gpt-6.1-sol"]);
  await built.config.flushScope("org:default-org");
  assert.equal((await submit("gpt-6-astra")).status, "refused");
  await built.userModelCredentials.delete("U1", "openai");
  assert.equal((await submit("gpt-6.1-sol")).status, "refused");
});

test("a queued web selection cannot fall back to another personal provider after disconnect", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true);
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:disconnect-after-pick" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "gpt-6-astra",
    harness: "pi",
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  await built.userModelCredentials.delete("U1", "openai");
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "failed");
    assert.match(JSON.stringify(finished), /cannot serve this model/);
    assert.equal(turns.length, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("web subscription selections use the namespaced model and personal OAuth on Pi", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:oauth-picker" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "codex/gpt-6-astra",
    harness: "pi",
    thinkingLevel: "high",
    fastMode: false,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.providerKeys, { "openai-codex": "personal-oauth" });
    assert.deepEqual(turns[0]!.runtime, {
      harnessId: "pi",
      modelId: "codex/gpt-6-astra",
      effortLevel: "high",
      fastMode: false,
    });
  } finally {
    await built.runtime.stop();
  }
});

test("partial personal web choices queue the complete validated scoped runtime", async () => {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "codex"]);
  await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "pi", modelId: "gpt-6.1-sol" });
  await built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "pi", modelId: "gpt-6-astra" });
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (choice: { harness?: string; model?: string }) =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:partial-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      ...choice,
    });
  const first = await submit({ harness: "pi" });
  assert.ok(first.runId, JSON.stringify(first));
  const queued = await built.runs.get(first.runId!);
  assert.equal(queued?.request.harness, "pi");
  assert.equal(queued?.request.model, "gpt-6-astra");
  await built.userModelCredentials.delete("U1", "openai");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "codex", modelId: "gpt-6.1-sol" });
  const second = await submit({ model: "gpt-6-astra" });
  assert.ok(second.runId, JSON.stringify(second));
  const oauth = await built.runs.get(second.runId!);
  assert.equal(oauth?.request.harness, "codex");
  assert.equal(oauth?.request.model, "gpt-6-astra");
});

test("a web turn on a disconnected personal account runs on the org account when the unavailable fallback is on", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ harness: "pi", openaiApiKey: "company-openai" }));
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.config.setModelAccountPolicy({
    anthropic: "personal",
    openai: "personal",
    fallbackWhenUnavailable: true,
  });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:disconnected-fallback" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "gpt-6-astra",
    harness: "pi",
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.runtime?.modelId, "gpt-6-astra");
    assert.ok(!JSON.stringify(turns[0]!.providerKeys ?? {}).includes("personal-"));
  } finally {
    await built.runtime.stop();
  }
});

test("a codex subscription model never falls back to an org without a Codex sign-in", async () => {
  turns.length = 0;
  personalRejection = "Your authentication token has expired. Please sign in again.";
  const built = buildApp(testConfig({ harness: "pi", openaiApiKey: "company-openai" }));
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal", fallbackWhenRejected: true });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:codex-no-org" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "codex/gpt-6-astra",
    harness: "pi",
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "failed");
    assert.equal(turns.length, 1);
  } finally {
    personalRejection = null;
    await built.runtime.stop();
  }
});

test("revoking someone's personal account access applies to their already queued run", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "execute-revoked" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  assert.equal((await built.runs.get(submitted.runId!))?.request.modelAccount, "anthropic");
  await built.config.setPersonalAccountAccess(["someone-else@default-org"]);
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    assert.ok(!JSON.stringify(turns[0]!.providerKeys ?? {}).includes("personal-"));
  } finally {
    await built.runtime.stop();
  }
});

test("every org fallback leaves a durable audit event", async () => {
  turns.length = 0;
  personalRejection = "Model provider API error (authentication_error): invalid x-api-key";
  const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal", fallbackWhenRejected: true });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "execute-audited" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  built.runtime.start();
  try {
    assert.equal((await built.runs.waitFor(submitted.runId!, 5_000)).status, "done");
    const events = (await built.auditLog.events()).filter((e) => e.action === "model_account.org_fallback");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.status, "rejected");
    assert.equal(events[0]!.resource, submitted.runId);
    assert.match(events[0]!.detail ?? "", /"sessionId"/);
  } finally {
    personalRejection = null;
    await built.runtime.stop();
  }
});

test("a scoped claude selection does not steer a personal ChatGPT sign-in onto an unapproved harness", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ harness: "pi" }));
  built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.config.flushScope("org:default-org");
  await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "pi", modelId: "gpt-6-astra" });
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    idToken: "x.eyJlbWFpbCI6ImFAYi5jIn0.y",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true);
  await built.config.setRuntimeSelectionLatest("personal:U1", {
    harnessId: "claude",
    modelId: defaultModelForHarness("claude"),
  });
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm-scoped" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.runtime?.harnessId, "pi");
    assert.deepEqual(Object.keys(turns[0]!.providerKeys ?? {}), ["openai-codex"]);
  } finally {
    await built.runtime.stop();
  }
});

test("the org capability check models real org credentials", async () => {
  const claudeModel = defaultModelForHarness("claude");
  const bare = buildApp(testConfig({ harness: "pi" }));
  assert.equal(await bare.orgServesModel("claude", claudeModel), false);
  assert.equal(await bare.orgServesModel("pi", "codex/gpt-6-astra"), false);
  assert.equal(await bare.orgServesModel("pi", "gpt-6-astra"), false);
  const gatewayOnly = buildApp(
    testConfig({ harness: "pi", claudeProcessEnv: { ANTHROPIC_BASE_URL: "https://gateway.example.test" } }),
  );
  assert.equal(await gatewayOnly.orgServesModel("claude", claudeModel), false);
  const gateway = buildApp(
    testConfig({
      harness: "pi",
      claudeProcessEnv: { ANTHROPIC_BASE_URL: "https://gateway.example.test", ANTHROPIC_AUTH_TOKEN: "org-token" },
    }),
  );
  assert.equal(await gateway.orgServesModel("claude", claudeModel), true);
  const codex = buildApp(testConfig({ harness: "pi", codexProcessEnv: { CODEX_ACCESS_TOKEN: "org-codex" } }));
  assert.equal(await codex.orgServesModel("pi", "codex/gpt-6-astra"), true);
  assert.equal(await codex.orgServesModel("codex", "gpt-6-astra"), true);
});
