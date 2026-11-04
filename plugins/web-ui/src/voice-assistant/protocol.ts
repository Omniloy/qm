export const VOICE_LANGUAGES = ["es", "en"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export type VoiceState = "off" | "arming" | "sleeping" | "listening" | "thinking" | "speaking";
export type MicrophoneHealth = "live" | "silent" | "lost" | "blocked";

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
export const WAKE_SEGMENT_MAX_MS = 5_000;
export const WAKE_MAX_NEW_TOKENS = 32;
export const UTTERANCE_MAX_NEW_TOKENS = 200;
export const IDLE_TO_SLEEP_MS = 8_000;
export const PTT_MAX_MS = 30_000;

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

export type SpeechMode = "paused" | "sleeping" | "awake" | "held";
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
      asrEngine: AsrEngineId;
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
  | { type: "speech-misfire"; silent?: true }
  | { type: "speech-end"; segmentId: number; durationMs: number; purpose: SpeechPurpose }
  | {
      type: "transcript";
      segmentId: number;
      purpose: SpeechPurpose;
      text: string;
      language: VoiceLanguage;
      ms: number;
      truncated?: boolean;
      failed?: true;
    }
  | { type: "error"; stage: "vad" | "asr" | "frames"; reason: string; fatal: boolean };

export const TTS_ENGINE_IDS = ["phonon-40m", "supertonic-3"] as const;
export type TtsEngineId = (typeof TTS_ENGINE_IDS)[number];

export const ASR_ENGINE_IDS = ["phonon-2.5", "qwen3-asr-0.6b"] as const;
export type AsrEngineId = (typeof ASR_ENGINE_IDS)[number];

export const VOICE_GENDERS = ["female", "male"] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];

export const VOICE_LOCALES = ["es-ES", "es-MX", "en-US", "en-GB"] as const;
export type VoiceLocale = (typeof VOICE_LOCALES)[number];

export interface TtsVoice {
  readonly engine: TtsEngineId;
  readonly id: string;
  readonly name: string;
  readonly gender: VoiceGender;
  readonly languages: readonly VoiceLanguage[];
  readonly locale: VoiceLocale | null;
  readonly labels: Readonly<Record<VoiceLanguage, string>>;
}

export interface VoiceChoice {
  id: string;
  label: string;
  gender: VoiceGender;
  locale?: VoiceLocale;
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
  stream(request: TtsRequest, signal?: AbortSignal): AsyncIterable<Float32Array>;
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
  | { type: "pcm"; utteranceId: string; chunkIndex: number; pcm: Float32Array; sampleRate: number }
  | { type: "chunk-end"; utteranceId: string; chunkIndex: number; samples: number }
  | { type: "error"; utteranceId?: string; chunkIndex?: number; reason: string; fatal: boolean };

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
  gated?: true;
}

export const MODEL_PROXY_PREFIX = "/api/voice/models/";

export function modelFileKey(file: Pick<ModelFile, "repo" | "revision" | "path">): string {
  return `${file.repo}@${file.revision}/${file.path}`;
}

export function unavailableModelKey(message: string): string | null {
  return /^model_download_failed:(.+):503$/.exec(message)?.[1] ?? null;
}

export interface ModelProgress {
  key: string;
  loaded: number;
  total: number;
}

export type VoiceReplyPurpose = "reply" | "announce" | "review";

type VoiceToolName =
  | "delegate_task"
  | "check_tasks"
  | "task_result"
  | "approve_task"
  | "reject_task"
  | "stop_task"
  | "open_task"
  | "set_language"
  | "set_voice"
  | "send_task_message"
  | "ask_user";

interface VoiceToolArgs {
  delegate_task: { instruction: string; title: string };
  check_tasks: Record<string, never>;
  task_result: { taskRef: string; from?: number };
  approve_task: { taskRef: string };
  reject_task: { taskRef: string };
  stop_task: { taskRef: string };
  open_task: { taskRef: string };
  set_language: { language: VoiceLanguage };
  set_voice: { voice?: string; gender?: VoiceGender; next?: true };
  send_task_message: { taskRef: string; text: string; when: "now" | "after_run" };
  ask_user: { question: string };
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
  state: "working" | "awaiting_approval" | "held" | "idle";
}

export const VOICE_MAX_MESSAGES = 32;
export const VOICE_MAX_CONTENT_CHARS = 4_000;
const VOICE_RESULT_CHARS = 2_500;
const RESULT_TAIL_CHARS = 1_000;
const OMITTED_MARK = "\n\n[…]\n\n";

export function resultExcerpt(text: string): { omittedChars?: number; omittedFrom?: number; result: string } {
  if (text.length <= VOICE_RESULT_CHARS + OMITTED_MARK.length) return { result: text };
  const head = text.slice(0, VOICE_RESULT_CHARS - RESULT_TAIL_CHARS);
  const tail = text.slice(-RESULT_TAIL_CHARS);
  return {
    omittedChars: text.length - head.length - tail.length,
    omittedFrom: head.length,
    result: `${head}${OMITTED_MARK}${tail}`.toWellFormed(),
  };
}

export function resultPart(text: string, from: number): { from: number; nextFrom?: number; result: string } {
  const start = Math.min(from, text.length);
  const end = start + VOICE_RESULT_CHARS;
  return {
    from: start,
    ...(end < text.length ? { nextFrom: end } : {}),
    result: text.slice(start, end).toWellFormed(),
  };
}
export const VOICE_MAX_RUNNING_TASKS = 20;
export const VOICE_MAX_TOOL_HOPS = 3;
export const VOICE_MAX_FOLLOWUPS_PER_TASK = 3;

export interface VoiceReplyRequest {
  purpose: VoiceReplyPurpose;
  entry?: string;
  language: VoiceLanguage;
  messages: VoiceMessage[];
  tools: boolean;
  context?: { runningTasks: VoiceTaskSummary[]; voices?: VoiceChoice[]; voice?: string; timezone?: string };
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

export const VOICE_ACTIVITY_KINDS = [
  "task_created",
  "message_sent",
  "conversations_read",
  "memory_saved",
  "memory_compacted",
  "approved",
  "allowed",
  "kept_blocked",
] as const;
export type VoiceActivityKind = (typeof VOICE_ACTIVITY_KINDS)[number];

export interface VoiceActivity {
  kind: VoiceActivityKind;
  title?: string;
  taskRef?: string;
  count?: number;
}

export const VOICE_MAX_ACTIVITY = 8;

export type VoiceReplyFrame =
  | { type: "delta"; text: string }
  | { type: "text_end" }
  | ({ type: "tool_call" } & VoiceToolCall)
  | { type: "written"; id: string; markdown: string }
  | { type: "activity"; activity: VoiceActivity }
  | { type: "done"; usage?: VoiceReplyUsage; model?: string }
  | { type: "error"; reason: VoiceReplyErrorReason };

export const VOICE_PERMISSION = "voiceAssistant";

export const ANNOUNCE_SCOPES = ["all", "voice"] as const;
export type AnnounceScope = (typeof ANNOUNCE_SCOPES)[number];

export const MIC_MODES = ["open", "push", "off"] as const;
export type MicMode = (typeof MIC_MODES)[number];

export const PTT_STYLES = ["hold", "toggle"] as const;
export type PttStyle = (typeof PTT_STYLES)[number];

export const WAKE_PHRASE_MAX_CHARS = 60;

export interface VoicePreferences {
  enabled: boolean;
  language: VoiceLanguage;
  voice: string;
  micMode: MicMode;
}

export interface VoiceOrgConfig {
  ttsEngine: TtsEngineId;
  asrEngine: AsrEngineId;
  wakePhrase: string;
  pttStyle: PttStyle;
  announceScope: AnnounceScope;
}

export type VoiceSettings = VoicePreferences & VoiceOrgConfig;

export const DEFAULT_VOICE_PREFERENCES: Readonly<VoicePreferences> = {
  enabled: false,
  language: "es",
  voice: "rmLBOdHrfkFym9MM",
  micMode: "open",
};

export const DEFAULT_VOICE_ORG_CONFIG: Readonly<VoiceOrgConfig> = {
  ttsEngine: "phonon-40m",
  asrEngine: "phonon-2.5",
  wakePhrase: "Oye Omni",
  pttStyle: "hold",
  announceScope: "all",
};

export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings> = {
  ...DEFAULT_VOICE_PREFERENCES,
  ...DEFAULT_VOICE_ORG_CONFIG,
};

export interface VoiceAccess {
  gatedModels: boolean;
  config: VoiceOrgConfig;
}

export const VOICE_SETTINGS_UI_STATE_KEY = "voice-assistant";
export const VOICE_MUTED_STORAGE_KEY = "web-ui:voice-muted";
export const VOICE_CHANNEL_NAME = "qm-voice";

export interface VoiceCaptions {
  user: { text: string; final: boolean } | null;
  agent: { text: string; spokenChars: number } | null;
}

export interface VoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  activity?: readonly VoiceActivity[];
}

export interface VoiceWork {
  text: string;
  taskRef: string | null;
  busy: boolean;
}

export interface VoiceStageView {
  state: VoiceState;
  language: VoiceLanguage;
  voice: string;
  voices: readonly VoiceChoice[];
  micMode: MicMode;
  pttStyle: PttStyle;
  pttActive: boolean;
  muted: boolean;
  status: string;
  captions: VoiceCaptions;
  transcript: readonly VoiceTranscriptEntry[];
  awaitingUser: boolean;
  announcement: string;
  work: VoiceWork | null;
}

export interface VoiceStageHandlers {
  onOrbPress(): void;
  onToggleMute(): void;
  onTypeInstead(text: string): void;
  onLanguage(language: VoiceLanguage): void;
  onVoice(voice: string): void;
  onMicMode(mode: MicMode): void;
  onPttDown(): void;
  onPttUp(): void;
  onOpenTask(taskRef: string): void;
  onOpenActivity(activity: VoiceActivity): void;
  onOpen(): void;
  onClose(): void;
}
