import { swallow } from "../../../../chassis/src/errors.ts";
import type { ExecutionBackend, TtsEngine, TtsEngineId, TtsRequest } from "../protocol.ts";
import { ttsWarmupVoice } from "./models.ts";
import { cleanSpeechText } from "./normalize.ts";
import { createPhononTts, type PhononRuntime } from "./phonon.ts";
import { createSupertonic, type OrtModule } from "./supertonic.ts";

export interface TtsEngineDeps {
  ort: OrtModule;
  phonon: PhononRuntime;
  backend: ExecutionBackend;
  readFile(path: string): Promise<Uint8Array>;
}

export function backendAttempts(preferred: ExecutionBackend): ExecutionBackend[] {
  return preferred === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
}

function createEngine(id: TtsEngineId, deps: TtsEngineDeps, backend: ExecutionBackend): Promise<TtsEngine> {
  switch (id) {
    case "phonon-40m":
      return createPhononTts({ backend, readFile: deps.readFile, runtime: deps.phonon });
    case "supertonic-3":
      return createSupertonic({ ort: deps.ort, executionProviders: [backend], backend, readFile: deps.readFile });
  }
}

async function warmUp(engine: TtsEngine): Promise<void> {
  for await (const pcm of engine.stream({ text: "Hola.", language: "es", voice: ttsWarmupVoice(engine.id), steps: 1 }))
    void pcm;
}

export async function loadTtsEngine(id: TtsEngineId, deps: TtsEngineDeps): Promise<TtsEngine> {
  let lastError: unknown = new Error("tts_engine_unavailable");
  for (const backend of backendAttempts(deps.backend)) {
    let engine: TtsEngine | null = null;
    try {
      engine = await createEngine(id, deps, backend);
      await warmUp(engine);
      return engine;
    } catch (error) {
      lastError = error;
      await engine?.dispose().catch((e: unknown) => swallow("tts engine dispose", e));
    }
  }
  throw lastError;
}

function yieldToEventLoop(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve) => {
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

export async function* speak(
  engine: TtsEngine,
  request: TtsRequest,
  signal?: AbortSignal,
): AsyncGenerator<Float32Array> {
  for await (const pcm of engine.stream({ ...request, text: cleanSpeechText(request.text) }, signal)) {
    yield pcm;
    await yieldToEventLoop();
  }
}
