import { swallow } from "../../../../chassis/src/errors.ts";
import type { ExecutionBackend, TtsEngine, TtsEngineId, VoiceLanguage } from "../protocol.ts";
import { createSupertonic, type OrtModule } from "./supertonic.ts";

export interface TtsEngineDeps {
  ort: OrtModule;
  backend: ExecutionBackend;
  readFile(path: string): Promise<Uint8Array>;
}

const WARMUP: { text: string; language: VoiceLanguage; voice: string; steps: number } = {
  text: "Hola.",
  language: "es",
  voice: "F1",
  steps: 1,
};

export function backendAttempts(preferred: ExecutionBackend): ExecutionBackend[] {
  return preferred === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
}

function createEngine(id: TtsEngineId, deps: TtsEngineDeps, backend: ExecutionBackend): Promise<TtsEngine> {
  switch (id) {
    case "supertonic-3":
      return createSupertonic({ ort: deps.ort, executionProviders: [backend], backend, readFile: deps.readFile });
  }
}

export async function loadTtsEngine(id: TtsEngineId, deps: TtsEngineDeps): Promise<TtsEngine> {
  let lastError: unknown = new Error("tts_engine_unavailable");
  for (const backend of backendAttempts(deps.backend)) {
    let engine: TtsEngine | null = null;
    try {
      engine = await createEngine(id, deps, backend);
      await engine.synthesize(WARMUP);
      return engine;
    } catch (error) {
      lastError = error;
      await engine?.dispose().catch((e: unknown) => swallow("tts engine dispose", e));
    }
  }
  throw lastError;
}
