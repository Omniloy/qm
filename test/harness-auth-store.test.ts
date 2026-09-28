import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeHarnessAuthEnv,
  claudeSubscriptionTokenProblem,
  createHarnessAuthStore,
  type StoredHarnessAuth,
} from "../src/credentials/harness-auth-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { claudeChildEnv } from "../src/harness/claude-harness.ts";

const KEY = "0".repeat(64);

function store(keyMaterial = KEY) {
  const backing = createMemoryMap<StoredHarnessAuth>();
  return { store: createHarnessAuthStore({ backing, keyMaterial }), backing };
}

test("harness auth round-trips a token without storing it in the clear", async () => {
  const { store: auth, backing } = store();
  await auth.set("claude", "sk-ant-oat01-secret", "admin@example.com");
  assert.deepEqual(await auth.resolve("claude"), { kind: "token", token: "sk-ant-oat01-secret" });
  const raw = await backing.get("claude");
  assert.ok(raw?.tokenEnc);
  assert.ok(!JSON.stringify(raw).includes("sk-ant-oat01-secret"));
});

test("harness auth reports an absent credential rather than an empty one", async () => {
  const { store: auth } = store();
  assert.deepEqual(await auth.resolve("claude"), { kind: "unset" });
  assert.deepEqual(await auth.status("claude"), { harnessId: "claude", configured: false });
});

test("disabling leaves a tombstone so the credential cannot come back", async () => {
  const { store: auth, backing } = store();
  await auth.set("claude", "sk-ant-oat01-secret", "admin@example.com");
  await auth.delete("claude", "admin@example.com");
  assert.deepEqual(await auth.resolve("claude"), { kind: "disabled" });
  assert.equal((await auth.status("claude")).configured, false);
  assert.equal((await backing.get("claude"))?.disabled, true);
});

test("a token written under different key material degrades instead of throwing", async () => {
  const backing = createMemoryMap<StoredHarnessAuth>();
  await createHarnessAuthStore({ backing, keyMaterial: KEY }).set("claude", "sk-ant-oat01-secret", "admin");
  const rotated = createHarnessAuthStore({ backing, keyMaterial: "f".repeat(64) });
  assert.deepEqual(await rotated.resolve("claude"), { kind: "unset" });
});

test("harnesses keep separate credentials", async () => {
  const { store: auth } = store();
  await auth.set("claude", "sk-ant-oat01-claude", "admin");
  assert.deepEqual(await auth.resolve("codex"), { kind: "unset" });
  assert.deepEqual(await auth.resolve("claude"), { kind: "token", token: "sk-ant-oat01-claude" });
});

test("the Claude harness env prefers the saved token, and a disconnect strips every fallback token", async () => {
  const { store: auth } = store();
  const fallback = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-keychain-or-env", ANTHROPIC_AUTH_TOKEN: "auth" };
  assert.deepEqual(await claudeHarnessAuthEnv(auth, fallback), fallback);
  await auth.set("claude", "sk-ant-oat01-saved", "admin");
  assert.equal((await claudeHarnessAuthEnv(auth, fallback)).CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-saved");
  await auth.delete("claude", "admin");
  const disconnected = await claudeHarnessAuthEnv(auth, fallback);
  assert.ok("CLAUDE_CODE_OAUTH_TOKEN" in disconnected);
  assert.equal(disconnected.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const bootEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-boot", PATH: "/bin" };
  const child = claudeChildEnv({ ...bootEnv, ...disconnected }, "/jail");
  assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, "auth");
});

test("a Console API key is refused with the command that makes the right token", () => {
  assert.equal(claudeSubscriptionTokenProblem("sk-ant-oat01-good"), null);
  assert.match(claudeSubscriptionTokenProblem("sk-ant-api03-key")!, /claude setup-token/);
  assert.match(claudeSubscriptionTokenProblem("   ")!, /required/);
});
