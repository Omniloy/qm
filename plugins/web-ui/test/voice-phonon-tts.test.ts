import assert from "node:assert/strict";
import test from "node:test";
import type { TtsEngine, TtsRequest, VoiceLanguage } from "../src/voice-assistant/protocol.ts";
import { loadTtsEngine, speak } from "../src/voice-assistant/tts/engine.ts";
import { cleanSpeechText } from "../src/voice-assistant/tts/normalize.ts";
import {
  PHONON_PATHS,
  PHONON_SEED,
  PHONON_TEMPERATURE,
  createPhononTts,
  type PhononDevice,
  type PhononModel,
  type PhononRuntime,
} from "../src/voice-assistant/tts/phonon.ts";
import type { OrtModule } from "../src/voice-assistant/tts/supertonic.ts";
import { PHONON_VOICES } from "../src/voice-assistant/voices.ts";

const CELIA = "rmLBOdHrfkFym9MM";
const HARPER = "4SZHfMpw-p46Ywgs";
const FRAME = 1920;

interface FakeModel extends PhononModel {
  language: VoiceLanguage;
  device: PhononDevice;
  log: string[];
  freed: boolean;
}

function fakeRuntime(opts: { chunks?: number[]; failDevice?: PhononDevice; onStep?: (model: FakeModel) => void } = {}) {
  const chunks = opts.chunks ?? [2];
  const models: FakeModel[] = [];
  const reads: string[] = [];
  let inits = 0;
  const runtime: PhononRuntime = {
    init() {
      inits++;
      return Promise.resolve();
    },
    load(weights, tokenizer, config, language, device) {
      assert.equal(new TextDecoder().decode(weights), PHONON_PATHS.weights);
      assert.equal(new TextDecoder().decode(tokenizer), PHONON_PATHS.tokenizer);
      assert.equal(new TextDecoder().decode(config), PHONON_PATHS.config);
      if (device === opts.failDevice) return Promise.reject(new Error(`no ${device}`));
      let voices = 0;
      let pending: number[] = [];
      let frames = 0;
      let stopped = false;
      let busy = false;
      const model: FakeModel = {
        language,
        device,
        log: [],
        freed: false,
        add_voice(bytes) {
          model.log.push(`voice:${new TextDecoder().decode(bytes)}`);
          return voices++;
        },
        flush() {
          model.log.push("flush");
          return Promise.resolve();
        },
        start_generation(voice, text, temperature, seed) {
          assert.equal(temperature, PHONON_TEMPERATURE);
          assert.equal(seed, PHONON_SEED);
          model.log.push(`start:${voice}:${text}`);
          pending = [...chunks];
          stopped = false;
          return chunks.length;
        },
        next_chunk() {
          if (stopped || !pending.length) return undefined;
          frames = pending.shift()!;
          return 5;
        },
        async generation_step() {
          assert.ok(!busy, "calls on one model never overlap");
          busy = true;
          await Promise.resolve();
          busy = false;
          if (stopped || frames === 0) return undefined;
          frames--;
          model.log.push("step");
          opts.onStep?.(model);
          return new Float32Array(FRAME).fill(0.1);
        },
        stop_generation() {
          model.log.push("stop");
          stopped = true;
        },
        sample_rate: () => 24_000,
        free() {
          model.freed = true;
        },
      };
      models.push(model);
      return Promise.resolve(model);
    },
  };
  const readFile = (path: string) => {
    reads.push(path);
    return Promise.resolve(new TextEncoder().encode(path));
  };
  return { runtime, readFile, models, reads, inits: () => inits };
}

async function collect(engine: TtsEngine, request: TtsRequest, signal?: AbortSignal): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for await (const pcm of engine.stream(request, signal)) out.push(pcm);
  return out;
}

const SAY = (text: string, voice = CELIA, language: VoiceLanguage = "es"): TtsRequest => ({
  text,
  language,
  voice,
  steps: 3,
});

test("the engine loads the q8 model once and streams one PCM frame per step across every chunk", async () => {
  const fake = fakeRuntime({ chunks: [2, 3] });
  const engine = await createPhononTts({ backend: "wasm", readFile: fake.readFile, runtime: fake.runtime });
  assert.equal(engine.id, "phonon-40m");
  assert.equal(engine.sampleRate, 24_000);
  assert.equal(engine.backend, "wasm");
  assert.deepEqual(engine.voices, PHONON_VOICES);
  assert.equal(fake.models[0]!.device, "cpu");
  assert.equal(fake.models[0]!.language, "es");

  const frames = await collect(engine, SAY("  Hola, ¿qué tal? Son las 17:30.  "));
  assert.equal(frames.length, 5);
  assert.ok(frames.every((pcm) => pcm.length === FRAME));
  const log = fake.models[0]!.log;
  assert.deepEqual(log.slice(0, 3), [
    `voice:${PHONON_PATHS.voice(CELIA)}`,
    "flush",
    "start:0:Hola, ¿qué tal? Son las 17:30.",
  ]);
  assert.equal(log.at(-1), "stop");

  await collect(engine, SAY("Otra vez."));
  assert.equal(fake.reads.filter((path) => path === PHONON_PATHS.voice(CELIA)).length, 1);
  assert.equal(fake.inits(), 1);
});

test("WebGPU runs the model on the GPU device", async () => {
  const fake = fakeRuntime();
  const engine = await createPhononTts({ backend: "webgpu", readFile: fake.readFile, runtime: fake.runtime });
  assert.equal(engine.backend, "webgpu");
  assert.equal(fake.models[0]!.device, "webgpu");
});

test("blank text speaks nothing and an unknown voice is refused before reading any file", async () => {
  const fake = fakeRuntime();
  const engine = await createPhononTts({ backend: "wasm", readFile: fake.readFile, runtime: fake.runtime });
  assert.deepEqual(await collect(engine, SAY("   ")), []);
  await assert.rejects(collect(engine, SAY("Hola", "F1")), /phonon_voice_unknown:F1/);
  assert.ok(!fake.reads.some((path) => path.startsWith("voices/")));
  assert.ok(!fake.models[0]!.log.some((entry) => entry.startsWith("start")));
});

test("a language change reloads the model for that normaliser, frees the old one and registers voices again", async () => {
  const fake = fakeRuntime();
  const engine = await createPhononTts({ backend: "wasm", readFile: fake.readFile, runtime: fake.runtime });
  await collect(engine, SAY("Hola"));
  await collect(engine, SAY("Hello there", HARPER, "en"));
  assert.equal(fake.models.length, 2);
  assert.ok(fake.models[0]!.freed);
  assert.equal(fake.models[1]!.language, "en");
  assert.equal(fake.models[1]!.log[0], `voice:${PHONON_PATHS.voice(HARPER)}`);
  await collect(engine, SAY("Hola", CELIA, "es"));
  assert.equal(fake.models.length, 3);
  assert.equal(fake.models[2]!.log[0], `voice:${PHONON_PATHS.voice(CELIA)}`);
  await engine.dispose();
  assert.ok(fake.models[2]!.freed);
});

test("aborting mid-utterance stops generation after the pending step and yields nothing more", async () => {
  const controller = new AbortController();
  let steps = 0;
  const fake = fakeRuntime({
    chunks: [10, 10],
    onStep: () => {
      if (++steps === 3) controller.abort();
    },
  });
  const engine = await createPhononTts({ backend: "wasm", readFile: fake.readFile, runtime: fake.runtime });
  const frames = await collect(engine, SAY("Una frase larga."), controller.signal);
  assert.equal(frames.length, 2);
  assert.equal(fake.models[0]!.log.filter((entry) => entry === "step").length, 3);
  assert.equal(fake.models[0]!.log.at(-1), "stop");
});

test("speaking hands control back to the event loop between frames so a cancel from another task lands", async () => {
  const fake = fakeRuntime({ chunks: [50, 50] });
  const engine = await createPhononTts({ backend: "wasm", readFile: fake.readFile, runtime: fake.runtime });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  let frames = 0;
  for await (const pcm of speak(engine, SAY("Una respuesta muy larga."), controller.signal)) {
    void pcm;
    if (controller.signal.aborted) break;
    frames++;
  }
  assert.ok(frames < 10, `stopped after ${frames} frames`);
  assert.equal(fake.models[0]!.log.at(-1), "stop");
});

test("every engine gets markdown and emoji stripped while accents, addresses and paths survive", async () => {
  const fake = fakeRuntime();
  const engine = await createPhononTts({ backend: "wasm", readFile: fake.readFile, runtime: fake.runtime });
  for await (const pcm of speak(engine, SAY("**Hecho** ✅ revisa `npm test` en src/app_main.ts"))) void pcm;
  assert.equal(fake.models[0]!.log[2], "start:0:Hecho revisa 'npm test' en src/app_main.ts.");
  assert.equal(cleanSpeechText("- uno\n- dos #ok 🚀"), "uno dos ok.");
  assert.equal(cleanSpeechText("Escribe a ana@omniloy.com, mañana"), "Escribe a ana@omniloy.com, mañana.");
});

test("a consumer that stops early still ends the generation", async () => {
  const fake = fakeRuntime({ chunks: [10] });
  const engine = await createPhononTts({ backend: "wasm", readFile: fake.readFile, runtime: fake.runtime });
  for await (const pcm of engine.stream(SAY("Hola"))) {
    assert.equal(pcm.length, FRAME);
    break;
  }
  assert.equal(fake.models[0]!.log.at(-1), "stop");
});

test("the loader falls back from WebGPU to the CPU and warms up with the default Spanish voice", async () => {
  const fake = fakeRuntime({ failDevice: "webgpu" });
  const engine = await loadTtsEngine("phonon-40m", {
    ort: {} as OrtModule,
    phonon: fake.runtime,
    backend: "webgpu",
    readFile: fake.readFile,
  });
  assert.equal(engine.backend, "wasm");
  assert.equal(fake.models.length, 1);
  assert.deepEqual(fake.models[0]!.log.slice(0, 3), [`voice:${PHONON_PATHS.voice(CELIA)}`, "flush", "start:0:Hola."]);
});
