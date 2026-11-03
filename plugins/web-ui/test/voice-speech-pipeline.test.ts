import assert from "node:assert/strict";
import test from "node:test";
import { FrameProcessor } from "@ricky0123/vad-web/dist/frame-processor.js";
import { Message } from "@ricky0123/vad-web/dist/messages.js";
import {
  DEFAULT_VAD_OPTIONS,
  PTT_MAX_MS,
  SPEECH_FRAME_MS,
  SPEECH_FRAME_SAMPLES,
  SPEECH_SAMPLE_RATE,
  UTTERANCE_MAX_NEW_TOKENS,
  WAKE_MAX_NEW_TOKENS,
  WAKE_SEGMENT_MAX_MS,
  type AsrRequest,
  type AsrResult,
  type SpeechMode,
  type SpeechWorkerOut,
} from "../src/voice-assistant/protocol.ts";
import { VAD_EVENT, createSpeechPipeline } from "../src/voice-assistant/speech-pipeline.ts";

const SPEECH = 0.9;
const SILENCE = 0;

function frame(level: number): Float32Array {
  return new Float32Array(SPEECH_FRAME_SAMPLES).fill(level);
}

function setup(
  options: { mode?: SpeechMode; transcribe?: (audio: Float32Array, req: AsrRequest) => Promise<AsrResult> } = {},
) {
  const posted: SpeechWorkerOut[] = [];
  const asrCalls: { samples: number; request: AsrRequest }[] = [];
  let resets = 0;
  const vad = new FrameProcessor(
    async (f: Float32Array) => ({ isSpeech: f[0], notSpeech: 1 - f[0] }),
    () => {
      resets++;
    },
    { ...DEFAULT_VAD_OPTIONS },
    SPEECH_FRAME_MS,
  );
  let clock = 0;
  const pipeline = createSpeechPipeline({
    vad,
    language: "es",
    mode: options.mode ?? "awake",
    post: (m) => posted.push(m),
    now: () => (clock += 40),
    transcribe:
      options.transcribe ??
      (async (audio, request) => {
        asrCalls.push({ samples: audio.length, request });
        return { text: ` hola ${asrCalls.length} `, tokens: 3, audioMs: 0, encodeMs: 0, decodeMs: 0 };
      }),
  });
  const feed = (level: number, count: number) => {
    for (let i = 0; i < count; i++) pipeline.frame(frame(level));
  };
  return { pipeline, posted, asrCalls, feed, resets: () => resets, vad };
}

const framesFor = (ms: number) => Math.ceil(ms / SPEECH_FRAME_MS);

test("the vad event names match vad-web's Message enum", () => {
  assert.equal(VAD_EVENT.speechStart, Message.SpeechStart);
  assert.equal(VAD_EVENT.speechRealStart, Message.SpeechRealStart);
  assert.equal(VAD_EVENT.misfire, Message.VADMisfire);
  assert.equal(VAD_EVENT.speechEnd, Message.SpeechEnd);
});

test("an utterance raises speech-start, then speech-end and its transcript", async () => {
  const { pipeline, posted, asrCalls, feed } = setup();
  feed(SILENCE, 5);
  feed(SPEECH, framesFor(1_000));
  feed(SILENCE, framesFor(DEFAULT_VAD_OPTIONS.redemptionMs) + 1);
  await pipeline.settled();
  const types = posted.map((m) => m.type);
  assert.deepEqual(types, ["speech-start", "speech-end", "transcript"]);
  const end = posted[1];
  assert.ok(end.type === "speech-end");
  assert.equal(end.purpose, "utterance");
  assert.equal(end.segmentId, 1);
  assert.ok(end.durationMs >= 1_000 && end.durationMs < 2_200, `duration ${end.durationMs}`);
  assert.deepEqual(posted[2], {
    type: "transcript",
    segmentId: 1,
    purpose: "utterance",
    text: "hola 1",
    language: "es",
    ms: 40,
  });
  assert.equal(asrCalls[0].request.maxNewTokens, UTTERANCE_MAX_NEW_TOKENS);
});

test("speech-start fires once minSpeech worth of frames is heard, for barge-in", async () => {
  const { pipeline, posted, feed } = setup();
  feed(SPEECH, framesFor(DEFAULT_VAD_OPTIONS.minSpeechMs) - 2);
  await pipeline.settled();
  assert.equal(posted.length, 0);
  feed(SPEECH, 2);
  await pipeline.settled();
  assert.deepEqual(posted, [{ type: "speech-start" }]);
});

test("a blip shorter than minSpeech is a misfire and is never transcribed", async () => {
  const { pipeline, posted, asrCalls, feed } = setup();
  feed(SPEECH, 3);
  feed(SILENCE, framesFor(DEFAULT_VAD_OPTIONS.redemptionMs) + 1);
  await pipeline.settled();
  assert.deepEqual(posted, [{ type: "speech-misfire" }]);
  assert.equal(asrCalls.length, 0);
});

test("while sleeping, segments are wake checks capped at the wake window", async () => {
  const { pipeline, posted, asrCalls, feed } = setup({ mode: "sleeping" });
  feed(SPEECH, framesFor(WAKE_SEGMENT_MAX_MS + 1_500));
  feed(SILENCE, framesFor(DEFAULT_VAD_OPTIONS.redemptionMs) + 1);
  await pipeline.settled();
  const end = posted.find((m) => m.type === "speech-end");
  assert.ok(end?.type === "speech-end" && end.purpose === "wake" && end.durationMs > WAKE_SEGMENT_MAX_MS);
  assert.equal(asrCalls[0].samples, (WAKE_SEGMENT_MAX_MS * SPEECH_SAMPLE_RATE) / 1000);
  assert.equal(asrCalls[0].request.maxNewTokens, WAKE_MAX_NEW_TOKENS);
  const wake = posted.find((m) => m.type === "transcript" && m.purpose === "wake");
  assert.ok(wake?.type === "transcript" && wake.truncated === true);
  pipeline.retranscribe(end.segmentId);
  await pipeline.settled();
  assert.ok(asrCalls[1].samples > asrCalls[0].samples);
  assert.equal(asrCalls[1].request.maxNewTokens, UTTERANCE_MAX_NEW_TOKENS);
  const full = posted.at(-1);
  assert.ok(full?.type === "transcript" && full.purpose === "utterance" && full.segmentId === end.segmentId);
});

test("a short wake check is not truncated, and retranscribing an unknown segment answers with nothing", async () => {
  const { pipeline, posted, asrCalls, feed } = setup({ mode: "sleeping" });
  feed(SPEECH, framesFor(800));
  feed(SILENCE, framesFor(DEFAULT_VAD_OPTIONS.redemptionMs) + 1);
  await pipeline.settled();
  const wake = posted.find((m) => m.type === "transcript" && m.purpose === "wake");
  assert.ok(wake?.type === "transcript" && wake.truncated === undefined);
  pipeline.retranscribe(99);
  await pipeline.settled();
  assert.equal(asrCalls.at(-1)!.samples, 0);
  const none = posted.at(-1);
  assert.ok(none?.type === "transcript" && none.segmentId === 99 && none.purpose === "utterance");
});

test("a wake check that fills its token budget is truncated unless it ends a sentence", async () => {
  const texts = ["Oye Omni, ¿qué tareas tengo en curso?", "Oye Omni, crea una tarea que diga"];
  for (const [index, text] of texts.entries()) {
    const { pipeline, posted, feed } = setup({
      mode: "sleeping",
      transcribe: async () => ({ text, tokens: WAKE_MAX_NEW_TOKENS, audioMs: 0, encodeMs: 0, decodeMs: 0 }),
    });
    feed(SPEECH, framesFor(2_500));
    feed(SILENCE, framesFor(DEFAULT_VAD_OPTIONS.redemptionMs) + 1);
    await pipeline.settled();
    const wake = posted.find((m) => m.type === "transcript" && m.purpose === "wake");
    assert.ok(wake?.type === "transcript" && wake.text === text);
    assert.equal(wake.truncated, index === 0 ? undefined : true);
  }
});

test("paused ignores frames and resets the vad", async () => {
  const { pipeline, posted, feed, resets } = setup();
  feed(SPEECH, 4);
  const before = resets();
  pipeline.setMode("paused");
  feed(SPEECH, framesFor(1_000));
  feed(SILENCE, framesFor(1_000));
  await pipeline.settled();
  assert.equal(posted.length, 0);
  assert.ok(resets() > before);
  pipeline.setMode("awake");
  feed(SPEECH, framesFor(500));
  feed(SILENCE, framesFor(DEFAULT_VAD_OPTIONS.redemptionMs) + 1);
  await pipeline.settled();
  assert.deepEqual(
    posted.map((m) => m.type),
    ["speech-start", "speech-end", "transcript"],
  );
});

test("end-segment closes the open segment at once", async () => {
  const { pipeline, posted, feed } = setup();
  feed(SPEECH, framesFor(600));
  pipeline.endSegment();
  await pipeline.settled();
  assert.deepEqual(
    posted.map((m) => m.type),
    ["speech-start", "speech-end", "transcript"],
  );
});

test("transcriptions run one at a time and keep their segment ids", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { pipeline, posted, feed } = setup({
    transcribe: async (audio) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { text: String(audio.length), tokens: 1, audioMs: 0, encodeMs: 0, decodeMs: 0 };
    },
  });
  for (let i = 0; i < 3; i++) {
    feed(SPEECH, framesFor(400 + i * 200));
    feed(SILENCE, framesFor(DEFAULT_VAD_OPTIONS.redemptionMs) + 1);
  }
  await pipeline.settled();
  assert.equal(maxInFlight, 1);
  const transcripts = posted.filter((m) => m.type === "transcript");
  assert.deepEqual(
    transcripts.map((m) => m.type === "transcript" && m.segmentId),
    [1, 2, 3],
  );
});

test("config applies the language to later transcriptions and new vad options", async () => {
  const { pipeline, posted, asrCalls, feed, vad } = setup();
  pipeline.configure({ language: "en", vad: { positiveSpeechThreshold: 0.95 } });
  feed(SPEECH, framesFor(1_000));
  await pipeline.settled();
  assert.equal(vad.options.positiveSpeechThreshold, 0.95);
  assert.equal(posted.length, 0);
  pipeline.configure({ vad: { positiveSpeechThreshold: 0.5 } });
  feed(SPEECH, framesFor(1_000));
  pipeline.endSegment();
  await pipeline.settled();
  assert.equal(asrCalls[0].request.language, "en");
  assert.ok(posted.some((m) => m.type === "transcript" && m.language === "en"));
});

test("asr and vad failures surface as non-fatal errors without stopping the pipeline", async () => {
  let fail = true;
  const { pipeline, posted, feed } = setup({
    transcribe: async () => {
      if (fail) throw new Error("decoder exploded");
      return { text: "ok", tokens: 1, audioMs: 0, encodeMs: 0, decodeMs: 0 };
    },
  });
  feed(SPEECH, framesFor(500));
  pipeline.endSegment();
  await pipeline.settled();
  assert.deepEqual(posted.slice(-2), [
    { type: "error", stage: "asr", reason: "decoder exploded", fatal: false },
    { type: "transcript", segmentId: 1, purpose: "utterance", text: "", language: "es", ms: 0 },
  ]);
  fail = false;
  feed(SPEECH, framesFor(500));
  pipeline.endSegment();
  await pipeline.settled();
  assert.ok(posted.at(-1)?.type === "transcript");
});

test("a throwing vad reports one error per failure streak", async () => {
  const posted: SpeechWorkerOut[] = [];
  let broken = true;
  const pipeline = createSpeechPipeline({
    vad: {
      process: async () => {
        if (broken) throw new Error("session lost");
      },
      endSegment: () => undefined,
      setOptions: () => undefined,
      reset: () => undefined,
      resume: () => undefined,
    },
    language: "es",
    mode: "awake",
    post: (m) => posted.push(m),
    transcribe: async () => ({ text: "", tokens: 0, audioMs: 0, encodeMs: 0, decodeMs: 0 }),
  });
  for (let i = 0; i < 5; i++) pipeline.frame(frame(SPEECH));
  await pipeline.settled();
  assert.deepEqual(posted, [{ type: "error", stage: "vad", reason: "session lost", fatal: false }]);
  broken = false;
  pipeline.frame(frame(SPEECH));
  await pipeline.settled();
  broken = true;
  pipeline.frame(frame(SPEECH));
  await pipeline.settled();
  assert.equal(posted.length, 2);
});

const PREROLL_FRAMES = framesFor(200);

test("a held capture sends everything between press and release, with a short pre-roll, as one utterance", async () => {
  const { pipeline, posted, asrCalls, feed } = setup({ mode: "paused" });
  feed(SILENCE, 20);
  pipeline.setMode("held");
  feed(SPEECH, 2);
  feed(SILENCE, framesFor(2_000));
  feed(SPEECH, 2);
  await pipeline.settled();
  assert.deepEqual(posted, [{ type: "speech-start" }], "pauses and short words never split or drop the capture");
  pipeline.endSegment();
  pipeline.setMode("paused");
  feed(SPEECH, framesFor(500));
  await pipeline.settled();
  assert.deepEqual(
    posted.map((m) => m.type),
    ["speech-start", "speech-end", "transcript"],
  );
  const frames = PREROLL_FRAMES + 4 + framesFor(2_000);
  assert.equal(asrCalls.length, 1);
  assert.equal(asrCalls[0].samples, frames * SPEECH_FRAME_SAMPLES);
  assert.equal(asrCalls[0].request.maxNewTokens, UTTERANCE_MAX_NEW_TOKENS);
  const end = posted[1];
  assert.ok(end.type === "speech-end" && end.purpose === "utterance");
});

test("a held capture without speech is a misfire and is never transcribed", async () => {
  const { pipeline, posted, asrCalls, feed } = setup({ mode: "paused" });
  pipeline.setMode("held");
  feed(SILENCE, framesFor(1_000));
  pipeline.endSegment();
  await pipeline.settled();
  assert.deepEqual(posted, [{ type: "speech-misfire", silent: true }]);
  assert.equal(asrCalls.length, 0);
});

test("a held capture with sound but no speech is a plain misfire, not a silent microphone", async () => {
  const { pipeline, posted, asrCalls, feed } = setup({ mode: "paused" });
  pipeline.setMode("held");
  feed(0.0001, framesFor(1_000));
  pipeline.endSegment();
  await pipeline.settled();
  assert.deepEqual(posted, [{ type: "speech-misfire" }]);
  assert.equal(asrCalls.length, 0);
});

test("a held capture ends itself at the push-to-talk limit", async () => {
  const { pipeline, posted, asrCalls, feed } = setup({ mode: "paused" });
  pipeline.setMode("held");
  feed(SPEECH, framesFor(PTT_MAX_MS) + 20);
  await pipeline.settled();
  assert.deepEqual(
    posted.map((m) => m.type),
    ["speech-start", "speech-end", "transcript"],
  );
  assert.ok(asrCalls[0].samples >= (PTT_MAX_MS * SPEECH_SAMPLE_RATE) / 1000);
  assert.ok(asrCalls[0].samples < ((PTT_MAX_MS + 100) * SPEECH_SAMPLE_RATE) / 1000);
  pipeline.endSegment();
  await pipeline.settled();
  assert.equal(posted.length, 3);
});

test("leaving held without ending the segment drops the capture", async () => {
  const { pipeline, posted, asrCalls, feed } = setup({ mode: "paused" });
  pipeline.setMode("held");
  feed(SPEECH, framesFor(600));
  pipeline.setMode("paused");
  pipeline.endSegment();
  await pipeline.settled();
  assert.deepEqual(posted, []);
  assert.equal(asrCalls.length, 0);
});
