import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOICE_ORG_CONFIG,
  parseVoiceOrgConfig,
  resolveVoiceOrgConfig,
  VOICE_WAKE_PHRASE_MAX_CHARS,
} from "../src/voice/voice-config.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import type { PersistedVoiceConfig } from "../src/resolution/config-store.ts";

const full = {
  ttsEngine: "supertonic-3",
  asrEngine: "qwen3-asr-0.6b",
  wakePhrase: "Hola Omni",
  pttStyle: "toggle",
  announceScope: "voice",
};

test("the strict voice config parse requires every field and a clean wake phrase", () => {
  assert.deepEqual(parseVoiceOrgConfig({ ...full, wakePhrase: "  Hola \n Omni  ", extra: 1 }), {
    value: { ...full, wakePhrase: "Hola Omni" },
  });
  assert.deepEqual(parseVoiceOrgConfig(DEFAULT_VOICE_ORG_CONFIG), { value: DEFAULT_VOICE_ORG_CONFIG });
  for (const bad of [
    null,
    "phonon-40m",
    {},
    { ...full, ttsEngine: "kokoro" },
    { ...full, asrEngine: "whisper" },
    { ...full, pttStyle: undefined },
    { ...full, announceScope: "mine" },
    { ...full, wakePhrase: "   " },
    { ...full, wakePhrase: 7 },
    { ...full, wakePhrase: "x".repeat(VOICE_WAKE_PHRASE_MAX_CHARS + 1) },
  ]) {
    assert.ok("error" in parseVoiceOrgConfig(bad), JSON.stringify(bad));
  }
  assert.ok("value" in parseVoiceOrgConfig({ ...full, wakePhrase: "x".repeat(VOICE_WAKE_PHRASE_MAX_CHARS) }));
});

test("the lenient voice config resolve defaults each missing or invalid field on its own", () => {
  assert.deepEqual(resolveVoiceOrgConfig(null), DEFAULT_VOICE_ORG_CONFIG);
  assert.deepEqual(resolveVoiceOrgConfig(undefined), DEFAULT_VOICE_ORG_CONFIG);
  assert.deepEqual(resolveVoiceOrgConfig(full as Partial<typeof DEFAULT_VOICE_ORG_CONFIG>), full);
  assert.deepEqual(resolveVoiceOrgConfig({ ttsEngine: "kokoro", wakePhrase: "  ", pttStyle: "toggle" } as never), {
    ...DEFAULT_VOICE_ORG_CONFIG,
    pttStyle: "toggle",
  });
});

test("the durable voice config getter waits for a pending write and a null clears the row", async () => {
  const backing = createMemoryMap<PersistedVoiceConfig>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: DurableMap<PersistedVoiceConfig> = {
    ...backing,
    put: async (id, value) => {
      await gate;
      await backing.put(id, value);
    },
  };
  const store = createMemoryConfigStore("acme", { voiceConfigs: slow });
  const config = { ...DEFAULT_VOICE_ORG_CONFIG, pttStyle: "toggle" as const };
  store.setVoiceConfig("org:acme", config);
  const read = store.getVoiceConfigDurable("org:acme");
  release();
  assert.deepEqual(await read, config);
  assert.deepEqual((await backing.get("org:acme"))?.config, config);
  store.setVoiceConfig("org:acme", null);
  assert.equal(await store.getVoiceConfigDurable("org:acme"), null);
  assert.equal(await backing.get("org:acme"), null);
  store.setVoiceConfig("org:acme", config);
  await store.flushScope("org:acme");
  assert.deepEqual((await backing.get("org:acme"))?.config, config);
});
