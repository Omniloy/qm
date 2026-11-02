import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VOICE_ORG_CONFIG,
  DEFAULT_VOICE_PREFERENCES,
  type VoiceOrgConfig,
} from "../src/voice-assistant/protocol.ts";
import {
  parseVoiceOrgConfig,
  parseVoicePreferences,
  runnableVoiceSettings,
} from "../src/voice-assistant/settings-store.ts";

const CELIA = "rmLBOdHrfkFym9MM";
const MARCOS = "jvPx8j8zLGQ3utZz";
const HARPER = "4SZHfMpw-p46Ywgs";
const REBECA = "Sx8m6WdXBG06zwZT";

const org = (over: Partial<VoiceOrgConfig> = {}): VoiceOrgConfig => ({ ...DEFAULT_VOICE_ORG_CONFIG, ...over });

test("empty or malformed preference records fall back to the defaults", () => {
  assert.deepEqual(parseVoicePreferences(null), DEFAULT_VOICE_PREFERENCES);
  assert.deepEqual(parseVoicePreferences([]), DEFAULT_VOICE_PREFERENCES);
  assert.deepEqual(parseVoicePreferences({ micMode: "always", language: "xx" }), DEFAULT_VOICE_PREFERENCES);
});

test("a legacy record keeps only language, voice, mic mode and the on switch", () => {
  const migrated = parseVoicePreferences({
    enabled: true,
    wakePhrase: "Hola tú",
    language: "es",
    announceScope: "voice",
    voice: "M2",
    ttsEngine: "supertonic-3",
    asrEngine: "qwen3-asr-0.6b",
    micMode: "push",
    pttStyle: "toggle",
  });
  assert.deepEqual(migrated, { enabled: true, language: "es", voice: "M2", micMode: "push" });
  assert.equal(runnableVoiceSettings({ ...migrated, ...org() }, true).voice, MARCOS);
  const english = parseVoicePreferences({ language: "en", voice: "F4" });
  assert.equal(runnableVoiceSettings({ ...english, ...org() }, true).voice, HARPER);
});

test("the mic can be turned off", () => {
  assert.equal(parseVoicePreferences({ micMode: "off" }).micMode, "off");
});

test("a Phonon voice is kept for its language and replaced by the same gender's default otherwise", () => {
  assert.equal(parseVoicePreferences({ language: "es", voice: REBECA }).voice, REBECA);
  assert.equal(parseVoicePreferences({ language: "en", voice: CELIA }).voice, HARPER);
  assert.equal(parseVoicePreferences({ language: "es", voice: "unknown" }).voice, CELIA);
});

test("the org config is read field by field over the defaults", () => {
  assert.deepEqual(parseVoiceOrgConfig(undefined), DEFAULT_VOICE_ORG_CONFIG);
  assert.deepEqual(
    parseVoiceOrgConfig({
      ttsEngine: "supertonic-3",
      asrEngine: "whisper",
      wakePhrase: "  Hola   Omni ",
      pttStyle: "toggle",
      announceScope: "voice",
    }),
    org({ ttsEngine: "supertonic-3", wakePhrase: "Hola Omni", pttStyle: "toggle", announceScope: "voice" }),
  );
  assert.equal(parseVoiceOrgConfig({ wakePhrase: "x".repeat(61) }).wakePhrase, "Oye Omni");
  assert.equal(parseVoiceOrgConfig({ wakePhrase: "   " }).wakePhrase, "Oye Omni");
});

test("a voice of another engine is kept as the preference and each engine speaks its own match", () => {
  const stored = { ...parseVoicePreferences({ voice: "M3" }), ...org() };
  assert.equal(stored.voice, "M3");
  assert.equal(runnableVoiceSettings(stored, false).voice, "M3");
  assert.equal(runnableVoiceSettings(stored, false).ttsEngine, "supertonic-3");
  assert.equal(runnableVoiceSettings(stored, true).voice, MARCOS);
  assert.equal(runnableVoiceSettings(stored, true).ttsEngine, "phonon-40m");
  const supertonic = { ...parseVoicePreferences({ voice: CELIA }), ...org({ ttsEngine: "supertonic-3" }) };
  assert.equal(runnableVoiceSettings(supertonic, true).voice, "F1");
});

test("gated engines fall back to Supertonic when the server cannot serve them, keeping the voice gender", () => {
  const chosen = { ...parseVoicePreferences({ voice: MARCOS }), ...org() };
  assert.equal(runnableVoiceSettings(chosen, true).ttsEngine, "phonon-40m");
  const fallback = runnableVoiceSettings(chosen, false);
  assert.equal(fallback.ttsEngine, "supertonic-3");
  assert.equal(fallback.voice, "M1");
  const supertonic = {
    ...parseVoicePreferences({ voice: "F3" }),
    ...org({ ttsEngine: "supertonic-3", asrEngine: "qwen3-asr-0.6b" }),
  };
  assert.equal(runnableVoiceSettings(supertonic, false), supertonic);
});

test("engines that failed at runtime are replaced by the fallback engines", () => {
  const chosen = { ...parseVoicePreferences({ voice: CELIA }), ...org({ asrEngine: "qwen3-asr-0.6b" }) };
  const failed = runnableVoiceSettings(chosen, true, new Set(["phonon-40m", "qwen3-asr-0.6b"]));
  assert.equal(failed.ttsEngine, "supertonic-3");
  assert.equal(failed.voice, "F1");
  assert.equal(failed.asrEngine, "qwen3-asr-0.6b");
  const phononAsr = runnableVoiceSettings({ ...chosen, asrEngine: "phonon-2.5" }, true, new Set(["phonon-2.5"]));
  assert.equal(phononAsr.asrEngine, "qwen3-asr-0.6b");
});
