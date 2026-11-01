import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MEL_BINS, logMel, slaneyFilterbank } from "../src/voice-assistant/asr/mel.ts";

interface MelReference {
  samples: number;
  frames: number;
  data: number[];
}

const reference = JSON.parse(
  readFileSync(new URL("./fixtures/voice-mel-reference.json", import.meta.url), "utf8"),
) as MelReference;

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

test("log-mel matches the numpy Whisper reference computed with the model's filterbank", () => {
  const { data, frames } = logMel(referenceSignal(reference.samples));
  assert.equal(frames, reference.frames);
  assert.equal(data.length, MEL_BINS * frames);
  let worst = 0;
  for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(data[i] - reference.data[i]));
  assert.ok(worst < 1e-4, `max abs diff ${worst}`);
});

test("log-mel drops the trailing frame and never pads to thirty seconds", () => {
  assert.equal(logMel(new Float32Array(16_000)).frames, 100);
  assert.equal(logMel(new Float32Array(16_159)).frames, 100);
  assert.equal(logMel(new Float32Array(48_000)).frames, 300);
});

test("log-mel of audio shorter than one hop is empty", () => {
  const { data, frames } = logMel(new Float32Array(159));
  assert.equal(frames, 0);
  assert.equal(data.length, 0);
});

test("log-mel clamps silence to the floor and stays finite", () => {
  const { data } = logMel(new Float32Array(3_200));
  assert.ok(data.every((v) => v === (-10 + 4) / 4));
});

test("the slaney filterbank matches the model's mel_filters.json", () => {
  const filters = slaneyFilterbank();
  const freqBins = 201;
  const spots: [number, number, number][] = [
    [0, 1, 0.0123739867],
    [1, 1, 0.0303925648],
    [4, 3, 0.037121959],
    [100, 103, 0.0053119459],
    [127, 198, 0.0022285604],
    [10, 9, 0],
  ];
  for (const [mel, bin, expected] of spots) {
    assert.ok(Math.abs(filters[mel * freqBins + bin] - expected) < 1e-8, `filter ${mel},${bin}`);
  }
  assert.equal(filters.filter((v) => v > 0).length, 394);
});
