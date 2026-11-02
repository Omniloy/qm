import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASR_MODEL_FILES,
  PHONON_ASR_MODEL_FILES,
  PHONON_ASR_PATHS,
  QWEN_ASR_MODEL_FILES,
  asrFilesFor,
  asrVariantFor,
} from "../src/voice-assistant/asr/models.ts";
import { createPhononAsr } from "../src/voice-assistant/asr/phonon-asr.ts";
import { greedyTdt } from "../src/voice-assistant/asr/phonon-tdt.ts";
import { createPieceDecoder } from "../src/voice-assistant/asr/phonon-vocab.ts";
import type { OrtModule } from "../src/voice-assistant/asr/qwen-asr.ts";
import { modelFileKey } from "../src/voice-assistant/protocol.ts";

const BLANK = 8192;
const LOGITS = 8198;

function logits(token: number, duration: number): Float32Array {
  const data = new Float32Array(LOGITS).fill(-5);
  data[token] = 3;
  data[BLANK + 1 + duration] = 3;
  return data;
}

function scripted(script: [number, number][]) {
  const calls: { frame: number; token: number; state: number }[] = [];
  let at = 0;
  return {
    calls,
    async step(frame: number, token: number, state: number) {
      calls.push({ frame, token, state });
      const [next, duration] = script[at++] ?? [BLANK, 1];
      return { logits: logits(next, duration), state: state + 1 };
    },
  };
}

test("greedy TDT keeps tokens, advances by the predicted duration and forces a blank of duration 0 forward", async () => {
  const run = scripted([
    [11, 0],
    [12, 2],
    [BLANK, 0],
    [BLANK, 3],
  ]);
  const tokens = await greedyTdt({ frames: 6, initial: 0, maxTokens: 50, step: run.step });
  assert.deepEqual(tokens, [11, 12]);
  assert.deepEqual(
    run.calls.map((call) => call.frame),
    [0, 0, 2, 3],
  );
  assert.deepEqual(
    run.calls.map((call) => call.token),
    [BLANK, 11, 12, 12],
  );
  assert.deepEqual(
    run.calls.map((call) => call.state),
    [0, 1, 2, 2],
  );
});

test("greedy TDT moves on after ten symbols on one frame and stops at maxTokens", async () => {
  const stuck = scripted(Array.from({ length: 30 }, () => [7, 0] as [number, number]));
  const tokens = await greedyTdt({ frames: 2, initial: 0, maxTokens: 50, step: stuck.step });
  assert.equal(tokens.length, 20);
  assert.equal(stuck.calls.filter((call) => call.frame === 0).length, 10);
  const capped = scripted(Array.from({ length: 30 }, () => [7, 1] as [number, number]));
  assert.equal((await greedyTdt({ frames: 30, initial: 0, maxTokens: 4, step: capped.step })).length, 4);
});

test("greedy TDT rejects once the signal aborts", async () => {
  const controller = new AbortController();
  const run = scripted([[5, 1]]);
  const step = async (frame: number, token: number, state: number) => {
    controller.abort();
    return run.step(frame, token, state);
  };
  await assert.rejects(greedyTdt({ frames: 5, initial: 0, maxTokens: 50, step, signal: controller.signal }), {
    name: "AbortError",
  });
});

const VOCAB = ["<unk> 0", "<|es|> 1", "▁Oye 2", "▁Omni 3", ", 4", "▁qué 5", "? 6", "<pad> 7"].join("\n");

test("piece decoder joins SentencePiece pieces into text and drops control pieces", () => {
  const decoder = createPieceDecoder(new TextEncoder().encode(VOCAB));
  assert.equal(decoder.decode([1, 2, 3, 4, 5, 6, 0, 7]), "Oye Omni, qué?");
  assert.equal(decoder.decode([]), "");
  assert.equal(decoder.decode([99]), "");
});

class FakeTensor {
  disposed = false;
  readonly type: string;
  readonly data: Float32Array | Int32Array;
  readonly dims: number[];
  constructor(type: string, data: Float32Array | Int32Array, dims: number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
  dispose() {
    this.disposed = true;
  }
}

function fakeOrt(script: [number, number][]) {
  const created: { kind: string; options: Record<string, unknown> }[] = [];
  const runs: { kind: string; feeds: Record<string, FakeTensor> }[] = [];
  const released: string[] = [];
  const outputs: FakeTensor[] = [];
  let at = 0;
  const session = (kind: string) => ({
    async run(feeds: Record<string, FakeTensor>) {
      runs.push({ kind, feeds });
      if (kind === "encoder") {
        const steps = Math.ceil(feeds.features.dims[1] / 8);
        const encoded = new FakeTensor("float32", new Float32Array(steps * 640).fill(0.25), [1, steps, 640]);
        outputs.push(encoded);
        return { encoded };
      }
      const [token, duration] = script[at++] ?? [BLANK, 4];
      const state = () => new FakeTensor("float32", new Float32Array(1280), [2, 1, 640]);
      return {
        logits: new FakeTensor("float32", logits(token, duration), [1, LOGITS]),
        h_out: state(),
        c_out: state(),
      };
    },
    async release() {
      released.push(kind);
    },
  });
  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      async create(bytes: Uint8Array, options: Record<string, unknown>) {
        const kind = new TextDecoder().decode(bytes);
        created.push({ kind, options });
        return session(kind);
      },
    },
  } as unknown as OrtModule;
  return { ort, created, runs, released, outputs };
}

const FILES: Record<string, string> = {
  [PHONON_ASR_PATHS.encoder]: "encoder",
  [PHONON_ASR_PATHS.decoderJoint]: "decoder",
  [PHONON_ASR_PATHS.vocab]: VOCAB,
};

async function engineWith(script: [number, number][]) {
  const fake = fakeOrt(script);
  const engine = await createPhononAsr({
    ort: fake.ort,
    variant: "q4",
    executionProviders: ["webgpu"],
    readFile: async (path) => new TextEncoder().encode(FILES[path]),
  });
  return { engine, ...fake };
}

test("Phonon engine runs the encoder on WebGPU and the decoder on wasm with DQ folding", async () => {
  const { engine, created } = await engineWith([]);
  assert.equal(engine.id, "phonon-2.5");
  assert.equal(engine.backend, "webgpu");
  const encoder = created.find((c) => c.kind === "encoder")!;
  const decoder = created.find((c) => c.kind === "decoder")!;
  assert.deepEqual(encoder.options.executionProviders, ["webgpu"]);
  assert.deepEqual(decoder.options.executionProviders, ["wasm"]);
  assert.deepEqual(decoder.options.extra, { session: { disable_quant_qdq: "1" } });
});

test("Phonon engine transcribes with greedy TDT over the encoded frames and decodes the pieces", async () => {
  const { engine, runs, outputs } = await engineWith([
    [2, 0],
    [3, 0],
    [4, 1],
    [BLANK, 1],
    [5, 0],
    [6, 4],
  ]);
  const result = await engine.transcribe(new Float32Array(16_000), { language: "en", maxNewTokens: 50 });
  assert.equal(result.text, "Oye Omni, qué?");
  assert.equal(result.tokens, 5);
  assert.equal(result.audioMs, 1_000);
  const encoderRun = runs.find((r) => r.kind === "encoder")!;
  assert.deepEqual(encoderRun.feeds.features.dims, [1, 100, 128]);
  const steps = runs.filter((r) => r.kind === "decoder");
  assert.deepEqual(steps[0].feeds.encoded.dims, [1, 640]);
  assert.deepEqual(Array.from(steps[0].feeds.token.data), [BLANK]);
  assert.deepEqual(Array.from(steps[1].feeds.token.data), [2]);
  assert.deepEqual(steps[0].feeds.h.dims, [2, 1, 640]);
  assert.ok(outputs[0].disposed);
});

test("Phonon engine skips inference for too-short audio and honours an aborted signal", async () => {
  const { engine, runs } = await engineWith([]);
  const empty = await engine.transcribe(new Float32Array(100), { language: "es", maxNewTokens: 10 });
  assert.equal(empty.text, "");
  assert.equal(runs.length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    engine.transcribe(new Float32Array(16_000), { language: "es", maxNewTokens: 10 }, controller.signal),
    {
      name: "AbortError",
    },
  );
});

test("Phonon engine releases both sessions on dispose", async () => {
  const { engine, released } = await engineWith([]);
  await engine.dispose();
  assert.deepEqual(released.sort(), ["decoder", "encoder"]);
});

test("the ASR manifest serves each engine its own files", () => {
  assert.deepEqual(asrFilesFor("phonon-2.5", "q4f16"), PHONON_ASR_MODEL_FILES);
  assert.deepEqual(asrFilesFor("phonon-2.5", "q4"), PHONON_ASR_MODEL_FILES);
  assert.deepEqual(PHONON_ASR_MODEL_FILES.map((file) => file.path).sort(), Object.values(PHONON_ASR_PATHS).sort());
  assert.ok(PHONON_ASR_MODEL_FILES.every((file) => file.role === "asr" && !file.variant && !file.gated));
  assert.ok(PHONON_ASR_MODEL_FILES.every((file) => /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0));
  const qwen = asrFilesFor("qwen3-asr-0.6b", "q4");
  assert.ok(qwen.length > 0 && qwen.every((file) => QWEN_ASR_MODEL_FILES.includes(file) && file.variant !== "q4f16"));
  assert.equal(ASR_MODEL_FILES.length, QWEN_ASR_MODEL_FILES.length + PHONON_ASR_MODEL_FILES.length);
  assert.equal(new Set(ASR_MODEL_FILES.map(modelFileKey)).size, ASR_MODEL_FILES.length);
});

test("only Qwen picks the fp16 variant on shader-f16 GPUs", () => {
  assert.equal(asrVariantFor("qwen3-asr-0.6b", { webgpu: true, shaderF16: true }), "q4f16");
  assert.equal(asrVariantFor("qwen3-asr-0.6b", { webgpu: true, shaderF16: false }), "q4");
  assert.equal(asrVariantFor("phonon-2.5", { webgpu: true, shaderF16: true }), "q4");
});
