import type { ExecutionBackend, TtsEngine, TtsRequest, VoiceLanguage } from "../protocol.ts";
import { PHONON_VOICES } from "../voices.ts";

export type PhononDevice = "cpu" | "webgpu";

export interface PhononModel {
  add_voice(voice: Uint8Array): number;
  flush(): Promise<unknown>;
  start_generation(voiceIndex: number, text: string, temperature: number, seed: bigint): number;
  next_chunk(): number | undefined;
  generation_step(): Promise<Float32Array | undefined>;
  stop_generation(): void;
  sample_rate(): number;
  free(): void;
}

export interface PhononRuntime {
  init(): Promise<void>;
  load(
    weights: Uint8Array,
    tokenizer: Uint8Array,
    config: Uint8Array,
    language: VoiceLanguage,
    device: PhononDevice,
  ): Promise<PhononModel>;
}

export interface PhononTtsDeps {
  backend: ExecutionBackend;
  readFile(path: string): Promise<Uint8Array>;
  runtime: PhononRuntime;
}

export const PHONON_PATHS = {
  weights: "model.q8.gguf",
  tokenizer: "tokenizer.json",
  config: "config.json",
  voice: (id: string) => `voices/${id}.safetensors`,
} as const;

export const PHONON_TEMPERATURE = 0.3;
export const PHONON_SEED = 4242424242424242n;

export async function createPhononTts(deps: PhononTtsDeps): Promise<TtsEngine> {
  await deps.runtime.init();
  const [weights, tokenizer, config] = await Promise.all([
    deps.readFile(PHONON_PATHS.weights),
    deps.readFile(PHONON_PATHS.tokenizer),
    deps.readFile(PHONON_PATHS.config),
  ]);
  const device: PhononDevice = deps.backend === "webgpu" ? "webgpu" : "cpu";
  const load = (language: VoiceLanguage) => deps.runtime.load(weights, tokenizer, config, language, device);

  let language: VoiceLanguage = "es";
  let model = await load(language);
  let voices = new Map<string, number>();

  const modelFor = async (wanted: VoiceLanguage) => {
    if (wanted === language) return model;
    const next = await load(wanted);
    model.free();
    model = next;
    voices = new Map();
    language = wanted;
    return model;
  };

  const voiceIndex = async (active: PhononModel, id: string) => {
    const known = voices.get(id);
    if (known !== undefined) return known;
    if (!PHONON_VOICES.some((voice) => voice.id === id)) throw new Error(`phonon_voice_unknown:${id}`);
    const index = active.add_voice(await deps.readFile(PHONON_PATHS.voice(id)));
    await active.flush();
    voices.set(id, index);
    return index;
  };

  async function* stream(request: TtsRequest, signal?: AbortSignal): AsyncGenerator<Float32Array> {
    const text = request.text.trim();
    if (!text) return;
    signal?.throwIfAborted();
    const active = await modelFor(request.language);
    const index = await voiceIndex(active, request.voice);
    signal?.throwIfAborted();
    active.start_generation(index, text, PHONON_TEMPERATURE, PHONON_SEED);
    try {
      while (!signal?.aborted && active.next_chunk() !== undefined) {
        for (;;) {
          const pcm = await active.generation_step();
          if (!pcm || signal?.aborted) break;
          yield pcm;
        }
      }
    } finally {
      active.stop_generation();
    }
  }

  return {
    id: "phonon-40m",
    sampleRate: model.sample_rate(),
    voices: PHONON_VOICES,
    backend: device === "webgpu" ? "webgpu" : "wasm",
    stream,
    dispose() {
      voices.clear();
      model.free();
      return Promise.resolve();
    },
  };
}
