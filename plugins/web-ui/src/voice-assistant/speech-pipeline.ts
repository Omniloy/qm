import { errMessage } from "../../../chassis/src/errors.ts";
import {
  SPEECH_SAMPLE_RATE,
  UTTERANCE_MAX_NEW_TOKENS,
  WAKE_MAX_NEW_TOKENS,
  WAKE_SEGMENT_MAX_MS,
  type AsrRequest,
  type AsrResult,
  type SpeechMode,
  type SpeechPurpose,
  type SpeechWorkerOut,
  type VadOptions,
  type VoiceLanguage,
} from "./protocol.ts";

export const VAD_EVENT = {
  speechRealStart: "SPEECH_REAL_START",
  misfire: "VAD_MISFIRE",
  speechEnd: "SPEECH_END",
} as const;

interface VadEvent {
  msg: string;
  audio?: Float32Array;
}

interface FrameVad {
  process(frame: Float32Array, handle: (event: VadEvent) => void): Promise<void>;
  endSegment(handle: (event: VadEvent) => void): unknown;
  setOptions(update: Partial<VadOptions>): void;
  reset(): void;
  resume(): void;
}

export interface SpeechPipelineDeps {
  vad: FrameVad;
  transcribe(audio: Float32Array, request: AsrRequest): Promise<AsrResult>;
  post(message: SpeechWorkerOut): void;
  language: VoiceLanguage;
  mode?: SpeechMode;
  now?(): number;
}

export interface SpeechPipeline {
  frame(frame: Float32Array): void;
  setMode(mode: SpeechMode): void;
  configure(update: { language?: VoiceLanguage; vad?: Partial<VadOptions> }): void;
  endSegment(): void;
  retranscribe(segmentId: number): void;
  settled(): Promise<void>;
}

const SENTENCE_END = /[.?!…。？！]["»”)]*$/u;

const WAKE_SEGMENT_SAMPLES = (WAKE_SEGMENT_MAX_MS * SPEECH_SAMPLE_RATE) / 1000;

function wakeSegment(audio: Float32Array): Float32Array {
  return audio.length > WAKE_SEGMENT_SAMPLES ? audio.subarray(0, WAKE_SEGMENT_SAMPLES) : audio;
}

export function createSpeechPipeline(deps: SpeechPipelineDeps): SpeechPipeline {
  const { vad, post } = deps;
  const now = deps.now ?? (() => performance.now());
  let mode: SpeechMode = deps.mode ?? "paused";
  let language = deps.language;
  let segmentId = 0;
  let vadFailing = false;
  let frames: Promise<void> = Promise.resolve();
  let transcriptions: Promise<void> = Promise.resolve();
  let lastWake: { id: number; audio: Float32Array } | null = null;

  const transcribe = (id: number, purpose: SpeechPurpose, audio: Float32Array) => {
    const request: AsrRequest = {
      language,
      maxNewTokens: purpose === "wake" ? WAKE_MAX_NEW_TOKENS : UTTERANCE_MAX_NEW_TOKENS,
    };
    const input = purpose === "wake" ? wakeSegment(audio) : audio;
    transcriptions = transcriptions.then(async () => {
      const started = now();
      try {
        const result = await deps.transcribe(input, request);
        const text = result.text.trim();
        const truncated =
          input.length < audio.length || (result.tokens >= request.maxNewTokens && !SENTENCE_END.test(text));
        post({
          type: "transcript",
          segmentId: id,
          purpose,
          text,
          language: request.language,
          ms: Math.round(now() - started),
          ...(purpose === "wake" && truncated ? { truncated: true } : {}),
        });
      } catch (error) {
        post({ type: "error", stage: "asr", reason: errMessage(error), fatal: false });
        post({ type: "transcript", segmentId: id, purpose, text: "", language: request.language, ms: 0 });
      }
    });
  };

  const handle = (event: VadEvent) => {
    if (mode === "paused") return;
    if (event.msg === VAD_EVENT.speechRealStart) post({ type: "speech-start" });
    else if (event.msg === VAD_EVENT.misfire) post({ type: "speech-misfire" });
    else if (event.msg === VAD_EVENT.speechEnd && event.audio) {
      const purpose: SpeechPurpose = mode === "sleeping" ? "wake" : "utterance";
      const id = ++segmentId;
      const durationMs = Math.round((event.audio.length * 1000) / SPEECH_SAMPLE_RATE);
      post({ type: "speech-end", segmentId: id, durationMs, purpose });
      if (purpose === "wake") lastWake = { id, audio: event.audio };
      transcribe(id, purpose, event.audio);
    }
  };

  const enqueue = (step: () => Promise<void> | void) => {
    frames = frames.then(async () => {
      try {
        await step();
        vadFailing = false;
      } catch (error) {
        if (!vadFailing) post({ type: "error", stage: "vad", reason: errMessage(error), fatal: false });
        vadFailing = true;
      }
    });
  };

  vad.resume();

  return {
    frame(frame) {
      if (mode === "paused") return;
      enqueue(() => (mode === "paused" ? undefined : vad.process(frame, handle)));
    },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      if (next === "paused") enqueue(() => vad.reset());
    },
    configure(update) {
      if (update.language) language = update.language;
      if (update.vad) {
        const options = update.vad;
        enqueue(() => vad.setOptions(options));
      }
    },
    endSegment() {
      enqueue(() => {
        vad.endSegment(handle);
      });
    },
    retranscribe(id) {
      const audio = lastWake?.id === id ? lastWake.audio : new Float32Array(0);
      lastWake = null;
      transcribe(id, "utterance", audio);
    },
    async settled() {
      let pending: [Promise<void>, Promise<void>] | null = null;
      while (!pending || pending[0] !== frames || pending[1] !== transcriptions) {
        pending = [frames, transcriptions];
        await Promise.all(pending);
      }
    },
  };
}
