import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenDecoder } from "../src/voice-assistant/asr/tokenizer.ts";

const vocab = {
  Oye: 0,
  ĠOmni: 1,
  ",": 2,
  "ĠÂ¿": 3,
  "quÃ©": 4,
  Ġma: 5,
  Ã: 6,
  "±": 7,
  ana: 8,
  "?": 9,
  Ċ: 10,
  "€uro": 11,
  ĠðŁİ: 12,
  "¤": 13,
};

const decoder = createTokenDecoder(new TextEncoder().encode(JSON.stringify(vocab)));

test("byte-level BPE decode maps Ġ to spaces and restores accented UTF-8", () => {
  assert.equal(decoder.decode([0, 1, 2, 3, 4, 9]), "Oye Omni, ¿qué?");
});

test("a multi-byte character split across tokens is reassembled", () => {
  assert.equal(decoder.decode([5, 6, 7, 8]), " mañana");
  assert.equal(decoder.decode([12, 13]), " 🎤");
});

test("newlines decode while special ids and non-byte-level tokens are skipped", () => {
  assert.equal(decoder.decode([0, 10, 11, 151_645, 1]), "Oye\n Omni");
});

test("an empty id list decodes to an empty string", () => {
  assert.equal(decoder.decode([]), "");
});
