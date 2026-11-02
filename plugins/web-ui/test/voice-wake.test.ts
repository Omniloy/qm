import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice-assistant/protocol.ts";
import { WAKE_THRESHOLD, matchWake, normalizeSpeech } from "../src/voice-assistant/wake.ts";

const CAROLINA = "hey carolina";
const OMNI = DEFAULT_VOICE_SETTINGS.wakePhrase;

function wake(text: string, phrase: string): [boolean, string] {
  const match = matchWake(text, phrase);
  return [match.matched, match.remainder];
}

test("normalizeSpeech folds accents, punctuation and case", () => {
  assert.equal(normalizeSpeech("¡Adelánte, Señor!  ¿Qué tal?"), "adelante senor que tal");
  assert.equal(normalizeSpeech("   "), "");
});

test("the configured phrase and greeting variants wake", () => {
  assert.deepEqual(wake("hey carolina", CAROLINA), [true, ""]);
  assert.deepEqual(wake("hola carolina", CAROLINA), [true, ""]);
  assert.deepEqual(wake("oye carolina", CAROLINA), [true, ""]);
  assert.deepEqual(wake("carolina", CAROLINA), [true, ""]);
});

test("accents, punctuation and casing are folded", () => {
  assert.deepEqual(wake("¡Hey, Carolina!", CAROLINA), [true, ""]);
  assert.deepEqual(wake("HEY CAROLINA", CAROLINA), [true, ""]);
});

test("the words after the phrase carry over as the request", () => {
  assert.deepEqual(wake("hey carolina cómo van mis tareas", CAROLINA), [true, "cómo van mis tareas"]);
  assert.deepEqual(wake("Carolina, apaga la luz", CAROLINA), [true, "apaga la luz"]);
});

test("near misses do not wake", () => {
  assert.deepEqual(wake("hey carol", CAROLINA), [false, ""]);
  assert.deepEqual(wake("le decía a carolina que viniera", CAROLINA), [false, ""]);
  assert.deepEqual(wake("", CAROLINA), [false, ""]);
  assert.deepEqual(wake("hey there", CAROLINA), [false, ""]);
});

test("a one-letter slip in a long name is forgiven", () => {
  const match = matchWake("caroline", CAROLINA);
  assert.equal(match.matched, true);
  assert.ok(match.score >= WAKE_THRESHOLD && match.score < 1);
});

test("custom phrases wake and keep their remainder", () => {
  assert.deepEqual(wake("Hi, I noticed a charge on my debit card", "hi"), [
    true,
    "I noticed a charge on my debit card",
  ]);
  assert.deepEqual(wake("hi", "hi"), [true, ""]);
  assert.deepEqual(wake("ok computer play music", "ok computer"), [true, "play music"]);
  assert.deepEqual(wake("hip hop", "hi"), [false, ""]);
});

test("the default phrase wakes and carries the question", () => {
  assert.equal(OMNI, "Oye Omni");
  assert.deepEqual(wake("Oye Omni, ¿qué tareas tengo?", OMNI), [true, "¿qué tareas tengo?"]);
  assert.deepEqual(wake("Oye, Omni.", OMNI), [true, ""]);
  assert.deepEqual(wake("hola omni qué hora es", OMNI), [true, "qué hora es"]);
  assert.deepEqual(wake("Hey Omni", OMNI), [true, ""]);
  assert.deepEqual(wake("Omni, abre la última tarea", OMNI), [true, "abre la última tarea"]);
});

test("common transcription variants of the default phrase still wake", () => {
  assert.deepEqual(wake("Olle omni, ¿qué tal?", OMNI), [true, "¿qué tal?"]);
  assert.deepEqual(wake("oye homni", OMNI), [true, ""]);
  assert.deepEqual(wake("Oye Omny dime algo", OMNI), [true, "dime algo"]);
  assert.deepEqual(wake("oye om ni qué hora es", OMNI), [true, "qué hora es"]);
  assert.deepEqual(wake("Hoy Omni, cuantos correos sin leer tengo", OMNI), [true, "cuantos correos sin leer tengo"]);
});

test("Phonon-2.5 renderings of the default phrase wake", () => {
  assert.deepEqual(wake("Oye omni.", OMNI), [true, ""]);
  assert.deepEqual(wake("Oye omi, qué tal.", OMNI), [true, "qué tal."]);
  assert.deepEqual(wake("Hoy Omni", OMNI), [true, ""]);
  assert.deepEqual(wake("Hej ommi!", OMNI), [true, ""]);
  assert.deepEqual(wake("Oj omni.", OMNI), [true, ""]);
  assert.deepEqual(wake("Oje omni, ¿cuántas tareas tengo?", OMNI), [true, "¿cuántas tareas tengo?"]);
  assert.deepEqual(wake("Odje omni!", OMNI), [true, ""]);
  assert.deepEqual(wake("Ojomni, qué hora es", OMNI), [true, "qué hora es"]);
  assert.deepEqual(wake("Ojelmný", OMNI), [true, ""]);
});

test("Spanish words spelled with j do not wake", () => {
  for (const text of ["Ojalá llueva", "jamón ibérico", "Dejé el coche", "ojo", "joya", "viaje"])
    assert.deepEqual(wake(text, OMNI), [false, ""], text);
});

test("the default phrase does not wake on unrelated speech", () => {
  assert.deepEqual(wake("el ómnibus llega tarde", OMNI), [false, ""]);
  assert.deepEqual(wake("oye mamá", OMNI), [false, ""]);
  assert.deepEqual(wake("le dije a omni que esperara", OMNI), [false, ""]);
  assert.deepEqual(wake("omnipresente", OMNI), [false, ""]);
  assert.deepEqual(wake("hoy hace calor", OMNI), [false, ""]);
});

test("the score is reported even when the phrase does not wake", () => {
  const miss = matchWake("oye mamá", OMNI);
  assert.equal(miss.matched, false);
  assert.ok(miss.score > 0 && miss.score < WAKE_THRESHOLD);
  assert.deepEqual(matchWake("hola", ""), { matched: false, score: 0, remainder: "" });
});
