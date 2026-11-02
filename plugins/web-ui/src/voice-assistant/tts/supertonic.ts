import type * as OrtWeb from "onnxruntime-web";
import type { ExecutionBackend, TtsEngine, TtsRequest, VoiceLanguage } from "../protocol.ts";
import { SUPERTONIC_VOICES } from "../voices.ts";
import { normalizeSpeechText } from "./normalize.ts";

export type OrtModule = typeof OrtWeb;

type Session = OrtWeb.InferenceSession;
type Tensor = OrtWeb.Tensor;

export interface SupertonicDeps {
  ort: OrtModule;
  executionProviders: readonly string[];
  backend: ExecutionBackend;
  readFile(path: string): Promise<Uint8Array>;
}

export interface SupertonicConfig {
  sampleRate: number;
  baseChunkSize: number;
  chunkCompressFactor: number;
  latentDim: number;
}

export interface VoiceStyleData {
  ttl: { data: Float32Array; dims: number[] };
  dp: { data: Float32Array; dims: number[] };
}

export const SUPERTONIC_MAX_CHARS = 300;
const SUPERTONIC_DEFAULT_SPEED = 1.05;
const SUPERTONIC_MAX_STEPS = 10;

export const SUPERTONIC_PATHS = {
  config: "onnx/tts.json",
  indexer: "onnx/unicode_indexer.json",
  durationPredictor: "onnx/duration_predictor.onnx",
  textEncoder: "onnx/text_encoder.onnx",
  vectorEstimator: "onnx/vector_estimator.onnx",
  vocoder: "onnx/vocoder.onnx",
  voice: (voice: string) => `voice_styles/${voice}.json`,
} as const;

const TARGET_RMS = 0.06;
const PEAK_LIMIT = 0.95;
const SENTENCE_PAUSE_SECONDS = 0.3;
const CLAUSE_PAUSE_SECONDS = 0.12;

function wrapLanguage(text: string, language: VoiceLanguage): string {
  return `<${language}>${text}</${language}>`;
}

export function supertonicInput(text: string, language: VoiceLanguage): string {
  return wrapLanguage(normalizeSpeechText(text, language), language);
}

export function encodeSupertonicText(indexer: readonly number[], input: string): BigInt64Array {
  const ids = new BigInt64Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const codePoint = input.codePointAt(i) ?? 0;
    ids[i] = BigInt(codePoint < indexer.length ? indexer[codePoint] : -1);
  }
  return ids;
}

export function parseSupertonicConfig(json: unknown): SupertonicConfig {
  const cfg = json as {
    ae?: { sample_rate?: number; base_chunk_size?: number };
    ttl?: { chunk_compress_factor?: number; latent_dim?: number };
  };
  const sampleRate = cfg.ae?.sample_rate;
  const baseChunkSize = cfg.ae?.base_chunk_size;
  const chunkCompressFactor = cfg.ttl?.chunk_compress_factor;
  const latentDim = cfg.ttl?.latent_dim;
  if (!sampleRate || !baseChunkSize || !chunkCompressFactor || !latentDim) throw new Error("supertonic_config_invalid");
  return { sampleRate, baseChunkSize, chunkCompressFactor, latentDim };
}

function styleTensorData(value: unknown, name: string): { data: Float32Array; dims: number[] } {
  const entry = value as { data?: unknown; dims?: unknown } | undefined;
  if (!entry || !Array.isArray(entry.data) || !Array.isArray(entry.dims))
    throw new Error(`supertonic_style_invalid:${name}`);
  const dims = entry.dims.map(Number);
  const data = Float32Array.from((entry.data as unknown[]).flat(Infinity) as number[]);
  if (data.length !== dims.reduce((a, b) => a * b, 1)) throw new Error(`supertonic_style_invalid:${name}`);
  return { data, dims };
}

export function parseVoiceStyle(json: unknown): VoiceStyleData {
  const style = json as { style_ttl?: unknown; style_dp?: unknown };
  return { ttl: styleTensorData(style.style_ttl, "style_ttl"), dp: styleTensorData(style.style_dp, "style_dp") };
}

export function latentShape(
  durationSeconds: number,
  cfg: SupertonicConfig,
): { channels: number; frames: number; wavSamples: number } {
  const wavSamples = Math.floor(durationSeconds * cfg.sampleRate);
  const chunkSize = cfg.baseChunkSize * cfg.chunkCompressFactor;
  return {
    channels: cfg.latentDim * cfg.chunkCompressFactor,
    frames: Math.max(1, Math.floor((wavSamples + chunkSize - 1) / chunkSize)),
    wavSamples,
  };
}

export function sampleNoisyLatent(channels: number, frames: number, random: () => number = Math.random): Float32Array {
  const xt = new Float32Array(channels * frames);
  for (let i = 0; i < xt.length; i++) {
    const u1 = Math.max(0.0001, random());
    const u2 = random();
    xt[i] = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }
  return xt;
}

export function trailingPauseSeconds(text: string): number {
  return /[.!?…]["')\]»]*\s*$/.test(text) ? SENTENCE_PAUSE_SECONDS : CLAUSE_PAUSE_SECONDS;
}

export function levelSpeech(pcm: Float32Array): Float32Array {
  let sum = 0;
  let peak = 0;
  for (const v of pcm) {
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  if (peak === 0) return pcm;
  const gain = Math.min(TARGET_RMS / Math.sqrt(sum / pcm.length), PEAK_LIMIT / peak);
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  return pcm;
}

export function clampSteps(steps: number): number {
  if (!Number.isFinite(steps)) return 1;
  return Math.min(SUPERTONIC_MAX_STEPS, Math.max(1, Math.round(steps)));
}

async function readJson(deps: SupertonicDeps, path: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await deps.readFile(path)));
}

export async function createSupertonic(deps: SupertonicDeps): Promise<TtsEngine> {
  const { ort } = deps;
  const cfg = parseSupertonicConfig(await readJson(deps, SUPERTONIC_PATHS.config));
  const indexer = (await readJson(deps, SUPERTONIC_PATHS.indexer)) as number[];
  const options: OrtWeb.InferenceSession.SessionOptions = {
    executionProviders: [...deps.executionProviders],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3,
  };
  const sessions: Session[] = [];
  const open = async (path: string) => {
    const session = await ort.InferenceSession.create(await deps.readFile(path), options);
    sessions.push(session);
    return session;
  };
  let durationPredictor: Session;
  let textEncoder: Session;
  let vectorEstimator: Session;
  let vocoder: Session;
  try {
    durationPredictor = await open(SUPERTONIC_PATHS.durationPredictor);
    textEncoder = await open(SUPERTONIC_PATHS.textEncoder);
    vectorEstimator = await open(SUPERTONIC_PATHS.vectorEstimator);
    vocoder = await open(SUPERTONIC_PATHS.vocoder);
  } catch (error) {
    await Promise.all(sessions.map((s) => s.release()));
    throw error;
  }

  const styles = new Map<string, Promise<{ ttl: Tensor; dp: Tensor }>>();
  const styleFor = (voice: string) => {
    if (!SUPERTONIC_VOICES.some((option) => option.id === voice)) throw new Error(`supertonic_voice_unknown:${voice}`);
    let style = styles.get(voice);
    if (!style) {
      style = readJson(deps, SUPERTONIC_PATHS.voice(voice)).then((json) => {
        const parsed = parseVoiceStyle(json);
        return {
          ttl: new ort.Tensor("float32", parsed.ttl.data, parsed.ttl.dims),
          dp: new ort.Tensor("float32", parsed.dp.data, parsed.dp.dims),
        };
      });
      style.catch(() => styles.delete(voice));
      styles.set(voice, style);
    }
    return style;
  };

  const synthesize = async (request: TtsRequest, signal?: AbortSignal): Promise<Float32Array> => {
    signal?.throwIfAborted();
    if (request.text.length > SUPERTONIC_MAX_CHARS)
      throw new RangeError(`supertonic_text_too_long:${request.text.length}`);
    const normalized = normalizeSpeechText(request.text, request.language);
    if (!/[\p{L}\p{N}]/u.test(normalized)) return new Float32Array(0);
    const input = wrapLanguage(normalized, request.language);
    const style = await styleFor(request.voice);
    const totalStep = clampSteps(request.steps);
    const speed = request.speed ?? SUPERTONIC_DEFAULT_SPEED;

    const ids = encodeSupertonicText(indexer, input);
    const textIds = new ort.Tensor("int64", ids, [1, ids.length]);
    const textMask = new ort.Tensor("float32", new Float32Array(ids.length).fill(1), [1, 1, ids.length]);

    signal?.throwIfAborted();
    const dp = await durationPredictor.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const duration = Number((dp.duration.data as Float32Array)[0]) / speed;

    signal?.throwIfAborted();
    const enc = await textEncoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
    const textEmb = enc.text_emb;

    const { channels, frames, wavSamples } = latentShape(duration, cfg);
    let xt = sampleNoisyLatent(channels, frames);
    const latentMask = new ort.Tensor("float32", new Float32Array(frames).fill(1), [1, 1, frames]);
    const totalStepTensor = new ort.Tensor("float32", new Float32Array([totalStep]), [1]);

    for (let step = 0; step < totalStep; step++) {
      signal?.throwIfAborted();
      const out = await vectorEstimator.run({
        noisy_latent: new ort.Tensor("float32", xt, [1, channels, frames]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor("float32", new Float32Array([step]), [1]),
        total_step: totalStepTensor,
      });
      xt = out.denoised_latent.data as Float32Array;
    }

    signal?.throwIfAborted();
    const voc = await vocoder.run({ latent: new ort.Tensor("float32", xt, [1, channels, frames]) });
    const wav = voc.wav_tts.data as Float32Array;
    const speechSamples = Math.min(wav.length, wavSamples);
    const pcm = new Float32Array(speechSamples + Math.round(trailingPauseSeconds(normalized) * cfg.sampleRate));
    pcm.set(levelSpeech(wav.slice(0, speechSamples)));
    signal?.throwIfAborted();
    return pcm;
  };

  return {
    id: "supertonic-3",
    sampleRate: cfg.sampleRate,
    voices: SUPERTONIC_VOICES,
    backend: deps.backend,
    async *stream(request: TtsRequest, signal?: AbortSignal) {
      const pcm = await synthesize(request, signal);
      if (pcm.length) yield pcm;
    },
    async dispose() {
      styles.clear();
      await Promise.all(sessions.map((s) => s.release()));
    },
  };
}
