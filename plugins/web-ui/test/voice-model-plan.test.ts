import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE_ORG_CONFIG, DEFAULT_VOICE_PREFERENCES } from "../src/voice-assistant/protocol.ts";

const accessBodies: Array<{ status: number; body: unknown }> = [];
let accessCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://localhost/");
  if (url.pathname !== "/api/voice/access") return new Response("{}", { status: 404 });
  accessCalls++;
  const next = accessBodies.shift() ?? { status: 500, body: {} };
  return new Response(JSON.stringify(next.body), { status: next.status });
}) as typeof fetch;

const { effectiveVoiceSettings, forgetVoiceAccess, voiceAccess, voiceModelFiles } =
  await import("../src/voice-assistant/model-plan.ts");

const GPU = { webgpu: true, shaderF16: true };
const preferences = { ...DEFAULT_VOICE_PREFERENCES, enabled: true };

test("the org config from the access check reaches the runtime settings", async () => {
  accessBodies.push({
    status: 200,
    body: {
      enabled: true,
      gatedModels: true,
      config: {
        ttsEngine: "supertonic-3",
        asrEngine: "qwen3-asr-0.6b",
        wakePhrase: "Hola Omni",
        pttStyle: "toggle",
        announceScope: "voice",
      },
    },
  });
  forgetVoiceAccess();
  const access = await voiceAccess();
  const settings = effectiveVoiceSettings({ ...preferences, micMode: "push" }, access);
  assert.equal(settings.ttsEngine, "supertonic-3");
  assert.equal(settings.asrEngine, "qwen3-asr-0.6b");
  assert.equal(settings.wakePhrase, "Hola Omni");
  assert.equal(settings.pttStyle, "toggle");
  assert.equal(settings.announceScope, "voice");
  assert.equal(settings.micMode, "push");
  assert.equal(settings.voice, "F1", "the preferred voice maps onto the org engine");
  await voiceAccess();
  assert.equal(accessCalls, 1, "the access check is cached for the page");
});

test("the engine fallbacks still apply on top of the org engines", async () => {
  accessBodies.push({ status: 200, body: { enabled: true, gatedModels: false, config: DEFAULT_VOICE_ORG_CONFIG } });
  forgetVoiceAccess();
  const settings = effectiveVoiceSettings(preferences, await voiceAccess());
  assert.equal(settings.ttsEngine, "supertonic-3", "no HF_TOKEN means Supertonic");
  assert.equal(settings.asrEngine, "phonon-2.5");
});

test("a failed access check uses the defaults and is retried next time", async () => {
  forgetVoiceAccess();
  const calls = accessCalls;
  const access = await voiceAccess();
  assert.deepEqual(access, { gatedModels: true, config: DEFAULT_VOICE_ORG_CONFIG });
  accessBodies.push({ status: 200, body: { enabled: true, gatedModels: true, config: { wakePhrase: "Eh Omni" } } });
  const retried = await voiceAccess();
  assert.equal(accessCalls, calls + 2);
  assert.equal(retried.config.wakePhrase, "Eh Omni");
  assert.equal(retried.config.ttsEngine, DEFAULT_VOICE_ORG_CONFIG.ttsEngine);
});

test("with the mic off no recognition model is downloaded", () => {
  const settings = { ...preferences, ...DEFAULT_VOICE_ORG_CONFIG };
  const open = voiceModelFiles(GPU, settings);
  const off = voiceModelFiles(GPU, { ...settings, micMode: "off" });
  assert.ok(open.some((file) => file.role === "asr"));
  assert.ok(off.length > 0);
  assert.ok(off.every((file) => file.role === "tts"));
  assert.deepEqual(
    off,
    open.filter((file) => file.role === "tts"),
  );
});
