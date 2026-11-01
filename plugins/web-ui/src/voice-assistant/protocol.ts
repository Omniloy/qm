export const VOICE_LANGUAGES = ["es", "en"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export type VoiceState = "off" | "arming" | "sleeping" | "listening" | "thinking" | "speaking";

export type OrbStatus = "idle" | "connecting" | "connected" | "ending" | "error";
export type OrbMode = "idle" | "listening" | "thinking" | "speaking";

export interface OrbInputs {
  status: OrbStatus;
  mode: OrbMode;
  muted: boolean;
}

export const ORB_INPUTS_BY_STATE: Readonly<Record<VoiceState, Readonly<Omit<OrbInputs, "muted">>>> = {
  off: { status: "idle", mode: "idle" },
  arming: { status: "connecting", mode: "idle" },
  sleeping: { status: "connected", mode: "idle" },
  listening: { status: "connected", mode: "listening" },
  thinking: { status: "connected", mode: "thinking" },
  speaking: { status: "connected", mode: "speaking" },
};

export const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_FRAME_SAMPLES = 512;
export const SPEECH_FRAME_MS = 32;
export const WAKE_SEGMENT_MAX_MS = 2_500;
export const WAKE_MAX_NEW_TOKENS = 10;
export const UTTERANCE_MAX_NEW_TOKENS = 200;
export const IDLE_TO_SLEEP_MS = 8_000;

export const CAPTURE_PROCESSOR = "qm-voice-capture";
export const PLAYBACK_PROCESSOR = "qm-voice-playback";

export type LevelChannel = "input" | "output";

export interface LevelSource {
  level(): number;
}

export interface LevelBus {
  read(channel: LevelChannel): number;
  attach(channel: LevelChannel, source: LevelSource | null): void;
}

export interface VadOptions {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
  submitUserSpeechOnPause: boolean;
}

export const DEFAULT_VAD_OPTIONS: Readonly<VadOptions> = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionMs: 550,
  preSpeechPadMs: 400,
  minSpeechMs: 250,
  submitUserSpeechOnPause: true,
};

type TransferablePort = (typeof globalThis)["MessagePort"]["prototype"];

export type CaptureWorkletIn = { type: "attach"; port: TransferablePort } | { type: "detach" };

export interface CaptureProcessorOptions {
  targetSampleRate: number;
  frameSamples: number;
}

export type PlaybackWorkletIn =
  | { type: "push"; utteranceId: string; pcm: Float32Array; sampleRate: number }
  | { type: "end"; utteranceId: string }
  | { type: "flush" };

export type PlaybackWorkletOut =
  | { type: "progress"; utteranceId: string; playedSamples: number; sampleRate: number }
  | { type: "drained"; utteranceId: string }
  | { type: "flushed" };

export type SpeechMode = "paused" | "sleeping" | "awake";
export type SpeechPurpose = "wake" | "utterance";
export type ExecutionBackend = "webgpu" | "wasm";

export const ASR_VARIANTS = ["q4f16", "q4"] as const;
export type AsrVariant = (typeof ASR_VARIANTS)[number];

export interface GpuSupport {
  webgpu: boolean;
  shaderF16: boolean;
}

export type SpeechWorkerIn =
  | {
      type: "init";
      framePort: TransferablePort;
      asrVariant: AsrVariant;
      asrFiles: readonly ModelFile[];
      language: VoiceLanguage;
      vad: VadOptions;
    }
  | { type: "mode"; mode: SpeechMode }
  | { type: "config"; language?: VoiceLanguage; vad?: Partial<VadOptions> }
  | { type: "end-segment" }
  | { type: "retranscribe"; segmentId: number }
  | { type: "dispose" };

export type SpeechWorkerOut =
  | { type: "loading"; stage: "vad" | "asr" | "warmup" }
  | { type: "ready"; backend: ExecutionBackend; asrVariant: AsrVariant }
  | { type: "speech-start" }
  | { type: "speech-misfire" }
  | { type: "speech-end"; segmentId: number; durationMs: number; purpose: SpeechPurpose }
  | {
      type: "transcript";
      segmentId: number;
      purpose: SpeechPurpose;
      text: string;
      language: VoiceLanguage;
      ms: number;
      truncated?: boolean;
    }
  | { type: "error"; stage: "vad" | "asr" | "frames"; reason: string; fatal: boolean };

export const TTS_ENGINE_IDS = ["supertonic-3"] as const;
export type TtsEngineId = (typeof TTS_ENGINE_IDS)[number];

export const VOICE_GENDERS = ["female", "male"] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];

export interface TtsVoice {
  readonly id: string;
  readonly gender: VoiceGender;
  readonly languages: readonly VoiceLanguage[];
  readonly labels: Readonly<Record<VoiceLanguage, string>>;
}

export interface VoiceChoice {
  id: string;
  label: string;
  gender: VoiceGender;
}

export interface TtsRequest {
  text: string;
  language: VoiceLanguage;
  voice: string;
  steps: number;
  speed?: number;
}

export interface TtsEngine {
  readonly id: TtsEngineId;
  readonly sampleRate: number;
  readonly voices: readonly TtsVoice[];
  readonly backend: ExecutionBackend;
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<Float32Array>;
  dispose(): Promise<void>;
}

export type TtsWorkerIn =
  | {
      type: "init";
      engine: TtsEngineId;
      files: readonly ModelFile[];
      backend: ExecutionBackend;
    }
  | {
      type: "speak";
      utteranceId: string;
      chunkIndex: number;
      text: string;
      language: VoiceLanguage;
      voice: string;
      steps: number;
    }
  | { type: "cancel"; utteranceId?: string }
  | { type: "dispose" };

export type TtsWorkerOut =
  | { type: "ready"; engine: TtsEngineId; backend: ExecutionBackend; sampleRate: number }
  | { type: "pcm"; utteranceId: string; chunkIndex: number; pcm: Float32Array; sampleRate: number; chars: number }
  | { type: "error"; utteranceId?: string; chunkIndex?: number; reason: string; fatal: boolean };

type AsrEngineId = "qwen3-asr-0.6b";

export interface AsrRequest {
  language: VoiceLanguage;
  maxNewTokens: number;
}

export interface AsrResult {
  text: string;
  tokens: number;
  audioMs: number;
  encodeMs: number;
  decodeMs: number;
}

export interface AsrEngine {
  readonly id: AsrEngineId;
  readonly variant: AsrVariant;
  readonly backend: ExecutionBackend;
  transcribe(audio: Float32Array, request: AsrRequest, signal?: AbortSignal): Promise<AsrResult>;
  dispose(): Promise<void>;
}

type ModelRole = "asr" | "tts";

export interface ModelFile {
  repo: string;
  revision: string;
  path: string;
  bytes: number;
  sha256: string;
  role: ModelRole;
  variant?: AsrVariant;
}

export const MODEL_PROXY_PREFIX = "/api/voice/models/";

export function modelFileKey(file: Pick<ModelFile, "repo" | "revision" | "path">): string {
  return `${file.repo}@${file.revision}/${file.path}`;
}

export interface ModelProgress {
  key: string;
  loaded: number;
  total: number;
}

type VoiceReplyPurpose = "reply" | "announce";

export type VoiceToolName =
  | "delegate_task"
  | "check_tasks"
  | "task_result"
  | "approve_task"
  | "reject_task"
  | "stop_task"
  | "open_task"
  | "set_language"
  | "set_voice";

interface VoiceToolArgs {
  delegate_task: { instruction: string; title: string };
  check_tasks: Record<string, never>;
  task_result: { taskRef: string };
  approve_task: { taskRef: string };
  reject_task: { taskRef: string };
  stop_task: { taskRef: string };
  open_task: { taskRef: string };
  set_language: { language: VoiceLanguage };
  set_voice: { voice?: string; gender?: VoiceGender; next?: true };
}

export type VoiceToolCall = {
  [K in VoiceToolName]: { id: string; name: K; args: VoiceToolArgs[K] };
}[VoiceToolName];

export type VoiceMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: VoiceToolCall[] }
  | { role: "tool"; toolCallId: string; name: VoiceToolName; content: string; isError?: boolean };

export interface VoiceTaskSummary {
  taskRef: string;
  title: string;
  state: "working" | "awaiting_approval" | "idle";
}

export const VOICE_MAX_MESSAGES = 32;
export const VOICE_MAX_CONTENT_CHARS = 4_000;
export const VOICE_MAX_RUNNING_TASKS = 20;
export const VOICE_MAX_TOOL_HOPS = 3;

export interface VoiceReplyRequest {
  purpose: VoiceReplyPurpose;
  language: VoiceLanguage;
  messages: VoiceMessage[];
  tools: boolean;
  context?: { runningTasks: VoiceTaskSummary[]; voices?: VoiceChoice[]; voice?: string };
}

export type VoiceReplyErrorReason =
  | "feature_disabled"
  | "voice_model_unsupported"
  | "invalid_request"
  | "over_budget"
  | "rate_limited"
  | "upstream_error"
  | "aborted";

interface VoiceReplyUsage {
  input: number;
  output: number;
}

export type VoiceReplyFrame =
  | { type: "delta"; text: string }
  | ({ type: "tool_call" } & VoiceToolCall)
  | { type: "done"; usage?: VoiceReplyUsage; model?: string }
  | { type: "error"; reason: VoiceReplyErrorReason };

export const VOICE_PERMISSION = "voiceAssistant";

export const ANNOUNCE_SCOPES = ["all", "voice"] as const;
export type AnnounceScope = (typeof ANNOUNCE_SCOPES)[number];

export interface VoiceSettings {
  enabled: boolean;
  wakePhrase: string;
  language: VoiceLanguage;
  announceScope: AnnounceScope;
  voice: string;
  ttsEngine: TtsEngineId;
}

export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings> = {
  enabled: false,
  wakePhrase: "Oye Omni",
  language: "es",
  announceScope: "all",
  voice: "F1",
  ttsEngine: "supertonic-3",
};

export const VOICE_SETTINGS_UI_STATE_KEY = "voice-assistant";
export const VOICE_MUTED_STORAGE_KEY = "web-ui:voice-muted";
export const VOICE_CHANNEL_NAME = "qm-voice";

export interface VoiceCaptions {
  user: { text: string; final: boolean } | null;
  agent: { text: string; spokenChars: number } | null;
}

export interface VoiceStageView {
  state: VoiceState;
  language: VoiceLanguage;
  voice: string;
  voices: readonly VoiceChoice[];
  muted: boolean;
  status: string;
  captions: VoiceCaptions;
  announcement: string;
}

export interface VoiceStageHandlers {
  onOrbPress(): void;
  onToggleMute(): void;
  onTypeInstead(text: string): void;
  onLanguage(language: VoiceLanguage): void;
  onVoice(voice: string): void;
  onClose(): void;
}
