import { test } from "node:test";
import assert from "node:assert/strict";
import {
  argmax,
  buildPromptIds,
  createQwenAsr,
  toHalf,
  transcriptFromTokens,
} from "../src/voice-assistant/asr/qwen-asr.ts";
import type { OrtModule } from "../src/voice-assistant/asr/qwen-asr.ts";
import { asrPaths } from "../src/voice-assistant/asr/models.ts";
import type { AsrVariant } from "../src/voice-assistant/protocol.ts";

const HIDDEN = 1024;
const VOCAB = 151_936;
const PREFIX_LENGTH = 9;
const NEWLINE = 198;

class FakeTensor {
  disposed = false;
  readonly type: string;
  readonly data: ArrayLike<number | bigint>;
  readonly dims: number[];
  constructor(type: string, data: ArrayLike<number | bigint>, dims: number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
  dispose() {
    this.disposed = true;
  }
}

interface Harness {
  ort: OrtModule;
  created: { kind: string; options: Record<string, unknown> }[];
  runs: { kind: string; feeds: Record<string, FakeTensor> }[];
  presents: FakeTensor[];
  released: string[];
}

function harness(script: number[], opts: { half?: boolean; onStep?: (step: number) => void } = {}): Harness {
  const h: Harness = { ort: null as unknown as OrtModule, created: [], runs: [], presents: [], released: [] };
  const logits = (token: number) => {
    if (opts.half) {
      const data = new Uint16Array(VOCAB).fill(toHalf(-3));
      data[token] = toHalf(-0.5);
      return new FakeTensor("float16", data, [1, 1, VOCAB]);
    }
    const data = new Float32Array(VOCAB).fill(-3);
    data[token] = 2;
    return new FakeTensor("float32", data, [1, 1, VOCAB]);
  };
  const present = () => {
    const tensor = new FakeTensor("float32", new Float32Array(1), [28, 1, 8, 1, 128]);
    h.presents.push(tensor);
    return tensor;
  };
  let step = 0;
  const session = (kind: string) => ({
    async run(feeds: Record<string, FakeTensor>) {
      h.runs.push({ kind, feeds });
      if (kind === "encoder") {
        const frames = feeds.mel.dims[2];
        const tokens = Math.ceil(frames / 8);
        return {
          audio_features: new FakeTensor("float32", new Float32Array(tokens * HIDDEN).fill(0.5), [1, tokens, HIDDEN]),
        };
      }
      if (kind === "step") opts.onStep?.(step);
      const token = script[step++];
      return { logits: logits(token), present_keys: present(), present_values: present() };
    },
    async release() {
      h.released.push(kind);
    },
  });
  h.ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      async create(bytes: Uint8Array, options: Record<string, unknown>) {
        const kind = new TextDecoder().decode(bytes);
        h.created.push({ kind, options });
        return session(kind);
      },
    },
  } as unknown as OrtModule;
  return h;
}

function files(variant: AsrVariant): Record<string, Uint8Array> {
  const paths = asrPaths(variant);
  const table = new Int8Array((NEWLINE + 1) * HIDDEN).fill(4);
  const scales = new Float32Array(NEWLINE + 1).fill(0.25);
  const vocab = { Hola: 100, Ġmundo: 101, language: 11528, ĠSpanish: 15154 };
  return {
    [paths.encoder]: new TextEncoder().encode("encoder"),
    [paths.decoderInit]: new TextEncoder().encode("init"),
    [paths.decoderStep]: new TextEncoder().encode("step"),
    [paths.decoderWeights]: new Uint8Array(4),
    [paths.embedTokens]: new Uint8Array(table.buffer),
    [paths.embedScales]: new Uint8Array(scales.buffer),
    [paths.vocab]: new TextEncoder().encode(JSON.stringify(vocab)),
  };
}

async function engineFor(h: Harness, variant: AsrVariant = "q4", executionProviders = ["cpu"]) {
  const bytes = files(variant);
  return createQwenAsr({ ort: h.ort, variant, executionProviders, readFile: async (path) => bytes[path] });
}

const second = new Float32Array(16_000).map((_, i) => Math.sin(i / 7) * 0.1);

test("the prompt is the chat template, audio pads, then the forced language prefix", () => {
  assert.deepEqual(
    buildPromptIds(2, "es"),
    [
      151644, 8948, 198, 151645, 198, 151644, 872, 198, 151669, 151676, 151676, 151670, 151645, 198, 151644, 77091, 198,
      11528, 15154, 151704,
    ],
  );
  assert.deepEqual(buildPromptIds(0, "en").slice(-3), [11528, 6364, 151704]);
});

test("a transcript drops any language header the model emits before asr_text", () => {
  assert.deepEqual(transcriptFromTokens([11528, 15154, 151704, 100, 101]), [100, 101]);
  assert.deepEqual(transcriptFromTokens([100, 101]), [100, 101]);
});

test("toHalf rounds float32 to IEEE half bit patterns", () => {
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(toHalf(0.5), 0x3800);
  assert.equal(toHalf(65504), 0x7bff);
  assert.equal(toHalf(1e6), 0x7c00);
  assert.equal(toHalf(2 ** -24), 0x0001);
  assert.equal(toHalf(0), 0);
  assert.equal(toHalf(Number.NaN), 0x7e00);
});

test("argmax orders half bit patterns numerically, including negatives", () => {
  const data = Uint16Array.from([-4, -0.25, -1, -8].map(toHalf));
  assert.equal(argmax(data, true), 1);
  assert.equal(argmax([0.1, 3, -2], false), 1);
});

test("greedy decode prefills once, steps with growing positions and stops at im_end", async () => {
  const h = harness([100, 101, 151645]);
  const engine = await engineFor(h);
  const result = await engine.transcribe(second, { language: "es", maxNewTokens: 50 });
  assert.equal(result.text, "Hola mundo");
  assert.equal(result.tokens, 2);
  assert.equal(result.audioMs, 1000);
  const [encoder, init, ...steps] = h.runs;
  assert.equal(encoder.kind, "encoder");
  assert.deepEqual(encoder.feeds.mel.dims, [1, 128, 100]);
  const audioTokens = 13;
  const promptLength = PREFIX_LENGTH + audioTokens + 6 + 3;
  assert.deepEqual(init.feeds.input_embeds.dims, [1, promptLength, HIDDEN]);
  assert.deepEqual(
    Array.from(init.feeds.position_ids.data),
    Array.from({ length: promptLength }, (_, i) => BigInt(i)),
  );
  const embeds = init.feeds.input_embeds.data as Float32Array;
  assert.equal(embeds[2 * HIDDEN], 1);
  assert.equal(embeds[PREFIX_LENGTH * HIDDEN], 0.5);
  assert.equal(embeds[(PREFIX_LENGTH + audioTokens) * HIDDEN - 1], 0.5);
  assert.deepEqual(
    steps.map((s) => s.feeds.position_ids.data[0]),
    [BigInt(promptLength), BigInt(promptLength + 1)],
  );
  assert.equal(steps[0].feeds.past_keys, h.presents[0]);
  assert.ok(h.presents.every((t) => t.disposed));
});

test("maxNewTokens caps generation without another decoder step", async () => {
  const h = harness([100, 101, 151645]);
  const engine = await engineFor(h);
  const result = await engine.transcribe(second, { language: "en", maxNewTokens: 1 });
  assert.equal(result.text, "Hola");
  assert.equal(h.runs.filter((r) => r.kind === "step").length, 0);
  assert.ok(h.presents.every((t) => t.disposed));
});

test("an abort between decode steps rejects and releases the KV cache", async () => {
  const controller = new AbortController();
  const h = harness([100, 101, 101, 151645], { onStep: (n) => n === 1 && controller.abort() });
  const engine = await engineFor(h);
  await assert.rejects(engine.transcribe(second, { language: "es", maxNewTokens: 50 }, controller.signal), {
    name: "AbortError",
  });
  assert.ok(h.presents.every((t) => t.disposed));
});

test("audio shorter than one mel hop returns an empty transcript without inference", async () => {
  const h = harness([]);
  const engine = await engineFor(h);
  const result = await engine.transcribe(new Float32Array(100), { language: "es", maxNewTokens: 10 });
  assert.equal(result.text, "");
  assert.equal(h.runs.length, 0);
});

test("q4f16 on WebGPU feeds half embeddings, keeps KV on the GPU and shares the weights file", async () => {
  const h = harness([101, 151643], { half: true });
  const engine = await engineFor(h, "q4f16", ["webgpu"]);
  assert.equal(engine.backend, "webgpu");
  assert.equal(engine.variant, "q4f16");
  const result = await engine.transcribe(second, { language: "es", maxNewTokens: 50 });
  assert.equal(result.text, "mundo");
  const init = h.runs.find((r) => r.kind === "init");
  assert.equal(init?.feeds.input_embeds.type, "float16");
  assert.equal(init?.feeds.input_embeds.data[2 * HIDDEN], toHalf(1));
  const decoders = h.created.filter((c) => c.kind !== "encoder");
  for (const { options } of decoders) {
    assert.deepEqual(options.preferredOutputLocation, { present_keys: "gpu-buffer", present_values: "gpu-buffer" });
    assert.equal((options.externalData as { path: string }[])[0].path, "decoder_weights.q4f16.data");
    assert.deepEqual(options.executionProviders, ["webgpu"]);
  }
  assert.equal(h.created.find((c) => c.kind === "encoder")?.options.preferredOutputLocation, undefined);
  assert.ok(h.created.every((c) => c.options.logSeverityLevel === 3));
  await engine.dispose();
  assert.deepEqual(h.released.sort(), ["encoder", "init", "step"]);
});

test("q4 on a CPU provider reports wasm and keeps outputs on the CPU", async () => {
  const h = harness([151645]);
  const engine = await engineFor(h);
  assert.equal(engine.backend, "wasm");
  assert.ok(h.created.every((c) => c.options.preferredOutputLocation === undefined));
});
