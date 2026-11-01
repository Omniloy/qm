import assert from "node:assert/strict";
import test from "node:test";
import { chimeNotes } from "../src/voice-assistant/audio/chimes.ts";
import { createLevelBus, voiceLevel } from "../src/voice-assistant/audio/levels.ts";

const RATE = 48_000;
const FFT = 1_024;

test("silence reads as zero and a saturated voice band as one", () => {
  assert.equal(voiceLevel(new Uint8Array(FFT / 2), RATE, FFT), 0);
  assert.equal(voiceLevel(new Uint8Array(FFT / 2).fill(255), RATE, FFT), 1);
});

test("the level is the compressed mean over 100 to 8000 Hz only", () => {
  const bins = new Uint8Array(FFT / 2);
  const hzPerBin = RATE / FFT;
  const from = Math.round(100 / hzPerBin);
  const to = Math.round(8000 / hzPerBin);
  for (let i = from; i <= to; i++) bins[i] = 51;
  const expected = Math.min(1, Math.sqrt(51 / 255) * 1.8);
  assert.ok(Math.abs(voiceLevel(bins, RATE, FFT) - expected) < 1e-9);
  const outOfBand = new Uint8Array(FFT / 2);
  outOfBand.fill(255, to + 1);
  outOfBand.fill(255, 0, from);
  assert.equal(voiceLevel(outOfBand, RATE, FFT), 0);
});

test("ordinary speech lands mid-range rather than pinned", () => {
  const bins = new Uint8Array(FFT / 2).fill(20);
  const level = voiceLevel(bins, RATE, FFT);
  assert.ok(level > 0.4 && level < 0.6, `level ${level}`);
});

test("degenerate inputs read as zero", () => {
  assert.equal(voiceLevel(new Uint8Array(0), RATE, FFT), 0);
  assert.equal(voiceLevel(new Uint8Array(8).fill(255), 0, FFT), 0);
});

test("the level bus reads zero until a source is attached, and clamps", () => {
  const bus = createLevelBus();
  assert.equal(bus.read("input"), 0);
  let value = 0.4;
  bus.attach("input", { level: () => value });
  assert.equal(bus.read("input"), 0.4);
  assert.equal(bus.read("output"), 0);
  value = 3;
  assert.equal(bus.read("input"), 1);
  value = Number.NaN;
  assert.equal(bus.read("input"), 0);
  bus.attach("input", null);
  assert.equal(bus.read("input"), 0);
});

test("the wake chime rises from F5 and the error chime falls back to it", () => {
  const wake = chimeNotes("wake");
  assert.equal(wake[0].frequency, 698.46);
  assert.ok(wake[1].frequency > wake[0].frequency && wake[1].at > 0);
  const error = chimeNotes("error");
  assert.ok(error[1].frequency < error[0].frequency);
  assert.equal(error[1].frequency, 698.46);
  for (const note of chimeNotes("announce")) assert.ok(note.level > 0 && note.level < 0.1);
});
