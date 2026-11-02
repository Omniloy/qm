import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MEL_BINS } from "../src/voice-assistant/asr/mel.ts";
import { nemoLogMel } from "../src/voice-assistant/asr/phonon-mel.ts";

interface PhononMelReference {
  samples: number;
  frames: number;
  sampled: number[];
  data: number[];
}

const reference = JSON.parse(
  readFileSync(new URL("./fixtures/voice-phonon-mel-reference.json", import.meta.url), "utf8"),
) as PhononMelReference;

function referenceSignal(count: number): Float32Array {
  const audio = new Float32Array(count);
  let seed = 12345;
  for (let i = 0; i < count; i++) {
    seed = (seed * 48271) % 2147483647;
    const noise = ((Math.floor(seed / 256) % 2001) - 1000) / 8000;
    const triangle = (((i * 7) % 160) - 80) / 400;
    const square = Math.floor(i / 400) % 2 === 0 ? (Math.floor(i / 20) % 2) * 0.25 - 0.125 : 0;
    audio[i] = noise + triangle + square;
  }
  return audio;
}

test("NeMo log-mel matches the transformers ParakeetFeatureExtractor on its valid frames", () => {
  const { data, frames } = nemoLogMel(referenceSignal(reference.samples));
  assert.equal(frames, reference.frames);
  assert.equal(data.length, frames * MEL_BINS);
  let worst = 0;
  reference.sampled.forEach((frame, row) => {
    for (let m = 0; m < MEL_BINS; m++) {
      worst = Math.max(worst, Math.abs(data[frame * MEL_BINS + m] - reference.data[row * MEL_BINS + m]));
    }
  });
  assert.ok(worst < 1e-3, `max difference ${worst}`);
});

test("every mel band is normalised to zero mean and unit sample deviation", () => {
  const { data, frames } = nemoLogMel(referenceSignal(8_000));
  for (const m of [0, 40, 127]) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += data[f * MEL_BINS + m];
    const mean = sum / frames;
    let squares = 0;
    for (let f = 0; f < frames; f++) squares += (data[f * MEL_BINS + m] - mean) ** 2;
    assert.ok(Math.abs(mean) < 1e-5);
    assert.ok(Math.abs(Math.sqrt(squares / (frames - 1)) - 1) < 1e-3);
  }
});

test("audio shorter than two hops yields no frames, and silence normalises to zeros instead of NaN", () => {
  assert.deepEqual(nemoLogMel(new Float32Array(319)), { data: new Float32Array(0), frames: 0 });
  const silent = nemoLogMel(new Float32Array(1_600));
  assert.equal(silent.frames, 10);
  assert.ok(silent.data.every((value) => Math.abs(value) < 1e-6));
});
