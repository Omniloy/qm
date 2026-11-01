import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackQueue } from "../src/voice-assistant/audio/playback-queue.ts";
import type { PlaybackWorkletOut } from "../src/voice-assistant/protocol.ts";

const QUANTUM = 128;

function setup(outputRate = 48_000) {
  const posted: PlaybackWorkletOut[] = [];
  const queue = createPlaybackQueue(outputRate, (m) => posted.push(m));
  const render = (quanta: number) => {
    const out: number[] = [];
    for (let q = 0; q < quanta; q++) {
      const buffer = new Float32Array(QUANTUM).fill(9);
      queue.render(buffer);
      out.push(...buffer);
    }
    return out;
  };
  return { queue, posted, render };
}

test("pushed audio plays in order, then silence, and drains after end", () => {
  const { queue, posted, render } = setup();
  queue.handle({ type: "push", utteranceId: "a", pcm: new Float32Array(1_000).fill(0.5), sampleRate: 48_000 });
  queue.handle({ type: "push", utteranceId: "a", pcm: new Float32Array(500).fill(0.25), sampleRate: 48_000 });
  queue.handle({ type: "end", utteranceId: "a" });
  const out = render(13);
  assert.equal(out[999], 0.5);
  assert.equal(out[1_000], 0.25);
  assert.equal(out[1_499], 0.25);
  assert.ok(out.slice(1_500).every((v) => v === 0));
  assert.ok(out[0] < 0.5, "the first samples fade in");
  const drained = posted.filter((m) => m.type === "drained");
  assert.deepEqual(drained, [{ type: "drained", utteranceId: "a" }]);
  const lastProgress = posted.filter((m) => m.type === "progress").at(-1);
  assert.deepEqual(lastProgress, { type: "progress", utteranceId: "a", playedSamples: 1_500, sampleRate: 48_000 });
});

test("an utterance does not drain until end arrives", () => {
  const { queue, posted, render } = setup();
  queue.handle({ type: "push", utteranceId: "a", pcm: new Float32Array(64), sampleRate: 48_000 });
  render(2);
  assert.equal(
    posted.some((m) => m.type === "drained"),
    false,
  );
  queue.handle({ type: "end", utteranceId: "a" });
  assert.deepEqual(posted.at(-1), { type: "drained", utteranceId: "a" });
});

test("end for an unknown utterance drains at once", () => {
  const { queue, posted } = setup();
  queue.handle({ type: "end", utteranceId: "ghost" });
  assert.deepEqual(posted, [{ type: "drained", utteranceId: "ghost" }]);
});

test("flush silences the very next render quantum and drops everything", () => {
  const { queue, posted, render } = setup();
  queue.handle({ type: "push", utteranceId: "a", pcm: new Float32Array(48_000).fill(0.5), sampleRate: 48_000 });
  queue.handle({ type: "push", utteranceId: "b", pcm: new Float32Array(4_800).fill(0.5), sampleRate: 48_000 });
  render(1);
  queue.handle({ type: "flush" });
  assert.deepEqual(posted.slice(-2), [
    { type: "progress", utteranceId: "a", playedSamples: QUANTUM, sampleRate: 48_000 },
    { type: "flushed" },
  ]);
  assert.ok(render(1).every((v) => v === 0));
  queue.handle({ type: "end", utteranceId: "a" });
  assert.deepEqual(posted.at(-1), { type: "drained", utteranceId: "a" });
});

test("progress counts source-rate samples about every 100 ms", () => {
  const { queue, posted, render } = setup(48_000);
  queue.handle({ type: "push", utteranceId: "s", pcm: new Float32Array(44_100).fill(0.1), sampleRate: 44_100 });
  queue.handle({ type: "end", utteranceId: "s" });
  render(Math.ceil(48_100 / QUANTUM));
  const progress = posted.filter((m) => m.type === "progress");
  assert.ok(progress.length >= 9 && progress.length <= 11, `got ${progress.length}`);
  for (const p of progress) assert.equal(p.type === "progress" && p.sampleRate, 44_100);
  const final = progress.at(-1);
  assert.ok(final?.type === "progress" && final.playedSamples === 44_100);
  for (const p of progress) assert.ok(p.type === "progress" && p.playedSamples <= 44_100);
  assert.deepEqual(posted.at(-1), { type: "drained", utteranceId: "s" });
});

test("utterances play back to back and drain separately", () => {
  const { queue, posted, render } = setup();
  queue.handle({ type: "push", utteranceId: "a", pcm: new Float32Array(100).fill(0.5), sampleRate: 48_000 });
  queue.handle({ type: "end", utteranceId: "a" });
  queue.handle({ type: "push", utteranceId: "b", pcm: new Float32Array(100).fill(0.5), sampleRate: 48_000 });
  const out = render(1);
  assert.ok(out[100] < 0.5, "the second utterance fades in on its own");
  assert.deepEqual(
    posted.filter((m) => m.type === "drained"),
    [{ type: "drained", utteranceId: "a" }],
  );
  queue.handle({ type: "end", utteranceId: "b" });
  render(1);
  assert.equal(posted.filter((m) => m.type === "drained").length, 2);
});

test("pushes after end are ignored", () => {
  const { queue, render } = setup();
  queue.handle({ type: "push", utteranceId: "a", pcm: new Float32Array(10).fill(0.5), sampleRate: 48_000 });
  queue.handle({ type: "end", utteranceId: "a" });
  queue.handle({ type: "push", utteranceId: "a", pcm: new Float32Array(500).fill(0.5), sampleRate: 48_000 });
  const out = render(2);
  assert.ok(out.slice(10).every((v) => v === 0));
});
