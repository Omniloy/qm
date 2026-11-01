import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPERTONIC_VOICES } from "../src/voice-assistant/protocol.ts";
import { backendAttempts, loadTtsEngine } from "../src/voice-assistant/tts/engine.ts";
import { TTS_MODEL_FILES } from "../src/voice-assistant/tts/models.ts";
import { normalizeSpeechText } from "../src/voice-assistant/tts/normalize.ts";
import {
  SUPERTONIC_MAX_CHARS,
  SUPERTONIC_PATHS,
  clampSteps,
  createSupertonic,
  encodeSupertonicText,
  latentShape,
  levelSpeech,
  parseSupertonicConfig,
  parseVoiceStyle,
  sampleNoisyLatent,
  supertonicInput,
  trailingPauseSeconds,
  type OrtModule,
} from "../src/voice-assistant/tts/supertonic.ts";

const CONFIG = {
  ae: { sample_rate: 44100, base_chunk_size: 512 },
  ttl: { latent_dim: 24, chunk_compress_factor: 6 },
};

test("input is normalized and wrapped in the language tag", () => {
  assert.equal(supertonicInput("Hola, ¿qué tal?", "es"), "<es>Hola, ¿qué tal?</es>".normalize("NFKD"));
  assert.equal(supertonicInput("Done", "en"), "<en>Done.</en>");
  assert.equal(supertonicInput("  Listo ✅  ", "es"), "<es>Listo.</es>");
});

test("normalization decomposes accents and rewrites symbols per language", () => {
  const es = normalizeSpeechText("Escribe a ana@omniloy.com — “mañana”", "es");
  assert.equal(es, 'Escribe a ana arroba omniloy.com - "mañana"');
  assert.equal(normalizeSpeechText("Ping me @ noon, e.g., at 12", "en"), "Ping me at noon, for example, at 12.");
  assert.equal(
    normalizeSpeechText("**Importante**: revisa `config` y [docs]", "es"),
    "Importante: revisa 'config' y docs.",
  );
  assert.equal(normalizeSpeechText("hola , mundo !", "es"), "hola, mundo!");
  assert.equal(normalizeSpeechText("", "es"), "");
});

test("text is encoded through the unicode indexer and unknown code points map to -1", () => {
  const indexer = Array.from({ length: 128 }, (_, i) => i + 1000);
  indexer["<".charCodeAt(0)] = 7;
  const ids = encodeSupertonicText(indexer, "<a€");
  assert.deepEqual(Array.from(ids), [7n, 1097n, -1n]);
});

test("config and voice style JSON are parsed into tensors data and dims", () => {
  assert.deepEqual(parseSupertonicConfig(CONFIG), {
    sampleRate: 44100,
    baseChunkSize: 512,
    chunkCompressFactor: 6,
    latentDim: 24,
  });
  assert.throws(() => parseSupertonicConfig({ ae: {} }), /supertonic_config_invalid/);
  const style = parseVoiceStyle({
    style_ttl: {
      dims: [1, 2, 2],
      data: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
    },
    style_dp: { dims: [1, 1, 3], data: [[[5, 6, 7]]] },
  });
  assert.deepEqual(Array.from(style.ttl.data), [1, 2, 3, 4]);
  assert.deepEqual(style.dp.dims, [1, 1, 3]);
  assert.throws(
    () => parseVoiceStyle({ style_ttl: { dims: [1, 2, 2], data: [1] }, style_dp: { dims: [1], data: [1] } }),
    /style_ttl/,
  );
});

test("latent length covers the predicted duration in compressed chunks", () => {
  const cfg = parseSupertonicConfig(CONFIG);
  assert.deepEqual(latentShape(1, cfg), { channels: 144, frames: 15, wavSamples: 44100 });
  assert.equal(latentShape(0, cfg).frames, 1);
  const noise = sampleNoisyLatent(144, 15, () => 0.5);
  assert.equal(noise.length, 144 * 15);
  assert.ok(noise.every((v) => Number.isFinite(v)));
});

test("steps are clamped and pauses follow the final punctuation", () => {
  assert.equal(clampSteps(0), 1);
  assert.equal(clampSteps(2.4), 2);
  assert.equal(clampSteps(99), 10);
  assert.equal(clampSteps(Number.NaN), 1);
  assert.equal(trailingPauseSeconds("Listo."), 0.3);
  assert.equal(trailingPauseSeconds('¿Seguro?"'), 0.3);
  assert.equal(trailingPauseSeconds("Vale,"), 0.12);
});

test("speech is levelled to a common loudness without clipping", () => {
  const loud = levelSpeech(Float32Array.from([1.8, -1.8, 0.2, -0.2]));
  assert.ok(Math.max(...loud.map(Math.abs)) <= 0.95 + 1e-6);
  const quiet = levelSpeech(Float32Array.from([0.01, -0.01, 0.01, -0.01]));
  assert.ok(Math.abs(quiet[0] - 0.06) < 1e-6);
  assert.deepEqual(Array.from(levelSpeech(new Float32Array(3))), [0, 0, 0]);
});

test("the manifest pins every Supertonic 3 file with size and digest", () => {
  const paths = TTS_MODEL_FILES.map((f) => f.path);
  for (const path of [
    SUPERTONIC_PATHS.config,
    SUPERTONIC_PATHS.indexer,
    SUPERTONIC_PATHS.durationPredictor,
    SUPERTONIC_PATHS.textEncoder,
    SUPERTONIC_PATHS.vectorEstimator,
    SUPERTONIC_PATHS.vocoder,
    ...SUPERTONIC_VOICES.map(SUPERTONIC_PATHS.voice),
  ]) {
    assert.ok(paths.includes(path), path);
  }
  assert.equal(new Set(paths).size, paths.length);
  for (const file of TTS_MODEL_FILES) {
    assert.equal(file.repo, "supertone-oss-archive/supertonic-3");
    assert.equal(file.revision, "aafc6e32416a594460b32413efc49d7fe4ce6d46");
    assert.equal(file.role, "tts");
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(file.bytes > 0);
  }
  assert.equal(
    TTS_MODEL_FILES.reduce((sum, f) => sum + f.bytes, 0),
    401_276_744,
  );
});

interface Run {
  session: string;
  feeds: Record<string, FakeTensor>;
}

class FakeTensor {
  type: string;
  data: Float32Array | BigInt64Array;
  dims: number[];
  constructor(type: string, data: Float32Array | BigInt64Array, dims: readonly number[]) {
    this.type = type;
    this.data = data;
    this.dims = [...dims];
  }
}

function fakeOrt(opts: { failProvider?: string; durationSeconds?: number } = {}) {
  const runs: Run[] = [];
  const created: { path: string; providers: string[] }[] = [];
  const released: string[] = [];
  const duration = opts.durationSeconds ?? 0.1;
  const ort = {
    Tensor: FakeTensor,
    InferenceSession: {
      async create(bytes: Uint8Array, options: { executionProviders: string[] }) {
        const path = new TextDecoder().decode(bytes);
        if (options.executionProviders.includes(opts.failProvider ?? "")) throw new Error(`no ${opts.failProvider}`);
        created.push({ path, providers: options.executionProviders });
        return {
          async run(feeds: Record<string, FakeTensor>) {
            runs.push({ session: path, feeds });
            if (path === SUPERTONIC_PATHS.durationPredictor)
              return { duration: new FakeTensor("float32", Float32Array.of(duration), [1]) };
            if (path === SUPERTONIC_PATHS.textEncoder)
              return { text_emb: new FakeTensor("float32", new Float32Array(4), [1, 256, 1]) };
            if (path === SUPERTONIC_PATHS.vectorEstimator) {
              const data = (feeds.noisy_latent.data as Float32Array).map((v) => v * 0.5);
              return { denoised_latent: new FakeTensor("float32", data, feeds.noisy_latent.dims) };
            }
            const frames = feeds.latent.dims[2];
            return {
              wav_tts: new FakeTensor("float32", new Float32Array(frames * 3072).fill(0.5), [1, frames * 3072]),
            };
          },
          async release() {
            released.push(path);
          },
        };
      },
    },
  };
  return { ort: ort as unknown as OrtModule, runs, created, released };
}

async function readFake(path: string): Promise<Uint8Array> {
  if (path === SUPERTONIC_PATHS.config) return new TextEncoder().encode(JSON.stringify(CONFIG));
  if (path === SUPERTONIC_PATHS.indexer)
    return new TextEncoder().encode(JSON.stringify(Array.from({ length: 512 }, (_, i) => i)));
  if (path.startsWith("voice_styles/")) {
    return new TextEncoder().encode(
      JSON.stringify({
        style_ttl: { dims: [1, 50, 256], data: Array.from({ length: 12800 }, () => 0) },
        style_dp: { dims: [1, 8, 16], data: Array.from({ length: 128 }, () => 0) },
      }),
    );
  }
  return new TextEncoder().encode(path);
}

test("synthesis runs duration, encoder, the requested denoising steps and the vocoder", async () => {
  const fake = fakeOrt();
  const engine = await createSupertonic({
    ort: fake.ort,
    executionProviders: ["wasm"],
    backend: "wasm",
    readFile: readFake,
  });
  assert.equal(engine.sampleRate, 44100);
  assert.deepEqual(engine.voices, SUPERTONIC_VOICES);
  const pcm = await engine.synthesize({ text: "Hola", language: "es", voice: "M2", steps: 3 });

  assert.deepEqual(
    fake.runs.map((r) => r.session),
    [
      SUPERTONIC_PATHS.durationPredictor,
      SUPERTONIC_PATHS.textEncoder,
      SUPERTONIC_PATHS.vectorEstimator,
      SUPERTONIC_PATHS.vectorEstimator,
      SUPERTONIC_PATHS.vectorEstimator,
      SUPERTONIC_PATHS.vocoder,
    ],
  );
  const steps = fake.runs.filter((r) => r.session === SUPERTONIC_PATHS.vectorEstimator);
  assert.deepEqual(
    steps.map((r) => r.feeds.current_step.data[0]),
    [0, 1, 2],
  );
  assert.ok(steps.every((r) => r.feeds.total_step.data[0] === 3));
  const ids = fake.runs[0].feeds.text_ids;
  assert.equal(ids.type, "int64");
  assert.equal(ids.dims[1], "<es>Hola.</es>".length);

  const speech = Math.floor((0.1 / 1.05) * 44100);
  assert.equal(pcm.length, speech + Math.round(0.3 * 44100));
  assert.ok(pcm.subarray(speech).every((v) => v === 0));
  assert.ok(pcm[0] > 0);
});

test("synthesis rejects over-long chunks, skips unspeakable text and unknown voices", async () => {
  const fake = fakeOrt();
  const engine = await createSupertonic({
    ort: fake.ort,
    executionProviders: ["wasm"],
    backend: "wasm",
    readFile: readFake,
  });
  await assert.rejects(
    engine.synthesize({ text: "a".repeat(SUPERTONIC_MAX_CHARS + 1), language: "es", voice: "F1", steps: 2 }),
    RangeError,
  );
  assert.equal((await engine.synthesize({ text: " ... ", language: "es", voice: "F1", steps: 2 })).length, 0);
  await assert.rejects(
    engine.synthesize({ text: "Hola", language: "es", voice: "Z9", steps: 2 }),
    /supertonic_voice_unknown/,
  );
  assert.equal(fake.runs.length, 0);
});

test("a chunk within the raw limit still speaks when normalization makes it longer", async () => {
  const fake = fakeOrt();
  const engine = await createSupertonic({
    ort: fake.ort,
    executionProviders: ["wasm"],
    backend: "wasm",
    readFile: readFake,
  });
  const text = "Información sobre la canción ".repeat(20).slice(0, SUPERTONIC_MAX_CHARS);
  const pcm = await engine.synthesize({ text, language: "es", voice: "F1", steps: 2 });
  assert.ok(pcm.length > 0);
});

test("an aborted signal stops synthesis before the next model run", async () => {
  const fake = fakeOrt();
  const engine = await createSupertonic({
    ort: fake.ort,
    executionProviders: ["wasm"],
    backend: "wasm",
    readFile: readFake,
  });
  const controller = new AbortController();
  const original = fake.runs.push.bind(fake.runs);
  fake.runs.push = (...items: Run[]) => {
    if (items[0].session === SUPERTONIC_PATHS.vectorEstimator) controller.abort();
    return original(...items);
  };
  await assert.rejects(
    engine.synthesize({ text: "Hola", language: "es", voice: "F1", steps: 5 }, controller.signal),
    (e: Error) => e.name === "AbortError",
  );
  assert.equal(fake.runs.filter((r) => r.session === SUPERTONIC_PATHS.vectorEstimator).length, 1);
  assert.equal(fake.runs.filter((r) => r.session === SUPERTONIC_PATHS.vocoder).length, 0);
});

test("dispose releases all four sessions", async () => {
  const fake = fakeOrt();
  const engine = await createSupertonic({
    ort: fake.ort,
    executionProviders: ["wasm"],
    backend: "wasm",
    readFile: readFake,
  });
  await engine.dispose();
  assert.equal(fake.released.length, 4);
});

test("the engine loader falls back from WebGPU to WASM and warms up the chosen backend", async () => {
  assert.deepEqual(backendAttempts("webgpu"), ["webgpu", "wasm"]);
  assert.deepEqual(backendAttempts("wasm"), ["wasm"]);
  const fake = fakeOrt({ failProvider: "webgpu" });
  const engine = await loadTtsEngine("supertonic-3", { ort: fake.ort, backend: "webgpu", readFile: readFake });
  assert.equal(engine.backend, "wasm");
  assert.ok(fake.created.every((c) => c.providers.join() === "wasm"));
  assert.ok(fake.runs.some((r) => r.session === SUPERTONIC_PATHS.vocoder));
});

test("the engine loader surfaces the last error when every backend fails", async () => {
  const fake = fakeOrt({ failProvider: "wasm" });
  await assert.rejects(
    loadTtsEngine("supertonic-3", { ort: fake.ort, backend: "wasm", readFile: readFake }),
    /no wasm/,
  );
});
