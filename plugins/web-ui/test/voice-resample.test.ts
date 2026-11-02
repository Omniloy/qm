import assert from "node:assert/strict";
import test from "node:test";
import { createFrameAssembler, downmix } from "../src/voice-assistant/audio/frames.ts";
import { createDownsampler, createLinearResampler } from "../src/voice-assistant/audio/resample.ts";
import { SPEECH_FRAME_SAMPLES, SPEECH_SAMPLE_RATE } from "../src/voice-assistant/protocol.ts";

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sine(length: number, rate: number, hz: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
}

function splitInto(input: Float32Array, size: number): Float32Array[] {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += size) parts.push(input.slice(i, i + size));
  return parts;
}

test("downsampling 48 kHz to 16 kHz keeps a constant level and a third of the samples", () => {
  const out = createDownsampler(48_000, SPEECH_SAMPLE_RATE)(new Float32Array(48_000).fill(0.5));
  assert.equal(out.length, 16_000);
  for (const v of out) assert.ok(Math.abs(v - 0.5) < 1e-6);
});

test("downsampling carries the fractional position across render quanta", () => {
  for (const rate of [44_100, 48_000, 96_000, 22_050]) {
    const input = sine(rate, rate, 220);
    const oneShot = createDownsampler(rate, SPEECH_SAMPLE_RATE)(input);
    const streaming = createDownsampler(rate, SPEECH_SAMPLE_RATE);
    const pieces = concat(splitInto(input, 128).map((p) => streaming(p)));
    assert.equal(pieces.length, oneShot.length, `rate ${rate}`);
    assert.ok(Math.abs(pieces.length - SPEECH_SAMPLE_RATE) <= 1, `rate ${rate} gave ${pieces.length}`);
    for (let i = 0; i < oneShot.length; i++) assert.ok(Math.abs(pieces[i] - oneShot[i]) < 1e-5);
  }
});

test("equal rates pass audio through untouched", () => {
  const input = new Float32Array([0.1, 0.2, 0.3]);
  assert.equal(createDownsampler(16_000, 16_000)(input), input);
  assert.equal(createLinearResampler(16_000, 16_000)(input), input);
});

test("a downsampler asked to upsample interpolates instead", () => {
  const out = createDownsampler(8_000, 16_000)(new Float32Array(800).fill(0.25));
  assert.ok(Math.abs(out.length - 1600) <= 2);
  for (const v of out) assert.ok(Math.abs(v - 0.25) < 1e-6);
});

test("invalid rates are rejected", () => {
  assert.throws(() => createDownsampler(0, 16_000), RangeError);
  assert.throws(() => createLinearResampler(44_100, Number.NaN), RangeError);
});

test("linear resampling 44.1 kHz to 48 kHz is continuous across chunks", () => {
  const input = sine(44_100, 44_100, 440);
  const oneShot = createLinearResampler(44_100, 48_000)(input);
  const streaming = createLinearResampler(44_100, 48_000);
  const pieces = concat(splitInto(input, 1_000).map((p) => streaming(p)));
  assert.equal(pieces.length, oneShot.length);
  assert.ok(Math.abs(pieces.length - 48_000) <= 1);
  for (let i = 0; i < oneShot.length; i++) assert.ok(Math.abs(pieces[i] - oneShot[i]) < 1e-5);
  const expected = sine(48_000, 48_000, 440);
  let worst = 0;
  for (let i = 0; i < 47_000; i++) worst = Math.max(worst, Math.abs(oneShot[i] - expected[i]));
  assert.ok(worst < 0.01, `max interpolation error ${worst}`);
});

test("linear resampling starts on the first input sample", () => {
  const out = createLinearResampler(24_000, 48_000)(new Float32Array([1, 3, 5]));
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5]);
  assert.equal(createLinearResampler(24_000, 48_000)(new Float32Array(0)).length, 0);
});

test("frames come out exactly frameSamples long in fresh transferable buffers", () => {
  const assemble = createFrameAssembler(SPEECH_FRAME_SAMPLES);
  const input = Float32Array.from({ length: 1_300 }, (_, i) => i);
  const frames = [...assemble(input.subarray(0, 700)), ...assemble(input.subarray(700))];
  assert.equal(frames.length, 2);
  for (const frame of frames) {
    assert.equal(frame.length, SPEECH_FRAME_SAMPLES);
    assert.equal(frame.buffer.byteLength, SPEECH_FRAME_SAMPLES * 4);
  }
  assert.notEqual(frames[0].buffer, frames[1].buffer);
  assert.equal(frames[1][0], SPEECH_FRAME_SAMPLES);
  const next = assemble(new Float32Array(SPEECH_FRAME_SAMPLES - 276));
  assert.equal(next.length, 1);
  assert.equal(next[0][0], 1_024);
  assert.equal(next[0][275], 1_299);
  assert.equal(next[0][276], 0);
  assert.throws(() => createFrameAssembler(0), RangeError);
});

test("downmix averages channels and passes mono through", () => {
  const left = new Float32Array([1, 0, 0.5]);
  assert.equal(downmix([left]), left);
  assert.deepEqual(Array.from(downmix([left, new Float32Array([0, 1, 0.5])]) ?? []), [0.5, 0.5, 0.5]);
  assert.equal(downmix([]), null);
});
