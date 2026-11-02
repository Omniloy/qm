import type { ChimeKind } from "./audio/chimes.ts";
import type { ReviewOutcome, TaskUpdate } from "./announcer.ts";
import { VoiceReplyError } from "./llm.ts";
import {
  DEFAULT_VAD_OPTIONS,
  IDLE_TO_SLEEP_MS,
  VOICE_MAX_CONTENT_CHARS,
  VOICE_MAX_MESSAGES,
  VOICE_MAX_TOOL_HOPS,
  type PlaybackWorkletIn,
  type PttStyle,
  type PlaybackWorkletOut,
  type SpeechMode,
  type SpeechWorkerIn,
  type SpeechWorkerOut,
  type TtsWorkerIn,
  type TtsWorkerOut,
  type VadOptions,
  type VoiceCaptions,
  type VoiceLanguage,
  type VoiceMessage,
  type VoiceReplyErrorReason,
  type VoiceReplyFrame,
  type VoiceReplyPurpose,
  type VoiceReplyRequest,
  type VoiceSettings,
  type VoiceStageView,
  type VoiceState,
  type VoiceTaskSummary,
  type VoiceToolCall,
  type VoiceTranscriptEntry,
} from "./protocol.ts";
import { createTextChunker, stepsForChunk, withoutClosingPunctuation, type TextChunker } from "./text-chunker.ts";
import type { VoiceConfirmation, VoiceToolOutcome } from "./tools.ts";
import { pickerVoices } from "./voice-picker.ts";
import { voiceChoices } from "./voices.ts";
import { confirmationAnswer, matchWake } from "./wake.ts";

export interface Port<In, Out> {
  post(message: In, transfer?: Transferable[]): void;
  listen(handler: (message: Out) => void): () => void;
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface VoiceControllerDeps {
  speech: Port<SpeechWorkerIn, SpeechWorkerOut>;
  tts: Port<TtsWorkerIn, TtsWorkerOut>;
  playback: Port<PlaybackWorkletIn, PlaybackWorkletOut>;
  settings(): VoiceSettings;
  reply(request: VoiceReplyRequest, signal: AbortSignal): AsyncIterable<VoiceReplyFrame>;
  persist(entries: readonly VoiceTranscriptNote[]): Promise<void>;
  runTool(call: VoiceToolCall): Promise<VoiceToolOutcome>;
  runningTasks(): VoiceTaskSummary[];
  chime(kind: ChimeKind): void;
  setMuted(muted: boolean): void;
  render(view: VoiceStageView): void;
  onFatal(message: string, stage?: "asr" | "tts"): void;
  onMutedChange?(muted: boolean): void;
  muted?: boolean;
  transcript?: readonly VoiceTranscriptEntry[];
  now?(): number;
  timers?: Timers;
}

export interface VoiceController {
  readonly state: VoiceState;
  readonly muted: boolean;
  press(): void;
  pttDown(): void;
  pttUp(): void;
  pttToggle(): void;
  toggleMute(): void;
  type(text: string): void;
  announce(text: string): void;
  review(update: TaskUpdate): Promise<ReviewOutcome>;
  readonly transcript: readonly VoiceTranscriptEntry[];
  setTranscript(entries: readonly VoiceTranscriptEntry[]): void;
  setStatus(text: string): void;
  applySettings(): void;
  dispose(): void;
}

export const ANNOUNCE_QUIET_MS = 1_500;
export const THINKING_CHIME_MS = 2_500;
export const PTT_MIN_MS = 250;

const TRANSCRIPT_LIMIT = 100;
const TASK_UPDATE_DETAIL_CHARS = 2_500;
export const TASK_UPDATE_MARKER = "<task_update/>";

export type VoiceTranscriptNote = Pick<VoiceTranscriptEntry, "role" | "text">;

let entrySeq = 0;
let reviewSeq = 0;

export const SPEAKING_VAD: Partial<VadOptions> = { positiveSpeechThreshold: 0.75, negativeSpeechThreshold: 0.6 };
const RESTING_VAD: Partial<VadOptions> = {
  positiveSpeechThreshold: DEFAULT_VAD_OPTIONS.positiveSpeechThreshold,
  negativeSpeechThreshold: DEFAULT_VAD_OPTIONS.negativeSpeechThreshold,
};

function confirmationSubject(c: VoiceConfirmation): string {
  return [c.title, c.summary ?? ""].map(withoutClosingPunctuation).filter(Boolean).join(": ");
}

const COPY = {
  es: {
    loadingVad: "Cargando el detector de voz",
    loadingAsr: "Cargando el reconocimiento de voz",
    warmup: "Preparando el asistente",
    downloading: (percent: number) => `Descargando modelos ${percent}%`,
    storage: "No hay espacio suficiente para los modelos de voz.",
    muted: "Micrófono apagado",
    wakeHint: (phrase: string) => `Di «${phrase}»`,
    pttHint: {
      hold: "Mantén pulsada la barra espaciadora o el orbe para hablar",
      toggle: "Pulsa la barra espaciadora o el orbe para hablar, y otra vez para enviar",
    } satisfies Record<PttStyle, string>,
    typeHint: "Escribe para hablar con Omni",
    answerHint: "Te escucho: responde cuando quieras",
    pttAnswerHint: {
      hold: "Mantén pulsado para responder",
      toggle: "Pulsa para responder",
    } satisfies Record<PttStyle, string>,
    typeAnswerHint: "Escribe tu respuesta",
    webgpu: "Este navegador no admite WebGPU, que el asistente de voz necesita.",
    fatal: "No se ha podido iniciar el asistente de voz.",
    voiceTts: "No se ha podido cargar la voz.",
    confirm: (c: VoiceConfirmation) =>
      `${confirmationSubject(c)}. ¿${c.approved ? "Lo apruebo" : "Lo rechazo"}? Di sí o no.`,
    approved: "Aprobado.",
    rejected: "Rechazado.",
    declined: "Vale, no hago nada.",
    confirmFailed: "No he podido hacerlo. Ábrela en pantalla.",
    errors: {
      feature_disabled: "El asistente de voz no está activado para tu cuenta.",
      voice_model_unsupported: "Tu modelo no admite el asistente de voz.",
      over_budget: "Has alcanzado el límite de gasto.",
      rate_limited: "Demasiadas peticiones seguidas. Espera un momento.",
      invalid_request: "No he podido procesar eso.",
      upstream_error: "No he podido responder. Inténtalo de nuevo.",
      aborted: "No he podido responder. Inténtalo de nuevo.",
    } satisfies Record<VoiceReplyErrorReason, string>,
  },
  en: {
    loadingVad: "Loading the voice detector",
    loadingAsr: "Loading speech recognition",
    warmup: "Getting the assistant ready",
    downloading: (percent: number) => `Downloading models ${percent}%`,
    storage: "There is not enough storage for the voice models.",
    muted: "Microphone off",
    wakeHint: (phrase: string) => `Say “${phrase}”`,
    pttHint: {
      hold: "Hold Space or the orb to talk",
      toggle: "Press Space or the orb to talk, and again to send",
    } satisfies Record<PttStyle, string>,
    typeHint: "Type to talk to Omni",
    answerHint: "Listening: answer whenever you're ready",
    pttAnswerHint: {
      hold: "Hold to answer",
      toggle: "Press to answer",
    } satisfies Record<PttStyle, string>,
    typeAnswerHint: "Type your answer",
    webgpu: "This browser does not support WebGPU, which the voice assistant needs.",
    fatal: "The voice assistant could not start.",
    voiceTts: "The voice could not be loaded.",
    confirm: (c: VoiceConfirmation) =>
      `${confirmationSubject(c)}. ${c.approved ? "Approve it" : "Reject it"}? Say yes or no.`,
    approved: "Approved.",
    rejected: "Rejected.",
    declined: "Okay, I won't do anything.",
    confirmFailed: "I could not do that. Open the task on screen.",
    errors: {
      feature_disabled: "The voice assistant is not turned on for your account.",
      voice_model_unsupported: "Your model does not support the voice assistant.",
      over_budget: "You have reached your spending limit.",
      rate_limited: "Too many requests in a row. Please wait a moment.",
      invalid_request: "I could not process that.",
      upstream_error: "I could not answer. Please try again.",
      aborted: "I could not answer. Please try again.",
    } satisfies Record<VoiceReplyErrorReason, string>,
  },
} as const;

export function voiceCopy(language: VoiceLanguage): (typeof COPY)[VoiceLanguage] {
  return COPY[language];
}

interface Span {
  start: number;
  end: number;
  samples: number;
}

interface Utterance {
  id: string;
  chunker: TextChunker;
  text: string;
  cursor: number;
  nextChunk: number;
  pending: number;
  spans: Span[];
  received: boolean;
  llmDone: boolean;
  ended: boolean;
  played: number;
  resume: VoiceState;
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function clip(text: string): string {
  return text.length > VOICE_MAX_CONTENT_CHARS ? text.slice(0, VOICE_MAX_CONTENT_CHARS) : text;
}

export function windowMessages(history: readonly VoiceMessage[]): VoiceMessage[] {
  const recent = history.slice(-VOICE_MAX_MESSAGES);
  const first = recent.findIndex((message) => message.role === "user");
  return first < 0 ? [] : recent.slice(first);
}

export function spokenChars(spans: readonly Span[], played: number): number {
  let consumed = 0;
  let spoken = 0;
  for (const span of spans) {
    if (span.samples <= 0) break;
    if (played >= consumed + span.samples) {
      spoken = span.end;
      consumed += span.samples;
      continue;
    }
    if (played <= consumed) return spoken;
    const fraction = (played - consumed) / span.samples;
    return Math.round(span.start + fraction * (span.end - span.start));
  }
  return spoken;
}

function refused(error: string): VoiceToolOutcome {
  return { content: JSON.stringify({ ok: false, error }), isError: true };
}

const INTERRUPTED: VoiceToolOutcome = {
  content: JSON.stringify({ ok: false, error: "interrupted", started: "unknown" }),
  isError: true,
};

export function taskUpdateMessages(update: TaskUpdate, callId: string): VoiceMessage[] {
  const result = {
    ok: true,
    taskRef: update.taskRef,
    title: update.title,
    state: update.kind === "approval" ? "awaiting_approval" : "idle",
    failed: update.kind === "failed",
    result: update.detail.slice(0, TASK_UPDATE_DETAIL_CHARS),
  };
  return [
    { role: "user", content: TASK_UPDATE_MARKER },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: "task_result", args: { taskRef: update.taskRef } }],
    },
    { role: "tool", toolCallId: callId, name: "task_result", content: clip(JSON.stringify(result)) },
  ];
}

type Queued =
  | { kind: "announce"; text: string }
  | { kind: "review"; update: TaskUpdate; settle(outcome: ReviewOutcome | Error): void };

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: unknown } | null)?.name === "AbortError";
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? (() => Date.now());
  const unlisten: Array<() => void> = [];
  const history: VoiceMessage[] = [];
  const announcements: Queued[] = [];
  const pendingSegments = new Set<number>();
  const rewoken = new Set<number>();
  const handledCalls = new Set<string>();

  let state: VoiceState = "arming";
  let muted = deps.muted === true;
  let speechReady = false;
  let ttsReady = false;
  let armingStatus = "";
  let errorStatus = "";
  let captions: VoiceCaptions = { user: null, agent: null };
  let announcement = "";
  let speechActive = false;
  let lastSpeechAt = 0;
  let idleTimer: unknown = null;
  let quietTimer: unknown = null;
  let mode: SpeechMode = "paused";
  let vadProfile: "resting" | "speaking" = "resting";
  let utterance: Utterance | null = null;
  let turn: AbortController | null = null;
  let utteranceSeq = 0;
  let disposed = false;
  let confirmation: VoiceConfirmation | null = null;
  let thinkingTimer: unknown = null;
  let pttActive = false;
  let pttConfirmed = false;
  let pttTimer: unknown = null;
  let pttAt = 0;
  let pttClosing = 0;
  let awaitingUser = false;
  let transcript: VoiceTranscriptEntry[] = [...(deps.transcript ?? [])];
  let writtenSeq = 0;

  const copy = () => COPY[deps.settings().language];
  const micMode = () => deps.settings().micMode;
  const pushMode = () => micMode() === "push";
  const micOff = () => micMode() === "off";
  const resumeState = (): VoiceState => (micMode() === "open" ? "listening" : "sleeping");
  const awaitAnswer = (target: Utterance) => {
    awaitingUser = true;
    target.resume = resumeState();
  };

  const status = (): string => {
    if (state === "arming") return armingStatus;
    if (errorStatus) return errorStatus;
    const settings = deps.settings();
    const words = copy();
    if (settings.micMode === "off") {
      if (state !== "sleeping") return "";
      return awaitingUser ? words.typeAnswerHint : words.typeHint;
    }
    if (muted) return words.muted;
    if (settings.micMode === "open" && state === "listening") return awaitingUser ? words.answerHint : "";
    if (state !== "sleeping") return "";
    if (settings.micMode === "open") return words.wakeHint(settings.wakePhrase);
    return (awaitingUser ? words.pttAnswerHint : words.pttHint)[settings.pttStyle];
  };

  const render = () => {
    if (disposed) return;
    const settings = deps.settings();
    deps.render({
      state,
      language: settings.language,
      voice: settings.voice,
      voices: pickerVoices(settings),
      micMode: settings.micMode,
      pttStyle: settings.pttStyle,
      pttActive,
      muted,
      status: status(),
      captions,
      transcript,
      awaitingUser,
      announcement,
    });
  };

  const record = (role: VoiceTranscriptEntry["role"], text: string, id?: string) => {
    transcript = [...transcript, { id: id ?? `local-${++entrySeq}`, role, text, at: now() }].slice(-TRANSCRIPT_LIMIT);
  };

  const keep = (entries: readonly VoiceTranscriptNote[]) => {
    void deps.persist(entries).catch(() => undefined);
  };

  const desiredMode = (): SpeechMode => {
    if (muted || micOff() || state === "off" || state === "arming") return "paused";
    if (pushMode()) return pttActive ? "held" : "paused";
    return state === "sleeping" || utterance?.resume === "sleeping" ? "sleeping" : "awake";
  };

  const syncMode = () => {
    const next = desiredMode();
    if (next !== mode) {
      mode = next;
      deps.speech.post({ type: "mode", mode });
    }
    const profile = state === "speaking" ? "speaking" : "resting";
    if (profile !== vadProfile && speechReady) {
      vadProfile = profile;
      deps.speech.post({ type: "config", vad: profile === "speaking" ? SPEAKING_VAD : RESTING_VAD });
    }
  };

  const clearIdle = () => {
    if (idleTimer !== null) timers.clear(idleTimer);
    idleTimer = null;
  };

  const armIdle = () => {
    clearIdle();
    if (state !== "listening" || pttActive) return;
    idleTimer = timers.set(() => {
      idleTimer = null;
      if (state === "listening" && !speechActive && pendingSegments.size === 0) setState("sleeping");
      else armIdle();
    }, IDLE_TO_SLEEP_MS);
  };

  const setState = (next: VoiceState) => {
    if (disposed) return;
    state = next;
    if (next === "sleeping") {
      errorStatus = "";
      if (micMode() === "open") {
        confirmation = null;
        awaitingUser = false;
      }
    }
    syncMode();
    if (state === "listening") armIdle();
    else clearIdle();
    render();
    drainAnnouncements();
  };

  const canAnnounce = (): boolean => {
    if (utterance || turn || speechActive || pttActive || pttClosing > 0) return false;
    if (state === "sleeping") return true;
    return state === "listening" && pendingSegments.size === 0;
  };

  function drainAnnouncements(): void {
    if (disposed || announcements.length === 0 || !canAnnounce()) return;
    const hold = awaitingUser || confirmation ? IDLE_TO_SLEEP_MS : ANNOUNCE_QUIET_MS;
    const quietFor = now() - lastSpeechAt;
    if (quietFor < hold) {
      if (quietTimer !== null) timers.clear(quietTimer);
      quietTimer = timers.set(() => {
        quietTimer = null;
        drainAnnouncements();
      }, hold - quietFor);
      return;
    }
    confirmation = null;
    awaitingUser = false;
    const item = announcements.shift() as Queued;
    if (item.kind === "review") {
      void runReview(item);
      return;
    }
    const { text } = item;
    deps.chime("announce");
    announcement = text;
    errorStatus = "";
    captions = { user: null, agent: { text: "", spokenChars: 0 } };
    history.push({ role: "assistant", content: clip(text) });
    const spoken = beginUtterance(state);
    feed(spoken, text);
    finishText(spoken);
    render();
  }

  const beginUtterance = (resume: VoiceState): Utterance => {
    const created: Utterance = {
      id: `u${++utteranceSeq}`,
      chunker: createTextChunker(),
      text: "",
      cursor: 0,
      nextChunk: 0,
      pending: 0,
      spans: [],
      received: false,
      llmDone: false,
      ended: false,
      played: 0,
      resume,
    };
    utterance = created;
    return created;
  };

  const speakChunk = (target: Utterance, chunk: string) => {
    const index = target.nextChunk++;
    const found = target.text.indexOf(chunk, target.cursor);
    const start = found >= 0 ? found : target.cursor;
    const end = Math.min(target.text.length, start + chunk.length);
    target.cursor = end;
    target.spans[index] = { start, end, samples: 0 };
    target.pending++;
    const settings = deps.settings();
    deps.tts.post({
      type: "speak",
      utteranceId: target.id,
      chunkIndex: index,
      text: chunk,
      language: settings.language,
      voice: settings.voice,
      steps: stepsForChunk(index),
    });
  };

  function feed(target: Utterance, delta: string): void {
    if (utterance !== target || !delta) return;
    target.text += delta;
    captions = { ...captions, agent: { text: target.text, spokenChars: spokenChars(target.spans, target.played) } };
    for (const chunk of target.chunker.push(delta)) speakChunk(target, chunk);
  }

  const append = (target: Utterance, text: string) =>
    feed(target, target.text && !/\s$/.test(target.text) && !/^\s/.test(text) ? ` ${text}` : text);

  const flushText = (target: Utterance) => {
    if (utterance !== target) return;
    for (const chunk of target.chunker.flush()) speakChunk(target, chunk);
  };

  function finishText(target: Utterance): void {
    flushText(target);
    target.llmDone = true;
    maybeEnd(target);
  }

  const finishUtterance = (target: Utterance) => {
    if (utterance !== target) return;
    utterance = null;
    lastSpeechAt = now();
    if (captions.agent)
      captions = { ...captions, agent: { ...captions.agent, spokenChars: captions.agent.text.length } };
    setState(target.resume);
  };

  function maybeEnd(target: Utterance): void {
    if (utterance !== target || target.ended || !target.llmDone || target.pending > 0) return;
    target.ended = true;
    if (target.received) deps.playback.post({ type: "end", utteranceId: target.id });
    else finishUtterance(target);
  }

  const clearThinking = () => {
    if (thinkingTimer !== null) timers.clear(thinkingTimer);
    thinkingTimer = null;
  };

  const armThinking = (controller: AbortController) => {
    clearThinking();
    thinkingTimer = timers.set(() => {
      thinkingTimer = null;
      if (turn === controller && state === "thinking" && !utterance?.text) deps.chime("thinking");
    }, THINKING_CHIME_MS);
  };

  const silence = () => {
    clearThinking();
    turn?.abort();
    turn = null;
    if (utterance) {
      deps.tts.post({ type: "cancel", utteranceId: utterance.id });
      deps.playback.post({ type: "flush" });
      utterance = null;
    }
  };

  const interrupt = () => {
    silence();
    setState(micOff() ? "sleeping" : "listening");
  };

  const fail = (error: unknown, spoken: Utterance) => {
    const reason = error instanceof VoiceReplyError ? error.reason : "upstream_error";
    errorStatus = copy().errors[reason];
    deps.chime("error");
    append(spoken, errorStatus);
    render();
  };

  const requestFor = (purpose: VoiceReplyPurpose): VoiceReplyRequest => {
    const settings = deps.settings();
    return {
      purpose,
      language: settings.language,
      tools: true,
      messages: windowMessages(history),
      context: { runningTasks: deps.runningTasks(), voices: voiceChoices(settings), voice: settings.voice },
    };
  };

  const settle = async (
    pending: VoiceConfirmation,
    answer: string,
    yes: boolean,
    controller: AbortController,
    spoken: Utterance,
  ) => {
    const words = copy();
    let reply: string = words.declined;
    if (yes)
      reply = (await pending.execute()).isError
        ? words.confirmFailed
        : words[pending.approved ? "approved" : "rejected"];
    if (controller.signal.aborted) {
      keep([{ role: "user", text: answer }]);
      return;
    }
    history.push({ role: "assistant", content: reply });
    record("assistant", reply);
    keep([
      { role: "user", text: answer },
      { role: "assistant", text: reply },
    ]);
    render();
    append(spoken, reply);
  };

  const recordTool = (call: VoiceToolCall, outcome: VoiceToolOutcome) => {
    history.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: clip(outcome.content),
      ...(outcome.isError ? { isError: true } : {}),
    });
  };

  const settleTool = (call: VoiceToolCall, signal: AbortSignal) =>
    new Promise<VoiceToolOutcome | null>((resolve, reject) => {
      const stop = () => {
        recordTool(call, INTERRUPTED);
        resolve(null);
      };
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, { once: true });
      deps.runTool(call).then(
        (outcome) => {
          signal.removeEventListener("abort", stop);
          if (!signal.aborted) resolve(outcome);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", stop);
          reject(error);
        },
      );
    });

  const converse = async (
    controller: AbortController,
    spoken: Utterance,
    kept: { length: number },
    review: TaskUpdate | null,
  ) => {
    const purpose: VoiceReplyPurpose = review ? "review" : "reply";
    let readResult = false;
    let messaged = false;
    let prior = "";
    const novel = (said: string) => (prior && said.startsWith(prior) ? said.slice(prior.length) : said);
    const runs = new Set<string>();
    const firstTime = (call: VoiceToolCall): boolean => {
      const run = `${call.name}:${JSON.stringify(call.args)}`;
      if (handledCalls.has(call.id) || runs.has(run)) return false;
      handledCalls.add(call.id);
      runs.add(run);
      return true;
    };
    for (let hop = 0; ; hop++) {
      const received: VoiceToolCall[] = [];
      let said = "";
      let written = "";
      let echo = prior.length > 0;
      let started = false;
      const say = (text: string) => {
        if (started) feed(spoken, text);
        else if (text) {
          started = true;
          append(spoken, text);
        }
      };
      try {
        for await (const frame of deps.reply(requestFor(purpose), controller.signal)) {
          if (controller.signal.aborted) break;
          if (frame.type === "delta") {
            said += frame.text;
            if (!echo) say(frame.text);
            else if (!prior.startsWith(said)) {
              echo = false;
              say(novel(said));
            }
          } else if (frame.type === "text_end") {
            flushText(spoken);
          } else if (frame.type === "tool_call") {
            flushText(spoken);
            received.push({ id: frame.id, name: frame.name, args: frame.args } as VoiceToolCall);
          } else if (frame.type === "written") {
            written = frame.markdown;
            writtenSeq++;
            record("assistant", frame.markdown, frame.id);
            render();
          } else if (frame.type === "error") {
            throw new VoiceReplyError(frame.reason);
          } else {
            break;
          }
        }
      } finally {
        if (controller.signal.aborted && !echo && said && turn === null)
          history.push({ role: "assistant", content: clip(novel(said)) });
      }
      if (controller.signal.aborted) return;
      const fresh = echo ? "" : novel(said);
      prior = said || prior;
      const calls = received.filter(firstTime);
      history.push({
        role: "assistant",
        content: clip(written || fresh),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
      if (calls.length === 0) {
        if (/[?？]["'»”)\s]*$/.test(fresh)) awaitAnswer(spoken);
        return;
      }
      flushText(spoken);
      let ask = "";
      let question: string | null = null;
      let opened = false;
      const refusal = (call: VoiceToolCall): string | null => {
        if (ask) return "awaiting_confirmation";
        if (call.name === "delegate_task" && readResult) return "ask_user_first";
        if (review && call.name === "send_task_message") {
          if (call.args.taskRef !== review.taskRef) return "not_the_reviewed_task";
          if (messaged) return "one_message_per_review";
          messaged = true;
        }
        return null;
      };
      for (const call of calls) {
        const blocked = refusal(call);
        const outcome = blocked ? refused(blocked) : await settleTool(call, controller.signal);
        if (!outcome) return;
        recordTool(call, outcome);
        kept.length = history.length;
        if (call.name === "task_result") readResult = true;
        if (call.name === "open_task" && !outcome.isError) opened = true;
        if (outcome.ask && call.name === "ask_user") question = String(call.args.question ?? "").trim();
        if (outcome.confirm) {
          confirmation = outcome.confirm;
          ask = copy().confirm(outcome.confirm);
        }
      }
      if (ask) {
        history.push({ role: "assistant", content: ask });
        record("assistant", ask);
        keep([{ role: "assistant", text: ask }]);
        render();
        append(spoken, ask);
        return;
      }
      if (question !== null) {
        awaitAnswer(spoken);
        if (!fresh.trim() && question) append(spoken, question);
        return;
      }
      if (opened || hop >= VOICE_MAX_TOOL_HOPS) return;
    }
  };

  const respond = async (text: string) => {
    silence();
    const controller = new AbortController();
    turn = controller;
    const awaiting = confirmation;
    confirmation = null;
    errorStatus = "";
    announcement = "";
    awaitingUser = false;
    const kept = { length: history.length };
    history.push({ role: "user", content: clip(text) });
    record("user", text);
    captions = { user: { text, final: true }, agent: null };
    setState("thinking");
    armThinking(controller);
    const spoken = beginUtterance(resumeState());
    const answer = awaiting ? confirmationAnswer(text) : null;
    try {
      if (awaiting && answer) await settle(awaiting, text, answer === "yes", controller, spoken);
      else await converse(controller, spoken, kept, null);
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) return;
      history.length = kept.length;
      fail(error, spoken);
    } finally {
      if (turn === controller) {
        turn = null;
        clearThinking();
      }
    }
    if (controller.signal.aborted) return;
    finishText(spoken);
  };

  async function runReview(item: Extract<Queued, { kind: "review" }>): Promise<void> {
    const controller = new AbortController();
    turn = controller;
    errorStatus = "";
    announcement = "";
    const kept = { length: history.length };
    history.push(...taskUpdateMessages(item.update, `review-${++reviewSeq}`));
    deps.chime("announce");
    captions = { user: null, agent: null };
    const spoken = beginUtterance(state);
    const shown = writtenSeq;
    setState("thinking");
    armThinking(controller);
    let failure: Error | null = null;
    try {
      await converse(controller, spoken, kept, item.update);
    } catch (error) {
      if (!controller.signal.aborted && !isAbort(error)) {
        history.length = kept.length;
        failure = error instanceof Error ? error : new Error("review_failed");
      }
    } finally {
      if (turn === controller) {
        turn = null;
        clearThinking();
      }
    }
    if (controller.signal.aborted) {
      item.settle(spoken.played > 0 || writtenSeq > shown ? "interrupted" : "unheard");
      return;
    }
    finishText(spoken);
    item.settle(failure ?? "done");
  }

  const clearPttTimer = () => {
    if (pttTimer !== null) timers.clear(pttTimer);
    pttTimer = null;
  };

  const heldCaptureEnded = (): boolean => {
    if (pttClosing > 0) pttClosing--;
    else if (pttActive) {
      clearPttTimer();
      pttActive = false;
      pttConfirmed = false;
    } else return false;
    syncMode();
    render();
    return true;
  };

  const confirmHold = () => {
    clearPttTimer();
    if (!pttActive || pttConfirmed) return;
    pttConfirmed = true;
    silence();
    deps.chime("wake");
    if (speechActive) captions = { user: { text: "", final: false }, agent: captions.agent };
    setState("listening");
  };

  const dropHold = () => {
    clearPttTimer();
    pttActive = false;
    pttConfirmed = false;
    speechActive = false;
    if (captions.user && !captions.user.final) captions = { ...captions, user: null };
  };

  const pttDown = () => {
    if (!pushMode() || pttActive || muted || state === "off" || state === "arming") return;
    pttActive = true;
    pttConfirmed = false;
    pttAt = now();
    errorStatus = "";
    if (deps.settings().pttStyle !== "hold") {
      confirmHold();
      return;
    }
    syncMode();
    render();
    pttTimer = timers.set(confirmHold, PTT_MIN_MS);
  };

  const pttUp = () => {
    if (!pttActive) return;
    if (!pttConfirmed && now() - pttAt < PTT_MIN_MS) {
      dropHold();
      setState(state);
      return;
    }
    confirmHold();
    pttActive = false;
    pttConfirmed = false;
    pttClosing++;
    deps.speech.post({ type: "end-segment" });
    syncMode();
    armIdle();
    render();
  };

  const pttToggle = () => (pttActive ? pttUp() : pttDown());

  const onSpeech = (message: SpeechWorkerOut) => {
    if (disposed) return;
    switch (message.type) {
      case "loading":
        armingStatus = {
          vad: copy().loadingVad,
          asr: copy().loadingAsr,
          warmup: copy().warmup,
        }[message.stage];
        render();
        return;
      case "ready":
        speechReady = true;
        if (ttsReady && state === "arming") setState("sleeping");
        return;
      case "speech-start": {
        const listening = desiredMode();
        if (listening === "paused") return;
        lastSpeechAt = now();
        speechActive = true;
        if (listening === "sleeping" || (listening === "held" && !pttConfirmed)) return;
        if (state === "thinking" || state === "speaking") interrupt();
        clearIdle();
        captions = { user: { text: "", final: false }, agent: captions.agent };
        render();
        return;
      }
      case "speech-misfire":
        speechActive = false;
        lastSpeechAt = now();
        if (heldCaptureEnded()) {
          if (state === "listening" && !pttActive) {
            captions = { ...captions, user: null };
            setState("sleeping");
          }
          return;
        }
        if (state === "listening") {
          captions = { ...captions, user: null };
          armIdle();
          render();
        }
        drainAnnouncements();
        return;
      case "speech-end":
        speechActive = false;
        lastSpeechAt = now();
        if (message.purpose === "utterance") {
          pendingSegments.add(message.segmentId);
          heldCaptureEnded();
          clearIdle();
        }
        drainAnnouncements();
        return;
      case "transcript":
        handleTranscript(message);
        return;
      case "error":
        if (message.fatal) {
          const noGpu = message.reason === "webgpu_unavailable";
          deps.onFatal(noGpu ? copy().webgpu : copy().fatal, !noGpu && message.stage === "asr" ? "asr" : undefined);
        }
        return;
    }
  };

  const handleTranscript = (message: Extract<SpeechWorkerOut, { type: "transcript" }>) => {
    const phrase = deps.settings().wakePhrase;
    if (message.purpose === "wake") {
      if (desiredMode() !== "sleeping") return;
      const wake = matchWake(message.text, phrase);
      if (!wake.matched) return;
      silence();
      deps.chime("wake");
      if (message.truncated) {
        rewoken.add(message.segmentId);
        pendingSegments.add(message.segmentId);
        deps.speech.post({ type: "retranscribe", segmentId: message.segmentId });
        setState("listening");
      } else if (wake.remainder) void respond(wake.remainder);
      else setState("listening");
      return;
    }
    pendingSegments.delete(message.segmentId);
    const afterWake = rewoken.delete(message.segmentId);
    if (state === "off" || state === "arming") return;
    const heard = message.text.trim();
    const woken = afterWake ? matchWake(heard, phrase) : null;
    const text = woken?.matched ? woken.remainder : heard;
    if (!text) {
      if (state === "listening" && pushMode() && !pttActive) setState("sleeping");
      else if (state === "listening") {
        captions = { ...captions, user: null };
        armIdle();
        render();
      }
      drainAnnouncements();
      return;
    }
    void respond(text);
  };

  const onTts = (message: TtsWorkerOut) => {
    if (disposed) return;
    if (message.type === "ready") {
      ttsReady = true;
      if ((speechReady || micOff()) && state === "arming") setState("sleeping");
      return;
    }
    if (message.type === "error" && message.fatal) {
      deps.onFatal(copy().voiceTts, "tts");
      return;
    }
    const target = utterance;
    if (!target || message.utteranceId !== target.id) return;
    if (message.type === "pcm") {
      const span = target.spans[message.chunkIndex];
      if (span) span.samples += message.pcm.length;
      target.received = true;
      deps.playback.post({ type: "push", utteranceId: target.id, pcm: message.pcm, sampleRate: message.sampleRate }, [
        message.pcm.buffer,
      ]);
      if (state !== "speaking") setState("speaking");
      return;
    }
    target.pending = Math.max(0, target.pending - 1);
    maybeEnd(target);
  };

  const onPlayback = (message: PlaybackWorkletOut) => {
    if (disposed || message.type === "flushed") return;
    const target = utterance;
    if (!target || message.utteranceId !== target.id) return;
    if (message.type === "progress") {
      target.played = message.playedSamples;
      if (captions.agent)
        captions = { ...captions, agent: { ...captions.agent, spokenChars: spokenChars(target.spans, target.played) } };
      render();
      return;
    }
    finishUtterance(target);
  };

  unlisten.push(deps.speech.listen(onSpeech), deps.tts.listen(onTts), deps.playback.listen(onPlayback));
  deps.setMuted(muted);
  render();

  return {
    get state() {
      return state;
    },
    get muted() {
      return muted;
    },
    press() {
      if (pushMode()) pttToggle();
      else if (micOff()) {
        if (state === "thinking" || state === "speaking") interrupt();
      } else if (state === "sleeping") {
        deps.chime("wake");
        setState("listening");
      } else if (state === "listening") {
        if (speechActive) deps.speech.post({ type: "end-segment" });
        else setState("sleeping");
      } else if (state === "thinking" || state === "speaking") {
        interrupt();
      }
    },
    pttDown,
    pttUp,
    pttToggle,
    toggleMute() {
      muted = !muted;
      deps.setMuted(muted);
      deps.onMutedChange?.(muted);
      if (muted) {
        const held = pttActive;
        dropHold();
        if (held && state === "listening") {
          setState("sleeping");
          return;
        }
      }
      syncMode();
      render();
    },
    type(text) {
      const trimmed = text.trim();
      if (!trimmed || state === "off" || state === "arming") return;
      void respond(trimmed);
    },
    announce(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      announcements.push({ kind: "announce", text: trimmed });
      drainAnnouncements();
    },
    review(update) {
      if (disposed) return Promise.resolve("interrupted");
      return new Promise<ReviewOutcome>((resolve, reject) => {
        announcements.push({
          kind: "review",
          update,
          settle: (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)),
        });
        drainAnnouncements();
      });
    },
    get transcript() {
      return transcript;
    },
    setTranscript(entries) {
      const local = transcript.filter((entry) => entry.id.startsWith("local-"));
      transcript = entries.slice(-TRANSCRIPT_LIMIT).map((entry) => {
        const index = local.findIndex((mine) => mine.role === entry.role && mine.text === entry.text);
        if (index < 0) return entry;
        const [mine] = local.splice(index, 1);
        return { ...entry, id: mine!.id };
      });
      render();
    },
    setStatus(text) {
      armingStatus = text;
      render();
    },
    applySettings() {
      deps.speech.post({ type: "config", language: deps.settings().language });
      if (!pushMode() && pttActive) {
        dropHold();
        armIdle();
      }
      if (micMode() !== "open" && state === "listening" && !pttActive) {
        setState("sleeping");
        return;
      }
      syncMode();
      render();
    },
    dispose() {
      if (disposed) return;
      silence();
      clearIdle();
      clearPttTimer();
      if (quietTimer !== null) timers.clear(quietTimer);
      quietTimer = null;
      confirmation = null;
      for (const item of announcements.splice(0)) if (item.kind === "review") item.settle("interrupted");
      for (const stop of unlisten) stop();
      state = "off";
      disposed = true;
    },
  };
}
