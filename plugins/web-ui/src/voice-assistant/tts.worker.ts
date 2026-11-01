import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { errMessage, swallow } from "../../../chassis/src/errors.ts";
import { readModelFile } from "./model-cache.ts";
import type { ModelFile, TtsEngine, TtsWorkerIn, TtsWorkerOut } from "./protocol.ts";
import { loadTtsEngine } from "./tts/engine.ts";

type SpeakJob = Extract<TtsWorkerIn, { type: "speak" }>;

ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
ort.env.wasm.numThreads = 1;

let engine: TtsEngine | null = null;
let generation = 0;
let pumping: Promise<void> | null = null;
let queue: SpeakJob[] = [];
let current: { job: SpeakJob; controller: AbortController } | null = null;

function send(message: TtsWorkerOut, transfer: Transferable[] = []): void {
  postMessage(message, { transfer });
}

function fileReader(files: readonly ModelFile[]): (path: string) => Promise<Uint8Array> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return (path) => {
    const file = byPath.get(path);
    if (!file) return Promise.reject(new Error(`model_unlisted:${path}`));
    return readModelFile(file);
  };
}

function cancel(utteranceId?: string): void {
  queue = utteranceId === undefined ? [] : queue.filter((job) => job.utteranceId !== utteranceId);
  if (current && (utteranceId === undefined || current.job.utteranceId === utteranceId)) current.controller.abort();
}

async function drainQueue(): Promise<void> {
  for (let active = engine; active && queue.length > 0; active = engine) {
    const job = queue.shift() as SpeakJob;
    const controller = new AbortController();
    current = { job, controller };
    try {
      const pcm = await active.synthesize(
        { text: job.text, language: job.language, voice: job.voice, steps: job.steps },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        send(
          {
            type: "pcm",
            utteranceId: job.utteranceId,
            chunkIndex: job.chunkIndex,
            pcm,
            sampleRate: active.sampleRate,
            chars: job.text.length,
          },
          [pcm.buffer],
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        send({
          type: "error",
          utteranceId: job.utteranceId,
          chunkIndex: job.chunkIndex,
          reason: errMessage(error),
          fatal: false,
        });
      }
    } finally {
      current = null;
    }
  }
}

function pump(): Promise<void> {
  pumping ??= drainQueue().finally(() => {
    pumping = null;
  });
  return pumping;
}

async function dispose(): Promise<void> {
  generation++;
  cancel();
  const previous = engine;
  engine = null;
  await pumping;
  await previous?.dispose().catch((e: unknown) => swallow("tts engine dispose", e));
}

async function init(message: Extract<TtsWorkerIn, { type: "init" }>): Promise<void> {
  const disposing = dispose();
  const mine = generation;
  await disposing;
  try {
    const loaded = await loadTtsEngine(message.engine, {
      ort,
      backend: message.backend,
      readFile: fileReader(message.files),
    });
    if (mine !== generation) {
      await loaded.dispose();
      return;
    }
    engine = loaded;
    send({ type: "ready", engine: loaded.id, backend: loaded.backend, sampleRate: loaded.sampleRate });
    void pump();
  } catch (error) {
    if (mine === generation) send({ type: "error", reason: errMessage(error), fatal: true });
  }
}

addEventListener("message", (event: MessageEvent<TtsWorkerIn>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      void init(message);
      return;
    case "speak":
      queue.push(message);
      void pump();
      return;
    case "cancel":
      cancel(message.utteranceId);
      return;
    case "dispose":
      void dispose().then(() => close());
      return;
  }
});
