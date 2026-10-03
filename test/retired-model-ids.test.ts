import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type PersistedAutoFlaggerConfig,
  type PersistedBaseModel,
  type PersistedBrowseModel,
  type PersistedWebuiModels,
} from "../src/resolution/config-store.ts";
import { availableRuntimeError, validateRuntimeChoice, webuiModelEnabled } from "../src/api/runtime-config.ts";
import { canonicalModelId, defaultModelForHarness } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { configuredModelForHarness } from "../src/config.ts";
import { resolveConfiguredModelId } from "../src/harness/pi-harness.ts";
import { testConfig } from "./support/test-config.ts";

const ORG = "org:default-org" as const;

function storeWithRetiredRows() {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const webuiModels = createMemoryMap<PersistedWebuiModels>();
  const browseModels = createMemoryMap<PersistedBrowseModel>();
  const autoFlaggerConfigs = createMemoryMap<PersistedAutoFlaggerConfig>();
  const config = createMemoryConfigStore("default-org", { baseModels, webuiModels, browseModels, autoFlaggerConfigs });
  return { config, baseModels, webuiModels, browseModels, autoFlaggerConfigs };
}

function deps(config: ReturnType<typeof createMemoryConfigStore>) {
  return { deps: { config, harnessId: "pi", providerKeys: { anthropic: true, openai: true, openrouter: false } } };
}

test("stored retired ids read back as their successors, cached and durable", async () => {
  const { config, baseModels, webuiModels, browseModels, autoFlaggerConfigs } = storeWithRetiredRows();
  await baseModels.put(ORG, {
    scopeId: ORG,
    harnessId: "pi",
    modelId: "claude-opus-5",
    cronRuntime: { harnessId: "pi", modelId: "gpt-5.6-terra" },
  });
  await baseModels.put("personal:alice", { scopeId: "personal:alice", modelId: "gpt-6-sol" });
  await webuiModels.put(ORG, { scopeId: ORG, ids: ["gpt-6-sol", "gpt-6.1-sol", "claude-sonnet-5"] });
  await browseModels.put(ORG, { scopeId: ORG, modelId: "gpt-5.6-luna" });
  await autoFlaggerConfigs.put(ORG, { scopeId: ORG, harnessId: "pi", modelId: "claude-fable-5", rubric: "r" });
  await config.hydrate?.();

  assert.equal(config.getRuntimeSelection(ORG)?.modelId, "claude-opus-5-5");
  assert.equal((await config.getRuntimeSelectionDurable(ORG))?.modelId, "claude-opus-5-5");
  assert.equal(config.getPurposeRuntime("cron")?.modelId, "gpt-6.1-sol");
  assert.equal((await config.getPurposeRuntimeDurable("cron"))?.modelId, "gpt-6.1-sol");
  assert.equal(config.getBaseModel("personal:alice"), "gpt-6.1-sol");
  assert.equal(await config.getBaseModelOwnDurable("personal:alice"), "gpt-6.1-sol");
  assert.deepEqual(config.getWebuiModels(ORG), ["gpt-6.1-sol", "claude-sonnet-5-5"]);
  assert.deepEqual(await config.getWebuiModelsDurable(ORG), ["gpt-6.1-sol", "claude-sonnet-5-5"]);
  assert.equal(config.getBrowseModel(ORG), "gpt-6-luna");
  assert.equal(config.getAutoFlaggerConfig()?.modelId, "claude-fable-5-1");
});

test("writes that name a retired id store the successor", async () => {
  const { config, baseModels, webuiModels, browseModels, autoFlaggerConfigs } = storeWithRetiredRows();
  config.setRuntimeSelection("personal:alice", { harnessId: "pi", modelId: "gpt-5.6-sol", fastMode: true });
  config.setWebuiModels(ORG, ["gpt-6-sol"]);
  config.setBrowseModel(ORG, "claude-sonnet-5");
  config.setAutoFlaggerConfig({ harnessId: "pi", modelId: "gpt-5.6-luna", rubric: "r" });
  await config.setPurposeRuntime("subagent", { harnessId: "pi", modelId: "claude-opus-5" });
  await config.flushScope(ORG);
  await config.flushScope("personal:alice");

  assert.equal(config.getRuntimeSelection("personal:alice")?.modelId, "gpt-6.1-sol");
  assert.equal((await baseModels.get("personal:alice"))?.modelId, "gpt-6.1-sol");
  assert.equal((await baseModels.get(ORG))?.subagentRuntime?.modelId, "claude-opus-5-5");
  assert.deepEqual((await webuiModels.get(ORG))?.ids, ["gpt-6.1-sol"]);
  assert.equal((await browseModels.get(ORG))?.modelId, "claude-sonnet-5-5");
  assert.equal(config.getAutoFlaggerConfig()?.modelId, "gpt-6-luna");
  assert.equal((await autoFlaggerConfigs.get(ORG))?.modelId, "gpt-6-luna");
});

test("a cron on a retired id is allowed when the allowlist names the same retired id", async () => {
  const { config, webuiModels } = storeWithRetiredRows();
  await webuiModels.put(ORG, { scopeId: ORG, ids: ["gpt-6-sol"] });
  await config.hydrate?.();
  assert.equal(await availableRuntimeError(deps(config), ORG, { harnessId: "pi", modelId: "gpt-6-sol" }, "cron"), null);
});

test("a retired org default stays enabled when the allowlist omits it", async () => {
  const { config, baseModels, webuiModels } = storeWithRetiredRows();
  await baseModels.put(ORG, { scopeId: ORG, harnessId: "pi", modelId: "claude-opus-5" });
  await webuiModels.put(ORG, { scopeId: ORG, ids: ["gpt-6.1-sol"] });
  await config.hydrate?.();
  assert.equal(await webuiModelEnabled(deps(config), "claude-opus-5"), true);
  assert.equal(await webuiModelEnabled(deps(config), "claude-opus-5-5"), true);
});

test("a configured retired default resolves to its successor", () => {
  assert.equal(defaultModelForHarness("pi", "claude-opus-5"), "claude-opus-5-5");
  assert.equal(defaultModelForHarness("codex", "gpt-6-sol"), "gpt-6.1-sol");
  assert.equal(configuredModelForHarness(testConfig({ modelId: "claude-opus-5" }), "pi"), "claude-opus-5-5");
  assert.equal(configuredModelForHarness(testConfig({ codexModel: "gpt-5.6-sol" }), "codex"), "gpt-6.1-sol");
  assert.equal(resolveConfiguredModelId("claude-sonnet-5"), "claude-sonnet-5-5");
});

test("fast mode on a retired id follows its successor", () => {
  assert.equal(validateRuntimeChoice({ harnessId: "pi", modelId: "gpt-5.6-terra", fastMode: true }), null);
  assert.equal(
    validateRuntimeChoice({ harnessId: "pi", modelId: "claude-sonnet-5", fastMode: true }),
    "fast_mode_not_supported",
  );
});

test("a custom-provider model whose bare id was retired is never aliased", () => {
  setCustomProviders([
    {
      id: "litellm",
      name: "LiteLLM",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:4000/v1",
      models: [{ id: "claude-opus-5" }],
    },
  ]);
  try {
    assert.equal(canonicalModelId("claude-opus-5"), "claude-opus-5");
  } finally {
    setCustomProviders([]);
  }
  assert.equal(canonicalModelId("claude-opus-5"), "claude-opus-5-5");
});
