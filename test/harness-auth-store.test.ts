import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeSubscriptionTokenProblem,
  createHarnessAuthStore,
  type StoredHarnessAuth,
} from "../src/credentials/harness-auth-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const KEY = "0".repeat(64);

function store(keyMaterial = KEY) {
  const backing = createMemoryMap<StoredHarnessAuth>();
  return { store: createHarnessAuthStore({ backing, keyMaterial }), backing };
}

test("harness auth round-trips a token without storing it in the clear", async () => {
  const { store: auth, backing } = store();
  await auth.set("claude", "sk-ant-oat01-secret", "admin@example.com");
  assert.equal(await auth.resolve("claude"), "sk-ant-oat01-secret");
  const raw = await backing.get("claude");
  assert.ok(raw?.tokenEnc);
  assert.ok(!JSON.stringify(raw).includes("sk-ant-oat01-secret"));
});

test("harness auth reports an absent credential rather than an empty one", async () => {
  const { store: auth } = store();
  assert.equal(await auth.resolve("claude"), null);
  assert.deepEqual(await auth.status("claude"), { harnessId: "claude", configured: false });
});

test("disabling leaves a tombstone so the credential cannot come back", async () => {
  const { store: auth, backing } = store();
  await auth.set("claude", "sk-ant-oat01-secret", "admin@example.com");
  await auth.delete("claude", "admin@example.com");
  assert.equal(await auth.resolve("claude"), null);
  assert.equal((await auth.status("claude")).configured, false);
  assert.equal((await backing.get("claude"))?.disabled, true);
});

test("a token written under different key material degrades instead of throwing", async () => {
  const backing = createMemoryMap<StoredHarnessAuth>();
  await createHarnessAuthStore({ backing, keyMaterial: KEY }).set("claude", "sk-ant-oat01-secret", "admin");
  // Losing the subscription is a billing change; throwing here would be an outage.
  const rotated = createHarnessAuthStore({ backing, keyMaterial: "f".repeat(64) });
  assert.equal(await rotated.resolve("claude"), null);
});

test("harnesses keep separate credentials", async () => {
  const { store: auth } = store();
  await auth.set("claude", "sk-ant-oat01-claude", "admin");
  assert.equal(await auth.resolve("codex"), null);
  assert.equal(await auth.resolve("claude"), "sk-ant-oat01-claude");
});

test("a Console API key is refused with the command that makes the right token", () => {
  assert.equal(claudeSubscriptionTokenProblem("sk-ant-oat01-good"), null);
  assert.match(claudeSubscriptionTokenProblem("sk-ant-api03-key")!, /claude setup-token/);
  assert.match(claudeSubscriptionTokenProblem("   ")!, /required/);
});
