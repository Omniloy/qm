import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice-assistant/protocol.ts";
import { parseVoiceSettings, runnableVoiceSettings } from "../src/voice-assistant/settings-store.ts";

const CELIA = "rmLBOdHrfkFym9MM";
const MARCOS = "jvPx8j8zLGQ3utZz";
const HARPER = "4SZHfMpw-p46Ywgs";
const REBECA = "Sx8m6WdXBG06zwZT";

test("empty or malformed records fall back to the defaults", () => {
  assert.deepEqual(parseVoiceSettings(null), DEFAULT_VOICE_SETTINGS);
  assert.deepEqual(parseVoiceSettings([]), DEFAULT_VOICE_SETTINGS);
  assert.deepEqual(
    parseVoiceSettings({ asrEngine: "whisper", ttsEngine: "ming", micMode: "always", pttStyle: "tap" }),
    DEFAULT_VOICE_SETTINGS,
  );
});

test("records saved before engines were selectable move to the Phonon defaults and keep the voice gender", () => {
  const migrated = parseVoiceSettings({
    enabled: true,
    wakePhrase: "Oye Omni",
    language: "es",
    announceScope: "voice",
    voice: "M2",
    ttsEngine: "supertonic-3",
  });
  assert.equal(migrated.ttsEngine, "phonon-40m");
  assert.equal(migrated.asrEngine, "phonon-2.5");
  assert.equal(migrated.voice, MARCOS);
  assert.equal(migrated.micMode, "open");
  assert.equal(migrated.pttStyle, "hold");
  assert.equal(migrated.announceScope, "voice");
  assert.equal(parseVoiceSettings({ language: "en", voice: "F4", ttsEngine: "supertonic-3" }).voice, HARPER);
});

test("an explicit Supertonic choice keeps its preset voice", () => {
  const kept = parseVoiceSettings({ asrEngine: "qwen3-asr-0.6b", ttsEngine: "supertonic-3", voice: "M2" });
  assert.equal(kept.ttsEngine, "supertonic-3");
  assert.equal(kept.asrEngine, "qwen3-asr-0.6b");
  assert.equal(kept.voice, "M2");
});

test("a Phonon voice is kept for its language and replaced by the same gender's default otherwise", () => {
  const base = { asrEngine: "phonon-2.5", ttsEngine: "phonon-40m" };
  assert.equal(parseVoiceSettings({ ...base, language: "es", voice: REBECA }).voice, REBECA);
  assert.equal(parseVoiceSettings({ ...base, language: "en", voice: CELIA }).voice, HARPER);
  assert.equal(parseVoiceSettings({ ...base, language: "es", voice: "unknown" }).voice, CELIA);
  assert.equal(parseVoiceSettings({ ...base, ttsEngine: "supertonic-3", voice: CELIA }).voice, "F1");
});

test("mic mode and push-to-talk style are read when valid", () => {
  const push = parseVoiceSettings({ asrEngine: "phonon-2.5", micMode: "push", pttStyle: "toggle" });
  assert.equal(push.micMode, "push");
  assert.equal(push.pttStyle, "toggle");
});

test("gated engines fall back to Supertonic when the server cannot serve them, keeping the voice gender", () => {
  const chosen = parseVoiceSettings({ asrEngine: "phonon-2.5", ttsEngine: "phonon-40m", voice: MARCOS });
  assert.equal(runnableVoiceSettings(chosen, true).ttsEngine, "phonon-40m");
  const fallback = runnableVoiceSettings(chosen, false);
  assert.equal(fallback.ttsEngine, "supertonic-3");
  assert.equal(fallback.voice, "M1");
  const supertonic = parseVoiceSettings({ asrEngine: "qwen3-asr-0.6b", ttsEngine: "supertonic-3", voice: "F3" });
  assert.equal(runnableVoiceSettings(supertonic, false), supertonic);
});

test("engines that failed at runtime are replaced by the fallback engines", () => {
  const chosen = parseVoiceSettings({ asrEngine: "qwen3-asr-0.6b", ttsEngine: "phonon-40m", voice: CELIA });
  const failed = runnableVoiceSettings(chosen, true, new Set(["phonon-40m", "qwen3-asr-0.6b"]));
  assert.equal(failed.ttsEngine, "supertonic-3");
  assert.equal(failed.voice, "F1");
  assert.equal(failed.asrEngine, "qwen3-asr-0.6b");
  const phononAsr = runnableVoiceSettings({ ...chosen, asrEngine: "phonon-2.5" }, true, new Set(["phonon-2.5"]));
  assert.equal(phononAsr.asrEngine, "qwen3-asr-0.6b");
});
