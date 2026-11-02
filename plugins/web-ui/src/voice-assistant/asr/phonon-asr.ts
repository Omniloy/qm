import type * as Ort from "onnxruntime-web";
import { SPEECH_SAMPLE_RATE } from "../protocol.ts";
import type { AsrEngine, AsrRequest, AsrResult, AsrVariant, ExecutionBackend } from "../protocol.ts";
import { MEL_BINS } from "./mel.ts";
import { PHONON_ASR_PATHS } from "./models.ts";
import { nemoLogMel } from "./phonon-mel.ts";
import { greedyTdt } from "./phonon-tdt.ts";
import { createPieceDecoder } from "./phonon-vocab.ts";
import type { OrtModule } from "./qwen-asr.ts";

export interface PhononAsrDeps {
  ort: OrtModule;
  variant: AsrVariant;
  executionProviders: readonly ExecutionBackend[];
  readFile(path: string): Promise<Uint8Array>;
}

const ENCODED = 640;
const DECODER_LAYERS = 2;

interface DecoderState {
  h: Ort.Tensor;
  c: Ort.Tensor;
}

export async function createPhononAsr(deps: PhononAsrDeps): Promise<AsrEngine> {
  const { ort } = deps;
  const [encoderBytes, decoderBytes, vocabBytes] = await Promise.all(
    [PHONON_ASR_PATHS.encoder, PHONON_ASR_PATHS.decoderJoint, PHONON_ASR_PATHS.vocab].map((path) =>
      deps.readFile(path),
    ),
  );
  const base: Ort.InferenceSession.SessionOptions = { graphOptimizationLevel: "all", logSeverityLevel: 3 };
  const encoder = await ort.InferenceSession.create(encoderBytes, {
    ...base,
    executionProviders: [...deps.executionProviders],
  });
  const decoder = await ort.InferenceSession.create(decoderBytes, {
    ...base,
    executionProviders: ["wasm"],
    extra: { session: { disable_quant_qdq: "1" } },
  });
  const pieces = createPieceDecoder(vocabBytes);
  const zeros = () =>
    new ort.Tensor("float32", new Float32Array(DECODER_LAYERS * ENCODED), [DECODER_LAYERS, 1, ENCODED]);

  return {
    id: "phonon-2.5",
    variant: deps.variant,
    backend: deps.executionProviders[0] ?? "wasm",
    async transcribe(audio: Float32Array, request: AsrRequest, signal?: AbortSignal): Promise<AsrResult> {
      const audioMs = (audio.length * 1_000) / SPEECH_SAMPLE_RATE;
      const started = performance.now();
      signal?.throwIfAborted();
      const mel = nemoLogMel(audio);
      if (mel.frames === 0) return { text: "", tokens: 0, audioMs, encodeMs: 0, decodeMs: 0 };
      const { encoded } = await encoder.run({
        features: new ort.Tensor("float32", mel.data, [1, mel.frames, MEL_BINS]),
      });
      const frames = encoded.dims[1];
      const encodedData = encoded.data as Float32Array;
      const encodeMs = performance.now() - started;
      const tokens = await greedyTdt<DecoderState>({
        frames,
        initial: { h: zeros(), c: zeros() },
        maxTokens: request.maxNewTokens,
        signal,
        async step(frame, token, state) {
          const out = await decoder.run({
            encoded: new ort.Tensor("float32", encodedData.slice(frame * ENCODED, (frame + 1) * ENCODED), [1, ENCODED]),
            token: new ort.Tensor("int32", Int32Array.of(token), [1]),
            h: state.h,
            c: state.c,
          });
          return { logits: out.logits.data as Float32Array, state: { h: out.h_out, c: out.c_out } };
        },
      });
      encoded.dispose();
      return {
        text: pieces.decode(tokens),
        tokens: tokens.length,
        audioMs,
        encodeMs,
        decodeMs: performance.now() - started - encodeMs,
      };
    },
    async dispose() {
      await Promise.all([encoder.release(), decoder.release()]);
    },
  };
}
