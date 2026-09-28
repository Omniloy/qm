import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type PersistedModelAccountModes,
  type PersistedScopedFlag,
} from "../src/resolution/config-store.ts";
import { createServer } from "../src/api/server.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "personal-account-test-signing-secret";

test("personal account choice persists across instances without changing anyone else's choice", async () => {
  const individualModelAuth = createMemoryMap<PersistedScopedFlag>();
  const modelAccountModes = createMemoryMap<PersistedModelAccountModes>();
  const first = createMemoryConfigStore("default-org", { individualModelAuth, modelAccountModes });
  const second = createMemoryConfigStore("default-org", { individualModelAuth, modelAccountModes });
  await first.setModelAccountModes({ anthropic: "personal", openai: "personal" });
  assert.equal(await first.getIndividualModelAuthDurable("alice"), false);
  await first.setPersonalModelAuth("alice", true);
  assert.equal(await second.getIndividualModelAuthDurable("alice"), true);
  assert.equal(await second.getIndividualModelAuthDurable("bob"), false);
  assert.equal(await second.getIndividualModelAuthDurable(), false);
  await second.setPersonalModelAuth("alice", false);
  assert.equal(await first.getIndividualModelAuthDurable("alice"), false);
  first.setIndividualModelAuth(true);
  await first.flushScope("org:default-org");
  assert.equal(await second.getIndividualModelAuthDurable("alice"), true);
});

test("account API binds choice to the signed-in person, preserves connections, and fails closed after disconnect", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personal-account-")) }));
  await built.config.setModelAccountModes({ anthropic: "personal", openai: "personal" });
  built.config.setInternalMemberOverrides(["alice@default-org", "bob@default-org"]);
  await built.config.flushScope("org:default-org");
  const server = createServer(built.app, {
    signingSecret: SECRET,
    requireSignedPortalIdentity: true,
    capabilitySecret: SECRET + "capability",
    portalIdentitySecret: SECRET + "portal",
    config: built.config,
    userModelCredentials: built.userModelCredentials,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  async function request(account: unknown, principalId = "alice@default-org", signedIn = "alice@default-org") {
    const path = "/v1/user-model-auth/account";
    const body = JSON.stringify({ account, principalId, nonce: crypto.randomUUID() });
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n${path}\n${body}`),
        "x-portal-identity": await mintPortalIdentity({ p: signedIn, exp: Date.now() + 60_000 }, SECRET + "portal"),
      },
      body,
    });
  }
  try {
    assert.equal((await request("personal")).status, 409);
    assert.equal((await request("invalid")).status, 400);
    await built.userModelCredentials.setApiKey("alice@default-org", "anthropic", "test-personal-key");
    assert.equal((await request("personal", "bob@default-org", "alice@default-org")).status, 403);
    const enabled = await request("personal");
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), {
      individualModelAuth: true,
      required: false,
      account: "personal",
      connections: [{ provider: "anthropic", kind: "apikey" }],
      modes: { anthropic: "personal", openai: "personal" },
    });
    assert.equal(await built.config.getIndividualModelAuthDurable("bob@default-org"), false);
    assert.equal((await request("company")).status, 200);
    assert.equal((await built.userModelCredentials.connections("alice@default-org")).length, 1);
    assert.equal((await request("personal")).status, 200);
    await built.userModelCredentials.delete("alice@default-org", "anthropic");
    assert.equal(await built.config.getIndividualModelAuthDurable("alice@default-org"), true);
    assert.equal((await request("company")).status, 200);
    built.config.setIndividualModelAuth(true);
    await built.config.flushScope("org:default-org");
    assert.equal((await request("company")).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider modes refuse sign-in for org-served providers and trim the status payload", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personal-modes-")) }));
  built.config.setInternalMemberOverrides(["alice@default-org"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("alice@default-org", "anthropic", "test-anthropic-key");
  await built.userModelCredentials.setApiKey("alice@default-org", "openai", "test-openai-key");
  const server = createServer(built.app, {
    signingSecret: SECRET,
    requireSignedPortalIdentity: true,
    capabilitySecret: SECRET + "capability",
    portalIdentitySecret: SECRET + "portal",
    config: built.config,
    userModelCredentials: built.userModelCredentials,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  async function call(method: "GET" | "POST", path: string, fields: Record<string, unknown> = {}) {
    const principalId = "alice@default-org";
    const target = method === "GET" ? `${path}?principalId=${encodeURIComponent(principalId)}` : path;
    const body = method === "GET" ? "" : JSON.stringify({ ...fields, principalId, nonce: crypto.randomUUID() });
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + target, {
      method,
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `${method}\n${target}\n${body}`),
        "x-portal-identity": await mintPortalIdentity({ p: principalId, exp: Date.now() + 60_000 }, SECRET + "portal"),
      },
      ...(method === "GET" ? {} : { body }),
    });
  }
  const refused = async (path: string, fields: Record<string, unknown> = {}) => {
    const response = await call("POST", path, fields);
    assert.equal(response.status, 403, path);
    assert.equal(((await response.json()) as { error: string }).error, "personal_accounts_disabled");
  };
  try {
    const status = async () => (await call("GET", "/v1/user-model-auth/status")).json();
    assert.deepEqual(await status(), {
      individualModelAuth: false,
      required: false,
      account: "company",
      connections: [],
      modes: { anthropic: "org", openai: "org" },
    });
    await refused("/v1/user-model-auth/api-key", { provider: "claude", apiKey: "test-new-key" });
    await refused("/v1/user-model-auth/api-key", { provider: "chatgpt", apiKey: "test-new-key" });
    await refused("/v1/user-model-auth/claude/start");
    await refused("/v1/user-model-auth/claude/complete", { code: "code", verifier: "verifier" });
    await refused("/v1/user-model-auth/chatgpt/start");
    await refused("/v1/user-model-auth/chatgpt/poll", { deviceAuthId: "device" });
    await refused("/v1/user-model-auth/account", { account: "personal", provider: "anthropic" });
    assert.equal((await call("POST", "/v1/user-model-auth/account", { account: "personal" })).status, 409);

    await built.config.setModelAccountModes({ anthropic: "personal", openai: "org" });
    await refused("/v1/user-model-auth/chatgpt/start");
    await refused("/v1/user-model-auth/account", { account: "personal", provider: "openai" });
    const chosen = await call("POST", "/v1/user-model-auth/account", { account: "personal", provider: "anthropic" });
    assert.equal(chosen.status, 200);
    assert.deepEqual(await chosen.json(), {
      individualModelAuth: true,
      required: false,
      account: "anthropic",
      connections: [{ provider: "anthropic", kind: "apikey" }],
      modes: { anthropic: "personal", openai: "org" },
    });

    await built.config.setModelAccountModes({ anthropic: "org", openai: "org" });
    assert.equal(((await status()) as { account: string }).account, "company");
    assert.equal((await call("POST", "/v1/user-model-auth/disconnect", { provider: "claude" })).status, 200);
    assert.equal(await built.userModelCredentials.get("alice@default-org", "anthropic"), null);
    assert.equal((await built.userModelCredentials.get("alice@default-org", "openai"))?.apiKey, "test-openai-key");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("personal provider choice is durable and controls the submitted run independently of the company model", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personal-routing-")) }));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "test-anthropic-key");
  await built.userModelCredentials.setApiKey("U1", "openai", "test-openai-key");
  await built.config.setModelAccountModes({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "personal-provider-choice" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "company-only-custom-model",
    harness: "pi",
  });
  const run = await built.runs.get(submitted.runId!);
  assert.equal(run?.request.modelAccount, "openai");
  assert.equal(run?.request.model, undefined);
  assert.equal(run?.request.harness, undefined);
  await built.config.setPersonalModelAuth("U1", false);
  assert.equal((await built.runs.get(submitted.runId!))?.request.modelAccount, "openai");
  const steered = await built.app.signalRun(submitted.runId!, { kind: "steer", text: "more work" }, "U1");
  assert.equal(steered.accepted, false);
  assert.match(steered.reason ?? "", /account_changed/);
  assert.equal((await built.app.signalRun(submitted.runId!, { kind: "abort" }, "U1")).accepted, true);
});

test("shared chat messages queue instead of borrowing another person's account", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personal-steering-")) }));
  const message = (user: string) => ({
    surface: "slack",
    actor: { externalId: user },
    conversation: { kind: "channel" as const, threadRef: "account-steering", channelRef: "C1" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  await built.config.setModelAccountModes({ anthropic: "personal", openai: "personal" });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const first = await built.app.turn(message("U1"));
  const other = await built.app.turn(message("U2"));
  assert.notEqual(first.runId, other.runId);
  assert.notEqual(other.steered, true);
  assert.equal((await built.runs.get(other.runId!))?.request.modelAccount, "company");
  assert.equal((await built.signals.takePending(first.runId!)).length, 0);
});
