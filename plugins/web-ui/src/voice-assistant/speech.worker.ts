import { FrameProcessor } from "@ricky0123/vad-web/dist/frame-processor.js";
import { Silero } from "@ricky0123/vad-web/dist/models/silero.js";
import sileroUrl from "@ricky0123/vad-web/dist/silero_vad_v6.onnx?url";
import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { errMessage } from "../../../chassis/src/errors.ts";
import { createQwenAsr } from "./asr/qwen-asr.ts";
import { readModelFile } from "./model-cache.ts";
import {
  SPEECH_FRAME_MS,
  SPEECH_SAMPLE_RATE,
  type AsrEngine,
  type ModelFile,
  type SpeechMode,
  type SpeechWorkerIn,
  type SpeechWorkerOut,
  type VadOptions,
  type VoiceLanguage,
} from "./protocol.ts";
import { createSpeechPipeline, type SpeechPipeline } from "./speech-pipeline.ts";

type InitMessage = Extract<SpeechWorkerIn, { type: "init" }>;

const WARMUP_SAMPLES = SPEECH_SAMPLE_RATE / 2;

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
ort.env.wasm.numThreads = 1;

let pipeline: SpeechPipeline | null = null;
let framePort: MessagePort | null = null;
let releaseVad: (() => Promise<void>) | null = null;
let asr: AsrEngine | null = null;
let pendingMode: SpeechMode = "paused";
let pendingLanguage: VoiceLanguage = "es";
let pendingVad: Partial<VadOptions> = {};
let disposed = false;

function send(message: SpeechWorkerOut): void {
  postMessage(message);
}

function hasWebGpu(): boolean {
  return typeof (navigator as Navigator & { gpu?: unknown }).gpu === "object";
}

function fileReader(files: readonly ModelFile[]): (path: string) => Promise<Uint8Array> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return (path) => {
    const file = byPath.get(path);
    if (!file) return Promise.reject(new Error(`model_unlisted:${path}`));
    return readModelFile(file);
  };
}

async function loadVad(options: VadOptions): Promise<FrameProcessor> {
  const model = await Silero.new(ort, async () => (await fetch(sileroUrl)).arrayBuffer());
  releaseVad = () => model.release();
  return new FrameProcessor(model.process, model.reset_state, { ...options, ...pendingVad }, SPEECH_FRAME_MS);
}

async function loadAsr(message: InitMessage): Promise<AsrEngine> {
  if (!hasWebGpu()) throw new Error("webgpu_unavailable");
  const engine = await createQwenAsr({
    ort,
    variant: message.asrVariant,
    executionProviders: ["webgpu"],
    readFile: fileReader(message.asrFiles),
  });
  asr = engine;
  return engine;
}

async function warmUp(engine: AsrEngine, language: VoiceLanguage): Promise<void> {
  await engine.transcribe(new Float32Array(WARMUP_SAMPLES), { language, maxNewTokens: 2 });
}

async function init(message: InitMessage): Promise<void> {
  framePort = message.framePort;
  framePort.onmessage = (event: MessageEvent<Float32Array>) => pipeline?.frame(event.data);
  pendingLanguage = message.language;

  send({ type: "loading", stage: "vad" });
  let vad: FrameProcessor;
  try {
    vad = await loadVad(message.vad);
  } catch (error) {
    send({ type: "error", stage: "vad", reason: errMessage(error), fatal: true });
    return;
  }

  send({ type: "loading", stage: "asr" });
  let engine: AsrEngine;
  try {
    engine = await loadAsr(message);
    send({ type: "loading", stage: "warmup" });
    await warmUp(engine, pendingLanguage);
  } catch (error) {
    send({ type: "error", stage: "asr", reason: errMessage(error), fatal: true });
    return;
  }
  if (disposed) return;

  pipeline = createSpeechPipeline({
    vad,
    language: pendingLanguage,
    mode: pendingMode,
    post: send,
    transcribe: (audio, request) => engine.transcribe(audio, request),
  });
  send({ type: "ready", backend: engine.backend, asrVariant: engine.variant });
}

async function dispose(): Promise<void> {
  disposed = true;
  pipeline?.setMode("paused");
  pipeline = null;
  if (framePort) {
    framePort.onmessage = null;
    framePort.close();
    framePort = null;
  }
  await Promise.allSettled([asr?.dispose(), releaseVad?.()]);
  asr = null;
  releaseVad = null;
  close();
}

addEventListener("message", (event: MessageEvent<SpeechWorkerIn>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      void init(message).catch((error: unknown) =>
        send({ type: "error", stage: "frames", reason: errMessage(error), fatal: true }),
      );
      return;
    case "mode":
      pendingMode = message.mode;
      pipeline?.setMode(message.mode);
      return;
    case "config":
      if (message.language) pendingLanguage = message.language;
      if (message.vad) pendingVad = { ...pendingVad, ...message.vad };
      pipeline?.configure({ language: message.language, vad: message.vad });
      return;
    case "end-segment":
      pipeline?.endSegment();
      return;
    case "dispose":
      void dispose();
      return;
  }
});
