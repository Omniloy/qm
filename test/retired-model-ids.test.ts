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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/wiring.ts";
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

test("configured retired model ids load as their successors", () => {
  const config = loadConfig({
    PI_MODEL: "claude-opus-5",
    CODEX_MODEL: "gpt-5.6-sol",
    CLAUDE_MODEL: "claude-sonnet-5",
    PI_DETECT_MODEL: "gpt-5.6-luna",
    PI_TITLE_MODEL: "claude-fable-5",
    PI_JUDGE_MODEL: "gpt-6-sol",
  });
  assert.equal(config.modelId, "claude-opus-5-5");
  assert.equal(config.opencodeModel, "claude-opus-5-5");
  assert.equal(config.codexModel, "gpt-6.1-sol");
  assert.equal(config.claudeModel, "claude-sonnet-5-5");
  assert.equal(config.detectModelId, "gpt-6-luna");
  assert.equal(config.titleModelId, "claude-fable-5-1");
  assert.equal(config.judgeModelId, "gpt-6.1-sol");
});

test("a web turn sent with a retired id from a pre-deploy tab runs on the successor", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "retired-model-ids-")),
      anthropicApiKey: "test-key",
      openaiApiKey: "test-key",
    }),
  );
  built.config.setWebuiModels(ORG, ["claude-opus-5-5", "gpt-6.1-sol"]);
  await built.config.flushScope(ORG);
  const turn = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:retired-model" },
    text: "hello",
    model: "claude-opus-5",
    async: true,
  });
  assert.equal(turn.status, "queued");
});

test("fast mode on a retired id follows its successor", () => {
  assert.equal(validateRuntimeChoice({ harnessId: "pi", modelId: "gpt-5.6-terra", fastMode: true }), null);
  assert.equal(
    validateRuntimeChoice({ harnessId: "pi", modelId: "claude-sonnet-5", fastMode: true }),
    "fast_mode_not_supported",
  );
});
