import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type ModelAccount,
  type ModelAccountModes,
  type PersistedModelAccountModes,
  type PersistedPeopleAccess,
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

test("provider modes default to org, persist across instances, and gate each person's own opt-in", async () => {
  const modelAccountModes = createMemoryMap<PersistedModelAccountModes>();
  const individualModelAuth = createMemoryMap<PersistedScopedFlag>();
  const first = createMemoryConfigStore("default-org", { modelAccountModes, individualModelAuth });
  const second = createMemoryConfigStore("default-org", { modelAccountModes, individualModelAuth });
  assert.deepEqual(await first.getModelAccountPolicyDurable(), {
    anthropic: "org",
    openai: "org",
    fallbackWhenUnavailable: false,
    fallbackWhenRejected: false,
  });
  await first.setPersonalModelAuth("pinned-anthropic", true, "anthropic");
  await first.setPersonalModelAuth("pinned-openai", true, "openai");
  await first.setPersonalModelAuth("both", true);
  await individualModelAuth.put("org:default-org", { scopeId: "org:default-org", on: true });

  const expected: Record<string, Record<string, ModelAccount>> = {
    "org/org": { "pinned-anthropic": "company", "pinned-openai": "company", both: "company", other: "company" },
    "personal/org": {
      "pinned-anthropic": "anthropic",
      "pinned-openai": "company",
      both: "personal",
      other: "company",
    },
    "org/personal": { "pinned-anthropic": "company", "pinned-openai": "openai", both: "personal", other: "company" },
    "personal/personal": {
      "pinned-anthropic": "anthropic",
      "pinned-openai": "openai",
      both: "personal",
      other: "company",
    },
  };
  for (const modes of MODES) {
    await first.setModelAccountPolicy(modes);
    assert.deepEqual(await second.getModelAccountPolicyDurable(), {
      ...modes,
      fallbackWhenUnavailable: false,
      fallbackWhenRejected: false,
    });
    const label = `${modes.anthropic}/${modes.openai}`;
    for (const [principal, account] of Object.entries(expected[label]!))
      assert.equal(await second.getModelAccountDurable(principal), account, `${label} ${principal}`);
  }
});

test("the fallback switches persist with the provider modes and default off", async () => {
  const modelAccountModes = createMemoryMap<PersistedModelAccountModes>();
  const first = createMemoryConfigStore("default-org", { modelAccountModes });
  const second = createMemoryConfigStore("default-org", { modelAccountModes });
  await first.setModelAccountPolicy({ anthropic: "personal", openai: "org", fallbackWhenRejected: true });
  assert.deepEqual(await second.getModelAccountPolicyDurable(), {
    anthropic: "personal",
    openai: "org",
    fallbackWhenUnavailable: false,
    fallbackWhenRejected: true,
  });
  await modelAccountModes.put("org:default-org", {
    scopeId: "org:default-org",
    modes: { anthropic: "personal", openai: "personal" },
  });
  assert.deepEqual(await second.getModelAccountPolicyDurable(), {
    anthropic: "personal",
    openai: "personal",
    fallbackWhenUnavailable: false,
    fallbackWhenRejected: false,
  });
});

test("only people on the allowlist resolve to their own account; everyone else keeps their saved choice unused", async () => {
  const personalAccountAccess = createMemoryMap<PersistedPeopleAccess>();
  const directory = {
    get: async (id: string) => (id === "U-ALICE" ? { principalId: "alice@acme.com", slackId: "U-ALICE" } : null),
  };
  const shared = {
    personalAccountAccess,
    individualModelAuth: createMemoryMap<PersistedScopedFlag>(),
    modelAccountModes: createMemoryMap<PersistedModelAccountModes>(),
    directory: () => directory,
  };
  const first = createMemoryConfigStore("default-org", shared);
  const second = createMemoryConfigStore("default-org", shared);
  await first.setModelAccountPolicy({ anthropic: "personal", openai: "personal" });
  for (const id of ["U-ALICE", "bob@acme.com"]) await first.setPersonalModelAuth(id, true, "anthropic");
  assert.equal(await second.getPersonalAccountAccess(), null);
  assert.equal(await second.getModelAccountDurable("bob@acme.com"), "anthropic");

  await first.setPersonalAccountAccess(["Alice@Acme.com", "alice@acme.com"]);
  assert.deepEqual(await second.getPersonalAccountAccess(), ["alice@acme.com"]);
  assert.equal(await second.personalAccountAllowed("U-ALICE"), true);
  assert.equal(await second.getModelAccountDurable("U-ALICE"), "anthropic");
  assert.equal(await second.personalAccountAllowed("bob@acme.com"), false);
  assert.equal(await second.getModelAccountDurable("bob@acme.com"), "company");

  await first.setPersonalAccountAccess(null);
  assert.equal(await second.getModelAccountDurable("bob@acme.com"), "anthropic");
});

const policyOf = (modes: ModelAccountModes, fallbackWhenUnavailable = false, allowed = true) => ({
  getModelAccountPolicyDurable: async () => ({ ...modes, fallbackWhenUnavailable, fallbackWhenRejected: false }),
  personalAccountAllowed: async () => allowed,
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
      const access = await loadPersonalModelAccess(policyOf(modes), store, "U1", account);
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
    policyOf({ anthropic: "personal", openai: "org" }),
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

test("a pin to a provider switched to org falls back to the org account", async () => {
  const store = createMemoryConfigStore("default-org");
  await store.setPersonalModelAuth("pinned-openai", true, "openai");
  await store.setModelAccountPolicy({ anthropic: "personal", openai: "org" });
  assert.equal(await store.getModelAccountDurable("pinned-openai"), "company");
});

test("routing fails closed for a personal-mode provider with no connected account", async () => {
  const access = await loadPersonalModelAccess(
    policyOf({ anthropic: "personal", openai: "org" }),
    { get: async () => null },
    "U1",
    "personal",
  );
  assert.equal(routePersonalModelAccess(access, "claude-sonnet-5-5", "pi"), null);
  assert.equal(routePersonalModelAccess(access, "gpt-6-astra", "pi"), "org");
});

test("the unavailable fallback and the allowlist make missing or disallowed providers org-served", async () => {
  const modes: ModelAccountModes = { anthropic: "personal", openai: "personal" };
  const onlyAnthropic = {
    get: async (_userId: string, provider: string) => (provider === "anthropic" ? credential("anthropic") : null),
  };
  const strict = await loadPersonalModelAccess(policyOf(modes), onlyAnthropic, "U1", "personal");
  assert.equal(routePersonalModelAccess(strict, "gpt-6-astra", "pi") === "org", false);
  const lenient = await loadPersonalModelAccess(policyOf(modes, true), onlyAnthropic, "U1", "personal");
  assert.equal(routePersonalModelAccess(lenient, "gpt-6-astra", "pi"), "org");
  assert.notEqual(routePersonalModelAccess(lenient, "claude-sonnet-5-5", "pi"), "org");
  const pinned = await loadPersonalModelAccess(policyOf(modes, true), { get: async () => null }, "U1", "openai");
  assert.equal(routePersonalModelAccess(pinned, "gpt-6-astra", "pi"), "org");
  const revoked = await loadPersonalModelAccess(policyOf(modes, false, false), onlyAnthropic, "U1", "personal");
  assert.equal(revoked.anthropic, null);
  assert.equal(routePersonalModelAccess(revoked, "claude-sonnet-5-5", "pi"), "org");
});
