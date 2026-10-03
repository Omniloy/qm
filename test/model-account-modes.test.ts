import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type ModelAccount,
  type ModelAccountModes,
  type PersistedModelAccountModes,
  type PersistedScopedFlag,
} from "../src/resolution/config-store.ts";
import { loadPersonalModelAccess, routePersonalModelAccess } from "../src/core/individual-auth-routing.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import type { UserModelCredential } from "../src/model/user-model-credential-store.ts";

const MODES: ModelAccountModes[] = [
  { anthropic: "org", openai: "org" },
  { anthropic: "personal", openai: "org" },
  { anthropic: "org", openai: "personal" },
  { anthropic: "personal", openai: "personal" },
];

test("provider modes default to org, persist across instances, and gate each person's effective account", async () => {
  const modelAccountModes = createMemoryMap<PersistedModelAccountModes>();
  const individualModelAuth = createMemoryMap<PersistedScopedFlag>();
  const first = createMemoryConfigStore("default-org", { modelAccountModes, individualModelAuth });
  const second = createMemoryConfigStore("default-org", { modelAccountModes, individualModelAuth });
  assert.deepEqual(await first.getModelAccountModesDurable(), { anthropic: "org", openai: "org" });
  await first.setPersonalModelAuth("pinned-anthropic", true, "anthropic");
  await first.setPersonalModelAuth("pinned-openai", true, "openai");
  await first.setPersonalModelAuth("both", true);
  first.setIndividualModelAuth(true);
  await first.flushScope("org:default-org");

  const expected: Record<string, Record<string, ModelAccount>> = {
    "org/org": { "pinned-anthropic": "company", "pinned-openai": "company", both: "company", other: "company" },
    "personal/org": {
      "pinned-anthropic": "anthropic",
      "pinned-openai": "personal",
      both: "personal",
      other: "personal",
    },
    "org/personal": { "pinned-anthropic": "personal", "pinned-openai": "openai", both: "personal", other: "personal" },
    "personal/personal": {
      "pinned-anthropic": "anthropic",
      "pinned-openai": "openai",
      both: "personal",
      other: "personal",
    },
  };
  for (const modes of MODES) {
    await first.setModelAccountModes(modes);
    assert.deepEqual(await second.getModelAccountModesDurable(), modes);
    const label = `${modes.anthropic}/${modes.openai}`;
    for (const [principal, account] of Object.entries(expected[label]!)) {
      assert.equal(await second.getModelAccountDurable(principal), account, `${label} ${principal}`);
      assert.equal(
        await second.getIndividualModelAuthDurable(principal),
        account !== "company",
        `${label} ${principal}`,
      );
    }
    assert.equal(await second.getIndividualModelAuthDurable(), label !== "org/org", label);
  }
});

const credential = (provider: "anthropic" | "openai"): UserModelCredential => ({
  provider,
  kind: "apikey",
  apiKey: `personal-${provider}`,
  updatedAt: 0,
});

test("routing serves org-mode providers from the org account for every mode, account, and model", async () => {
  const store = { get: async (_userId: string, provider: string) => credential(provider as "anthropic" | "openai") };
  const accounts = ["personal", "anthropic", "openai"] as const;
  const models = ["claude-sonnet-5-5", "gpt-6-astra", undefined];
  for (const modes of MODES) {
    for (const account of accounts) {
      const access = await loadPersonalModelAccess(
        { getModelAccountModesDurable: async () => modes },
        store,
        "U1",
        account,
      );
      const own = (account === "personal" ? (["anthropic", "openai"] as const) : [account]).filter(
        (provider) => modes[provider] === "personal",
      );
      for (const model of models) {
        const label = `${modes.anthropic}/${modes.openai} ${account} ${model ?? "default"}`;
        const route = routePersonalModelAccess(access, model, "pi");
        const requested = model ? resolveModel(model)?.provider : undefined;
        if (!own.length || (requested && modes[requested as "anthropic" | "openai"] === "org")) {
          assert.equal(route, "org", label);
          continue;
        }
        const provider = requested && own.includes(requested as never) ? requested : own[0];
        assert.ok(route !== "org" && route?.kind === "apikey", label);
        assert.equal(route.provider, provider, label);
        assert.equal(route.apiKey, `personal-${provider}`, label);
        if (requested === provider) assert.equal(route.model, model, label);
      }
    }
  }
});

test("a person with both accounts keeps Claude personal while ChatGPT turns fall back to the org", async () => {
  const access = await loadPersonalModelAccess(
    { getModelAccountModesDurable: async () => ({ anthropic: "personal", openai: "org" }) },
    { get: async (_userId, provider) => credential(provider as "anthropic" | "openai") },
    "U1",
    "personal",
  );
  assert.equal(access.openai, null);
  const claude = routePersonalModelAccess(access, "claude-sonnet-5-5", "pi");
  assert.ok(claude !== "org" && claude?.kind === "apikey");
  assert.equal(claude.apiKey, "personal-anthropic");
  assert.equal(routePersonalModelAccess(access, "gpt-6-astra", "pi"), "org");
  assert.equal(routePersonalModelAccess(access, "codex/gpt-6-astra", "pi"), "org");
});

test("without the org requirement, a pin to a provider switched to org falls back to the org account", async () => {
  const store = createMemoryConfigStore("default-org");
  await store.setPersonalModelAuth("pinned-openai", true, "openai");
  await store.setModelAccountModes({ anthropic: "personal", openai: "org" });
  assert.equal(await store.getModelAccountDurable("pinned-openai"), "company");
  assert.equal(await store.getIndividualModelAuthDurable(), false);
});

test("the org requirement fails closed for a personal-mode provider with no connected account", async () => {
  const access = await loadPersonalModelAccess(
    { getModelAccountModesDurable: async () => ({ anthropic: "personal", openai: "org" }) },
    { get: async () => null },
    "U1",
    "personal",
  );
  assert.equal(routePersonalModelAccess(access, "claude-sonnet-5-5", "pi"), null);
  assert.equal(routePersonalModelAccess(access, "gpt-6-astra", "pi"), "org");
});
