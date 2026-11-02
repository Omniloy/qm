import init, { Model } from "phonon-tts/raw";
import relaxedWasmUrl from "phonon-tts/wasm/phonon_tts_bg.wasm?url";
import simdWasmUrl from "phonon-tts/wasm/phonon_tts_simd_bg.wasm?url";
import type { PhononRuntime } from "./phonon.ts";

let ready: Promise<void> | null = null;

async function initWasm(): Promise<void> {
  try {
    await init({ module_or_path: relaxedWasmUrl });
  } catch (error) {
    if (!(error instanceof WebAssembly.CompileError)) throw error;
    await init({ module_or_path: simdWasmUrl });
  }
}

export const PHONON_RUNTIME: PhononRuntime = {
  init() {
    ready ??= initWasm().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  },
  load: (weights, tokenizer, config, language, device) =>
    Model.load(weights, tokenizer, config, "q8", language, undefined, undefined, device),
};
