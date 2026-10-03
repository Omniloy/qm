import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedModelClassification } from "../src/resolution/config-store.ts";
import { effectiveStatus, isHiddenStatus } from "../src/model/model-classification.ts";
import { scopeId } from "../src/types.ts";

const org = scopeId("org", "default-org");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("model classifications default empty and store only real overrides", async () => {
  const backing = createMemoryMap<PersistedModelClassification>();
  const store = createMemoryConfigStore("default-org", { modelClassifications: backing });
  await store.hydrate!();

  assert.deepEqual(store.getModelClassifications(org), {});
  assert.deepEqual(await store.getModelClassificationsDurable(org), {});

  store.setModelClassification(org, "claude-opus-5-5", "legacy");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), { "claude-opus-5-5": "legacy" });
  assert.deepEqual(await store.getModelClassificationsDurable(org), { "claude-opus-5-5": "legacy" });

  store.setModelClassification(org, "claude-sonnet-5-5", "hidden");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), { "claude-opus-5-5": "legacy", "claude-sonnet-5-5": "hidden" });

  store.setModelClassification(org, "claude-opus-5-5", "active");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), { "claude-sonnet-5-5": "hidden" });

  store.setModelClassification(org, "claude-sonnet-5-5", "active");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), {});
  assert.deepEqual(await backing.all(), []);
});

test("model classifications survive a second app instance on the same durable store", async () => {
  const backing = createMemoryMap<PersistedModelClassification>();
  const first = createMemoryConfigStore("default-org", { modelClassifications: backing });
  await first.hydrate!();
  first.setModelClassification(org, "claude-opus-5-5", "legacy");
  await settle();

  const second = createMemoryConfigStore("default-org", { modelClassifications: backing });
  await second.hydrate!();
  assert.deepEqual(second.getModelClassifications(org), { "claude-opus-5-5": "legacy" });
  assert.deepEqual(await second.getModelClassificationsDurable(org), { "claude-opus-5-5": "legacy" });
});

test("two instances classifying different models both land, merged against the stored row", async () => {
  const backing = createMemoryMap<PersistedModelClassification>();
  const first = createMemoryConfigStore("default-org", { modelClassifications: backing });
  const second = createMemoryConfigStore("default-org", { modelClassifications: backing });
  await first.hydrate!();
  await second.hydrate!();

  first.setModelClassification(org, "claude-opus-5-5", "legacy");
  await first.flushScope(org);
  second.setModelClassification(org, "claude-sonnet-5-5", "hidden");
  await second.flushScope(org);

  const expected = { "claude-opus-5-5": "legacy", "claude-sonnet-5-5": "hidden" };
  assert.deepEqual(await first.getModelClassificationsDurable(org), expected);
  assert.deepEqual(second.getModelClassifications(org), expected);
  await first.refreshScope(org);
  assert.deepEqual(first.getModelClassifications(org), expected);
});

test("flushScope waits for classification and browser-provider writes before returning", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const backing = createMemoryMap<PersistedModelClassification>();
  const slow = {
    ...backing,
    put: async (id: string, v: PersistedModelClassification) => {
      await gate;
      return backing.put(id, v);
    },
  };
  const store = createMemoryConfigStore("default-org", { modelClassifications: slow });
  await store.hydrate!();
  store.setModelClassification(org, "claude-opus-5-5", "legacy");
  store.setBrowserProvider(org, "extension");
  let flushed = false;
  const flushing = store.flushScope(org).then(() => (flushed = true));
  await settle();
  assert.equal(flushed, false);
  release();
  await flushing;
  assert.deepEqual((await backing.get(org))?.statuses, { "claude-opus-5-5": "legacy" });
  assert.equal(await store.getBrowserProviderDurable(org), "extension");
});

test("models are active until an administrator classifies them", () => {
  assert.equal(effectiveStatus("claude-opus-5-5", {}), "active");
  assert.equal(effectiveStatus("gpt-6.1-sol", {}), "active");

  assert.equal(isHiddenStatus("hidden"), true);
  assert.equal(isHiddenStatus("deprecated"), true);
  assert.equal(isHiddenStatus("legacy"), false);
  assert.equal(isHiddenStatus("active"), false);
  assert.equal(isHiddenStatus(undefined), false);

  assert.equal(effectiveStatus("claude-opus-4-8", { "claude-opus-4-8": "hidden" }), "hidden");
  assert.equal(effectiveStatus("claude-opus-5-5", { "claude-opus-5-5": "deprecated" }), "deprecated");
});
