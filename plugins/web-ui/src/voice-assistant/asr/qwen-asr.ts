import type * as Ort from "onnxruntime-web";
import { SPEECH_SAMPLE_RATE } from "../protocol.ts";
import type { AsrEngine, AsrRequest, AsrResult, AsrVariant, VoiceLanguage } from "../protocol.ts";
import { MEL_BINS, logMel } from "./mel.ts";
import { asrPaths } from "./models.ts";
import { createTokenDecoder } from "./tokenizer.ts";

export type OrtModule = typeof Ort;

export interface QwenAsrDeps {
  ort: OrtModule;
  variant: AsrVariant;
  executionProviders: readonly string[];
  readFile(path: string): Promise<Uint8Array>;
}

const HIDDEN = 1024;
const AUDIO_PAD = 151676;
const ASR_TEXT = 151704;
const EOS = new Set([151643, 151645]);
const PROMPT_PREFIX = [151644, 8948, 198, 151645, 198, 151644, 872, 198, 151669];
const PROMPT_SUFFIX = [151670, 151645, 198, 151644, 77091, 198];
const LANGUAGE_PREFIX: Readonly<Record<VoiceLanguage, readonly number[]>> = {
  es: [11528, 15154, ASR_TEXT],
  en: [11528, 6364, ASR_TEXT],
};

export function buildPromptIds(audioTokens: number, language: VoiceLanguage): number[] {
  return [
    ...PROMPT_PREFIX,
    ...Array.from({ length: audioTokens }, () => AUDIO_PAD),
    ...PROMPT_SUFFIX,
    ...LANGUAGE_PREFIX[language],
  ];
}

export function transcriptFromTokens(ids: readonly number[]): number[] {
  const marker = ids.lastIndexOf(ASR_TEXT);
  return ids.slice(marker + 1);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(value: number): number {
  f32[0] = value;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const rawExponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (rawExponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
  const exponent = rawExponent - 112;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const full = mantissa | 0x800000;
    const shift = 14 - exponent;
    return sign | ((full >>> shift) + ((full >>> (shift - 1)) & 1));
  }
  return (sign | (exponent << 10) | (mantissa >>> 13)) + ((mantissa >>> 12) & 1);
}

function halfOrder(bits: number): number {
  return bits & 0x8000 ? -(bits & 0x7fff) : bits & 0x7fff;
}

export function argmax(data: ArrayLike<number>, halfBits: boolean): number {
  let best = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const value = halfBits ? halfOrder(data[i]) : data[i];
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

function floatView(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export async function createQwenAsr(deps: QwenAsrDeps): Promise<AsrEngine> {
  const { ort, variant } = deps;
  const paths = asrPaths(variant);
  const half = variant === "q4f16";
  const gpu = deps.executionProviders.includes("webgpu");
  const [encoderBytes, initBytes, stepBytes, weights, embedBytes, scaleBytes, vocabBytes] = await Promise.all(
    [
      paths.encoder,
      paths.decoderInit,
      paths.decoderStep,
      paths.decoderWeights,
      paths.embedTokens,
      paths.embedScales,
      paths.vocab,
    ].map((path) => deps.readFile(path)),
  );
  const base: Ort.InferenceSession.SessionOptions = {
    executionProviders: [...deps.executionProviders],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3,
  };
  const decoderOptions: Ort.InferenceSession.SessionOptions = {
    ...base,
    externalData: [{ path: basename(paths.decoderWeights), data: weights }],
    ...(gpu ? { preferredOutputLocation: { present_keys: "gpu-buffer", present_values: "gpu-buffer" } } : {}),
  };
  const encoder = await ort.InferenceSession.create(encoderBytes, base);
  const decoderInit = await ort.InferenceSession.create(initBytes, decoderOptions);
  const decoderStep = await ort.InferenceSession.create(stepBytes, decoderOptions);
  const table = new Int8Array(embedBytes.buffer, embedBytes.byteOffset, embedBytes.byteLength);
  const scales = floatView(scaleBytes);
  const decoder = createTokenDecoder(vocabBytes);

  const embedRow = (id: number, out: Float32Array, row: number) => {
    const scale = scales[id];
    const from = id * HIDDEN;
    const to = row * HIDDEN;
    for (let j = 0; j < HIDDEN; j++) out[to + j] = table[from + j] * scale;
  };

  const embedsTensor = (embeds: Float32Array, length: number): Ort.Tensor =>
    half
      ? new ort.Tensor("float16", Uint16Array.from(embeds, toHalf), [1, length, HIDDEN])
      : new ort.Tensor("float32", embeds, [1, length, HIDDEN]);

  const positions = (from: number, length: number) =>
    new ort.Tensor(
      "int64",
      BigInt64Array.from({ length }, (_, i) => BigInt(from + i)),
      [1, length],
    );

  const nextToken = (logits: Ort.Tensor) =>
    argmax(logits.data as ArrayLike<number>, half && logits.data instanceof Uint16Array);

  return {
    id: "qwen3-asr-0.6b",
    variant,
    backend: gpu ? "webgpu" : "wasm",
    async transcribe(audio: Float32Array, request: AsrRequest, signal?: AbortSignal): Promise<AsrResult> {
      const audioMs = (audio.length * 1_000) / SPEECH_SAMPLE_RATE;
      const started = performance.now();
      signal?.throwIfAborted();
      const mel = logMel(audio);
      if (mel.frames === 0) return { text: "", tokens: 0, audioMs, encodeMs: 0, decodeMs: 0 };
      const encoded = await encoder.run({ mel: new ort.Tensor("float32", mel.data, [1, MEL_BINS, mel.frames]) });
      const features = encoded.audio_features;
      const audioTokens = features.dims[1];
      const featureData = features.data as Float32Array;
      const ids = buildPromptIds(audioTokens, request.language);
      const embeds = new Float32Array(ids.length * HIDDEN);
      ids.forEach((id, row) => {
        if (id !== AUDIO_PAD) embedRow(id, embeds, row);
      });
      embeds.set(featureData.subarray(0, audioTokens * HIDDEN), PROMPT_PREFIX.length * HIDDEN);
      features.dispose();
      const encodeMs = performance.now() - started;
      signal?.throwIfAborted();

      const generated: number[] = [];
      const stepEmbeds = new Float32Array(HIDDEN);
      let out = await decoderInit.run({
        input_embeds: embedsTensor(embeds, ids.length),
        position_ids: positions(0, ids.length),
      });
      try {
        for (;;) {
          const token = nextToken(out.logits);
          out.logits.dispose();
          if (EOS.has(token)) break;
          generated.push(token);
          if (generated.length >= request.maxNewTokens) break;
          signal?.throwIfAborted();
          embedRow(token, stepEmbeds, 0);
          const previous = out;
          out = await decoderStep.run({
            input_embeds: embedsTensor(stepEmbeds, 1),
            position_ids: positions(ids.length + generated.length - 1, 1),
            past_keys: previous.present_keys,
            past_values: previous.present_values,
          });
          previous.present_keys.dispose();
          previous.present_values.dispose();
        }
      } finally {
        out.present_keys.dispose();
        out.present_values.dispose();
      }
      return {
        text: decoder.decode(transcriptFromTokens(generated)).trim(),
        tokens: generated.length,
        audioMs,
        encodeMs,
        decodeMs: performance.now() - started - encodeMs,
      };
    },
    async dispose() {
      await Promise.all([encoder.release(), decoderInit.release(), decoderStep.release()]);
    },
  };
}
