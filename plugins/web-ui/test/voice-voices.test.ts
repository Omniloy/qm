import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_LOCALES, modelFileKey } from "../src/voice-assistant/protocol.ts";
import {
  PHONON_TTS_MODEL_FILES,
  PHONON_VOICE_FILES,
  SUPERTONIC_MODEL_FILES,
  TTS_MODEL_FILES,
  ttsEngineFiles,
  ttsFilesFor,
  ttsWarmupVoice,
} from "../src/voice-assistant/tts/models.ts";
import {
  PHONON_VOICES,
  SUPERTONIC_VOICES,
  VOICE_LOCALE_LABELS,
  pickVoice,
  supportedVoice,
  voiceChoices,
  voiceLabel,
  voicesFor,
} from "../src/voice-assistant/voices.ts";

const CELIA = "rmLBOdHrfkFym9MM";
const MARCOS = "jvPx8j8zLGQ3utZz";
const HARPER = "4SZHfMpw-p46Ywgs";
const PRESTON = "qIxlZ7Ei8KvWlyQH";
const REBECA = "Sx8m6WdXBG06zwZT";

test("the Phonon catalogue covers every UI locale with both genders and ids core accepts", () => {
  assert.equal(PHONON_VOICES.length, 50);
  const ids = [...PHONON_VOICES, ...SUPERTONIC_VOICES].map((voice) => voice.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const voice of PHONON_VOICES) {
    assert.match(voice.id, /^[A-Za-z0-9_.-]{1,32}$/);
    assert.equal(voice.engine, "phonon-40m");
    assert.deepEqual(voice.languages, [voice.locale!.slice(0, 2)]);
  }
  for (const locale of VOICE_LOCALES) {
    for (const gender of ["female", "male"] as const)
      assert.ok(PHONON_VOICES.filter((v) => v.locale === locale && v.gender === gender).length >= 6, locale + gender);
  }
  for (const language of ["es", "en"] as const) assert.ok(voicesFor("phonon-40m", language).length <= 32);
});

test("labels carry the accent in the UI language and locale groups have headers", () => {
  const choices = voiceChoices({ ttsEngine: "phonon-40m", language: "es" });
  assert.deepEqual(
    choices.find((c) => c.id === REBECA),
    {
      id: REBECA,
      label: "Rebeca (México)",
      gender: "female",
      locale: "es-MX",
    },
  );
  assert.ok(choices.every((c) => c.locale === "es-ES" || c.locale === "es-MX"));
  assert.equal(voiceLabel({ ttsEngine: "phonon-40m", language: "en", voice: HARPER }), "Harper (US)");
  assert.equal(VOICE_LOCALE_LABELS["en-GB"].es, "Inglés (Reino Unido)");
  const supertonic = voiceChoices({ ttsEngine: "supertonic-3", language: "en" });
  assert.equal(supertonic.length, 10);
  assert.ok(supertonic.every((c) => c.locale === undefined));
});

test("supported voices keep a valid pick and otherwise map to the engine default of the same gender", () => {
  assert.equal(supportedVoice("phonon-40m", "es", REBECA), REBECA);
  assert.equal(supportedVoice("phonon-40m", "en", REBECA), HARPER);
  assert.equal(supportedVoice("phonon-40m", "es", "M3"), MARCOS);
  assert.equal(supportedVoice("phonon-40m", "en", MARCOS), PRESTON);
  assert.equal(supportedVoice("phonon-40m", "es", "nope"), CELIA);
  assert.equal(supportedVoice("supertonic-3", "es", MARCOS), "M1");
  assert.equal(supportedVoice("supertonic-3", "en", "F4"), "F4");
});

test("pickVoice chooses by id, gender or next within the current language", () => {
  const settings = { ttsEngine: "phonon-40m", language: "es", voice: CELIA } as const;
  assert.equal(pickVoice(settings, { voice: REBECA }), REBECA);
  assert.equal(pickVoice(settings, { voice: HARPER }), null);
  const male = pickVoice(settings, { gender: "male" });
  assert.equal(PHONON_VOICES.find((v) => v.id === male)?.gender, "male");
  const next = pickVoice(settings, { next: true });
  assert.ok(next && next !== CELIA);
});

test("the manifest pins the gated q8 model and every catalogue voice with size and digest", () => {
  assert.deepEqual(
    PHONON_TTS_MODEL_FILES.map((f) => f.path),
    ["model.q8.gguf", "tokenizer.json", "config.json"],
  );
  for (const file of PHONON_TTS_MODEL_FILES) {
    assert.equal(file.repo, "gradium/phonon-40m-multilingual");
    assert.equal(file.revision, "1537ce46c64f42903e0d608b132ccb073dac46d2");
    assert.equal(file.gated, true);
  }
  assert.deepEqual([...PHONON_VOICE_FILES.keys()].sort(), PHONON_VOICES.map((v) => v.id).sort());
  for (const [id, file] of PHONON_VOICE_FILES) {
    assert.equal(file.repo, "gradium/phonon-voices");
    assert.equal(file.revision, "0ee17205f254b5abc43b266c8a0f215565c352f7");
    assert.equal(file.path, `voices/${id}.safetensors`);
    assert.equal(file.bytes, 256_136);
    assert.equal(file.gated, undefined);
  }
  for (const file of TTS_MODEL_FILES) {
    assert.equal(file.role, "tts");
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.bytes > 0);
  }
  const keys = TTS_MODEL_FILES.map(modelFileKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(
    TTS_MODEL_FILES.length,
    PHONON_TTS_MODEL_FILES.length + PHONON_VOICE_FILES.size + SUPERTONIC_MODEL_FILES.length,
  );
});

test("an engine may read all its files but downloads only its core, the warm-up voice and the chosen voice", () => {
  assert.equal(ttsEngineFiles("phonon-40m").length, 53);
  assert.equal(ttsEngineFiles("supertonic-3").length, SUPERTONIC_MODEL_FILES.length);
  assert.equal(ttsWarmupVoice("phonon-40m"), CELIA);
  assert.equal(ttsWarmupVoice("supertonic-3"), "F1");
  assert.deepEqual(
    ttsFilesFor("phonon-40m", HARPER).map((f) => f.path),
    ["model.q8.gguf", "tokenizer.json", "config.json", `voices/${CELIA}.safetensors`, `voices/${HARPER}.safetensors`],
  );
  assert.equal(ttsFilesFor("phonon-40m", CELIA).length, 4);
  const supertonic = ttsFilesFor("supertonic-3", "M2").map((f) => f.path);
  assert.deepEqual(supertonic.slice(-2), ["voice_styles/F1.json", "voice_styles/M2.json"]);
  assert.equal(supertonic.length, 8);
  const bytes = ttsFilesFor("phonon-40m", HARPER).reduce((sum, f) => sum + f.bytes, 0);
  assert.equal(bytes, 74_553_568 + 277_749 + 4_674 + 2 * 256_136);
});
