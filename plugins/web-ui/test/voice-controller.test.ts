import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOUNCE_QUIET_MS,
  SPEAKING_VAD,
  THINKING_CHIME_MS,
  createVoiceController,
  spokenChars,
  windowMessages,
  type Port,
  type VoiceControllerDeps,
} from "../src/voice-assistant/controller.ts";
import { VoiceReplyError } from "../src/voice-assistant/llm.ts";
import {
  DEFAULT_VOICE_SETTINGS,
  IDLE_TO_SLEEP_MS,
  VOICE_MAX_MESSAGES,
  VOICE_MAX_TOOL_HOPS,
  type PlaybackWorkletIn,
  type PlaybackWorkletOut,
  type SpeechWorkerIn,
  type SpeechWorkerOut,
  type TtsWorkerIn,
  type TtsWorkerOut,
  type VoiceMessage,
  type VoiceReplyFrame,
  type VoiceReplyRequest,
  type VoiceSettings,
  type VoiceStageView,
  type VoiceToolCall,
} from "../src/voice-assistant/protocol.ts";
import { stepsForChunk } from "../src/voice-assistant/text-chunker.ts";

interface FakePort<In, Out> extends Port<In, Out> {
  sent: In[];
  emit(message: Out): void;
}

function fakePort<In, Out>(): FakePort<In, Out> {
  const handlers = new Set<(message: Out) => void>();
  const sent: In[] = [];
  return {
    sent,
    post: (message) => void sent.push(message),
    listen(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(message) {
      for (const handler of handlers) handler(message);
    },
  };
}

function fakeClock() {
  let time = 1_000_000;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    timers: {
      set(fn: () => void, ms: number) {
        const id = ++seq;
        pending.set(id, { at: time + ms, fn });
        return id;
      },
      clear(handle: unknown) {
        pending.delete(handle as number);
      },
    },
    advance(ms: number) {
      const until = time + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        pending.delete(next[0]);
        time = next[1].at;
        next[1].fn();
      }
      time = until;
    },
  };
}

interface Script {
  frames: VoiceReplyFrame[];
  hold?: Promise<void>;
}

function setup(scripts: Script[] = [], settings: Partial<VoiceSettings> = {}) {
  const speech = fakePort<SpeechWorkerIn, SpeechWorkerOut>();
  const tts = fakePort<TtsWorkerIn, TtsWorkerOut>();
  const playback = fakePort<PlaybackWorkletIn, PlaybackWorkletOut>();
  const clock = fakeClock();
  const views: VoiceStageView[] = [];
  const chimes: string[] = [];
  const requests: VoiceReplyRequest[] = [];
  const signals: AbortSignal[] = [];
  const tools: VoiceToolCall[] = [];
  const fatal: string[] = [];
  const muted: boolean[] = [];
  const deps: VoiceControllerDeps = {
    speech,
    tts,
    playback,
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, enabled: true, ...settings }),
    async *reply(request, signal) {
      requests.push(structuredClone(request));
      signals.push(signal);
      const script = scripts.shift() ?? { frames: [{ type: "done" }] };
      for (const frame of script.frames) {
        if (script.hold && frame.type === "done") await script.hold;
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        yield frame;
      }
    },
    async runTool(call) {
      tools.push(call);
      return { content: JSON.stringify({ ok: true, name: call.name }) };
    },
    runningTasks: () => [{ taskRef: "web:u:1", title: "Informe", state: "working" }],
    chime: (kind) => void chimes.push(kind),
    setMuted: (value) => void muted.push(value),
    render: (view) => void views.push(view),
    onFatal: (message) => void fatal.push(message),
    now: clock.now,
    timers: clock.timers,
  };
  const controller = createVoiceController(deps);
  const ready = () => {
    speech.emit({ type: "ready", backend: "webgpu", asrVariant: "q4f16" });
    tts.emit({ type: "ready", engine: "supertonic-3", backend: "webgpu", sampleRate: 44_100 });
  };
  const view = () => views.at(-1)!;
  const modes = () => speech.sent.filter((m) => m.type === "mode").map((m) => (m as { mode: string }).mode);
  const speaks = () => tts.sent.filter((m): m is Extract<TtsWorkerIn, { type: "speak" }> => m.type === "speak");
  const transcript = (text: string, purpose: "wake" | "utterance" = "utterance", segmentId = 1) =>
    speech.emit({ type: "transcript", segmentId, purpose, text, language: "es", ms: 100 });
  const pcmFor = (index: number, samples = 44_100) => {
    const speak = speaks()[index]!;
    tts.emit({
      type: "pcm",
      utteranceId: speak.utteranceId,
      chunkIndex: speak.chunkIndex,
      pcm: new Float32Array(samples),
      sampleRate: 44_100,
      chars: speak.text.length,
    });
  };
  return {
    controller,
    speech,
    tts,
    playback,
    clock,
    views,
    view,
    chimes,
    requests,
    signals,
    tools,
    fatal,
    muted,
    ready,
    modes,
    speaks,
    transcript,
    pcmFor,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the controller arms until both workers are ready, then sleeps waiting for the wake phrase", () => {
  const t = setup();
  assert.equal(t.controller.state, "arming");
  t.speech.emit({ type: "loading", stage: "asr" });
  assert.equal(t.view().status, "Cargando el reconocimiento de voz");
  t.speech.emit({ type: "ready", backend: "webgpu", asrVariant: "q4f16" });
  assert.equal(t.controller.state, "arming");
  t.tts.emit({ type: "ready", engine: "supertonic-3", backend: "webgpu", sampleRate: 44_100 });
  assert.equal(t.controller.state, "sleeping");
  assert.deepEqual(t.modes(), ["sleeping"]);
  assert.equal(t.view().status, "Di «Oye Omni»");
  assert.equal(t.view().language, "es");
});

test("a matching wake transcript chimes and listens; anything else keeps sleeping", () => {
  const t = setup();
  t.ready();
  t.transcript("hoy hace calor", "wake");
  assert.equal(t.controller.state, "sleeping");
  t.transcript("Oye Omni", "wake");
  assert.equal(t.controller.state, "listening");
  assert.deepEqual(t.chimes, ["wake"]);
  assert.deepEqual(t.modes(), ["sleeping", "awake"]);
});

test("a custom wake phrase from settings is the one that wakes", () => {
  const t = setup([], { wakePhrase: "Hola Lucía" });
  t.ready();
  t.transcript("Oye Omni", "wake");
  assert.equal(t.controller.state, "sleeping");
  t.transcript("hola lucía", "wake");
  assert.equal(t.controller.state, "listening");
});

test("the words after the wake phrase become the first turn, streamed into speech and played to the end", async () => {
  const t = setup([
    {
      frames: [
        { type: "delta", text: "Tienes una tarea en curso, " },
        { type: "delta", text: "el informe. Te aviso cuando acabe." },
        { type: "done", model: "gpt-6.1-terra" },
      ],
    },
  ]);
  t.ready();
  t.transcript("Oye Omni, ¿qué tareas tengo?", "wake");
  await flush();
  assert.equal(t.requests.length, 1);
  const request = t.requests[0]!;
  assert.equal(request.purpose, "reply");
  assert.equal(request.tools, true);
  assert.deepEqual(request.messages, [{ role: "user", content: "¿qué tareas tengo?" }]);
  assert.deepEqual(request.context?.runningTasks, [{ taskRef: "web:u:1", title: "Informe", state: "working" }]);
  const speaks = t.speaks();
  assert.ok(speaks.length >= 2);
  speaks.forEach((speak, i) => {
    assert.equal(speak.chunkIndex, i);
    assert.equal(speak.steps, stepsForChunk(i));
    assert.equal(speak.voice, "F1");
    assert.equal(speak.language, "es");
  });
  assert.equal(t.controller.state, "thinking");
  t.pcmFor(0);
  assert.equal(t.controller.state, "speaking");
  assert.deepEqual(t.speech.sent.at(-1), { type: "config", vad: SPEAKING_VAD });
  const push = t.playback.sent[0] as Extract<PlaybackWorkletIn, { type: "push" }>;
  assert.equal(push.type, "push");
  assert.equal(push.sampleRate, 44_100);
  for (let i = 1; i < speaks.length; i++) t.pcmFor(i);
  assert.deepEqual(t.playback.sent.at(-1), { type: "end", utteranceId: speaks[0]!.utteranceId });
  t.playback.emit({ type: "progress", utteranceId: speaks[0]!.utteranceId, playedSamples: 22_050, sampleRate: 44_100 });
  const halfway = t.view().captions.agent!;
  assert.equal(halfway.text, "Tienes una tarea en curso, el informe. Te aviso cuando acabe.");
  assert.ok(halfway.spokenChars > 0 && halfway.spokenChars < halfway.text.length);
  t.playback.emit({ type: "drained", utteranceId: speaks[0]!.utteranceId });
  assert.equal(t.controller.state, "listening");
  assert.equal(t.view().captions.agent!.spokenChars, halfway.text.length);
  t.clock.advance(IDLE_TO_SLEEP_MS);
  assert.equal(t.controller.state, "sleeping");
});

test("speech during a reply barges in: the request is aborted, synthesis cancelled and playback flushed", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const t = setup([
    {
      frames: [{ type: "delta", text: "Claro que sí, ahora mismo te lo cuento. Dame un segundo." }, { type: "done" }],
      hold,
    },
  ]);
  t.ready();
  t.controller.press();
  t.transcript("cuéntame algo");
  await flush();
  t.pcmFor(0);
  assert.equal(t.controller.state, "speaking");
  const utteranceId = t.speaks()[0]!.utteranceId;
  t.speech.emit({ type: "speech-start" });
  assert.equal(t.controller.state, "listening");
  assert.equal(t.signals[0]!.aborted, true);
  assert.ok(t.tts.sent.some((m) => m.type === "cancel" && m.utteranceId === utteranceId));
  assert.deepEqual(t.playback.sent.at(-1), { type: "flush" });
  release();
  await flush();
  assert.equal(t.controller.state, "listening");
  t.playback.emit({ type: "drained", utteranceId });
  assert.equal(t.controller.state, "listening");
});

test("a tool whose result must be read goes back to the model in a follow-up request", async () => {
  const t = setup([
    {
      frames: [{ type: "tool_call", id: "c1", name: "task_result", args: { taskRef: "web:u:1" } }, { type: "done" }],
    },
    { frames: [{ type: "delta", text: "El informe tiene tres conclusiones." }, { type: "done" }] },
  ]);
  t.ready();
  t.controller.type("¿qué dice el informe?");
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(t.tools.length, 1);
  assert.equal(t.requests.length, 2);
  assert.deepEqual(t.requests[1]!.messages.slice(1), [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "task_result", args: { taskRef: "web:u:1" } }],
    },
    {
      role: "tool",
      toolCallId: "c1",
      name: "task_result",
      content: JSON.stringify({ ok: true, name: "task_result" }),
    },
  ]);
  assert.deepEqual(
    t.speaks().map((s) => s.text),
    ["El informe tiene tres conclusiones."],
  );
});

test("delegating a task takes one model hop: the model's own words are the acknowledgement", async () => {
  const t = setup([
    {
      frames: [
        { type: "delta", text: "Me pongo con ello." },
        {
          type: "tool_call",
          id: "c1",
          name: "delegate_task",
          args: { instruction: "Resume el último correo", title: "Resumen" },
        },
        { type: "done" },
      ],
    },
  ]);
  t.ready();
  t.controller.type("resume el último correo");
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(t.requests.length, 1, "no second request just to acknowledge");
  assert.equal(t.tools[0]!.name, "delegate_task");
  assert.deepEqual(
    t.speaks().map((s) => s.text),
    ["Me pongo con ello."],
  );
  t.controller.type("gracias");
  await flush();
  assert.deepEqual(t.requests[1]!.messages.slice(1, 3), [
    {
      role: "assistant",
      content: "Me pongo con ello.",
      toolCalls: [
        { id: "c1", name: "delegate_task", args: { instruction: "Resume el último correo", title: "Resumen" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "c1",
      name: "delegate_task",
      content: JSON.stringify({ ok: true, name: "delegate_task" }),
    },
  ]);
});

test("a silent delegation is acknowledged out loud by the app without another model hop", async () => {
  const t = setup([
    {
      frames: [
        { type: "tool_call", id: "c1", name: "delegate_task", args: { instruction: "Busca vuelos", title: "Vuelos" } },
        { type: "done" },
      ],
    },
  ]);
  t.ready();
  t.controller.type("busca vuelos a Roma");
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(t.requests.length, 1);
  assert.deepEqual(
    t.speaks().map((s) => s.text),
    ["Me pongo con ello."],
  );
  t.controller.type("vale");
  await flush();
  assert.deepEqual(t.requests[1]!.messages.at(-2), { role: "assistant", content: "Me pongo con ello." });
});

test("switching language or voice is confirmed in the new language and voice, in one hop", async () => {
  let settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, enabled: true };
  const t = setup([
    { frames: [{ type: "tool_call", id: "l", name: "set_language", args: { language: "en" } }, { type: "done" }] },
    { frames: [{ type: "tool_call", id: "v", name: "set_voice", args: { gender: "male" } }, { type: "done" }] },
  ]);
  t.controller.dispose();
  const speaks: Array<Extract<TtsWorkerIn, { type: "speak" }>> = [];
  const scripts: VoiceReplyFrame[][] = [
    [{ type: "tool_call", id: "l", name: "set_language", args: { language: "en" } }, { type: "done" }],
    [{ type: "tool_call", id: "v", name: "set_voice", args: { gender: "male" } }, { type: "done" }],
  ];
  const c = createVoiceController({
    speech: t.speech,
    tts: { post: (m) => void (m.type === "speak" && speaks.push(m)), listen: t.tts.listen },
    playback: t.playback,
    settings: () => settings,
    reply: async function* (request) {
      t.requests.push(structuredClone(request));
      yield* scripts.shift() ?? [{ type: "done" }];
    },
    runTool: async (call) => {
      if (call.name === "set_language") settings = { ...settings, language: call.args.language };
      if (call.name === "set_voice") settings = { ...settings, voice: "M1" };
      return { content: JSON.stringify({ ok: true }) };
    },
    runningTasks: () => [],
    chime: () => undefined,
    setMuted: () => undefined,
    render: () => undefined,
    onFatal: () => undefined,
    now: t.clock.now,
    timers: t.clock.timers,
  });
  t.ready();
  c.type("habla en inglés");
  for (let i = 0; i < 4; i++) await flush();
  c.type("use a male voice");
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(t.requests.length, 2);
  assert.deepEqual(
    speaks.map((s) => [s.text, s.language, s.voice]),
    [
      ["Okay, I'll speak English now.", "en", "F1"],
      ["Okay, this is Male 1.", "en", "M1"],
    ],
  );
  assert.equal(t.requests[1]!.language, "en");
  assert.equal(t.requests[1]!.context?.voice, "F1");
  assert.equal(t.requests[1]!.context?.voices?.length, 10);
  c.dispose();
});

test("a failed action goes back to the model so it can explain", async () => {
  const t = setup([
    { frames: [{ type: "tool_call", id: "s", name: "stop_task", args: { taskRef: "web:u:1" } }, { type: "done" }] },
    { frames: [{ type: "delta", text: "Esa tarea ya no estaba en marcha." }, { type: "done" }] },
  ]);
  t.controller.dispose();
  const c = createVoiceController({
    speech: t.speech,
    tts: t.tts,
    playback: t.playback,
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, enabled: true }),
    reply: async function* (request) {
      t.requests.push(structuredClone(request));
      yield* (
        [
          [{ type: "tool_call", id: "s", name: "stop_task", args: { taskRef: "web:u:1" } }, { type: "done" }],
          [{ type: "delta", text: "Esa tarea ya no estaba en marcha." }, { type: "done" }],
        ] as VoiceReplyFrame[][]
      )[t.requests.length - 1] ?? [{ type: "done" }];
    },
    runTool: async () => ({ content: JSON.stringify({ ok: false, error: "not_running" }), isError: true }),
    runningTasks: () => [],
    chime: () => undefined,
    setMuted: () => undefined,
    render: () => undefined,
    onFatal: () => undefined,
    now: t.clock.now,
    timers: t.clock.timers,
  });
  t.ready();
  c.type("para la tarea");
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(t.requests.length, 2);
  assert.deepEqual(
    t.speaks().map((s) => s.text),
    ["Esa tarea ya no estaba en marcha."],
  );
  c.dispose();
});

test("words a follow-up hop repeats from the previous hop are not spoken twice", async () => {
  const t = setup([
    {
      frames: [
        { type: "delta", text: "Lo miro." },
        { type: "tool_call", id: "r1", name: "task_result", args: { taskRef: "web:u:1" } },
        { type: "done" },
      ],
    },
    {
      frames: [
        { type: "delta", text: "Lo " },
        { type: "delta", text: "miro." },
        { type: "tool_call", id: "r1", name: "task_result", args: { taskRef: "web:u:1" } },
        { type: "done" },
      ],
    },
  ]);
  t.ready();
  t.controller.type("¿cómo va?");
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(t.requests.length, 2);
  assert.equal(t.tools.length, 1);
  assert.deepEqual(
    t.speaks().map((s) => s.text),
    ["Lo miro."],
  );
});

test("a follow-up hop that repeats the previous words and goes on speaks only what is new", async () => {
  const t = setup([
    {
      frames: [
        { type: "delta", text: "Lo miro." },
        { type: "tool_call", id: "r1", name: "task_result", args: { taskRef: "web:u:1" } },
        { type: "done" },
      ],
    },
    {
      frames: [
        { type: "delta", text: "Lo miro." },
        { type: "delta", text: " Tiene tres conclusiones." },
        { type: "done" },
      ],
    },
    { frames: [{ type: "done" }] },
  ]);
  t.ready();
  t.controller.type("¿cómo va?");
  for (let i = 0; i < 6; i++) await flush();
  assert.deepEqual(
    t.speaks().map((s) => s.text),
    ["Lo miro.", "Tiene tres conclusiones."],
  );
  t.controller.type("vale");
  for (let i = 0; i < 3; i++) await flush();
  const said = t.requests
    .at(-1)!
    .messages.filter((m) => m.role === "assistant")
    .map((m) => m.content);
  assert.deepEqual(said, ["Lo miro.", " Tiene tres conclusiones."]);
});

test("an error on the hop after a delegation keeps the started task in the history", async () => {
  const t = setup([
    {
      frames: [
        { type: "tool_call", id: "c1", name: "check_tasks", args: {} },
        { type: "tool_call", id: "d1", name: "delegate_task", args: { instruction: "busca X", title: "X" } },
        { type: "done" },
      ],
    },
    { frames: [{ type: "error", reason: "upstream_error" }] },
    { frames: [{ type: "done" }] },
  ]);
  t.ready();
  t.controller.type("busca X");
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(t.chimes.at(-1), "error");
  t.controller.type("¿y bien?");
  for (let i = 0; i < 3; i++) await flush();
  const messages = t.requests.at(-1)!.messages;
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "tool", "tool", "user"],
  );
  assert.ok(messages.some((m) => m.role === "tool" && m.toolCallId === "d1"));
});

test("a soft thinking chime plays only when no reply has started after a while", async () => {
  let release!: () => void;
  const t = setup([
    { frames: [{ type: "done" }], hold: new Promise((r) => (release = r)) },
    { frames: [{ type: "delta", text: "Un momento, lo compruebo." }, { type: "done" }] },
  ]);
  t.ready();
  t.controller.type("¿qué hay?");
  await flush();
  t.clock.advance(THINKING_CHIME_MS - 1);
  assert.deepEqual(t.chimes, []);
  t.clock.advance(1);
  assert.deepEqual(t.chimes, ["thinking"]);
  release();
  for (let i = 0; i < 3; i++) await flush();
  t.controller.type("otra");
  await flush();
  t.pcmFor(t.speaks().length - 1);
  t.clock.advance(THINKING_CHIME_MS);
  assert.deepEqual(t.chimes, ["thinking"]);
});

test("the thinking chime stays silent once the reply text has started", async () => {
  let release!: () => void;
  const t = setup([
    {
      frames: [{ type: "delta", text: "Un momento" }, { type: "done" }],
      hold: new Promise((r) => (release = r)),
    },
  ]);
  t.ready();
  t.controller.type("¿qué hay?");
  await flush();
  t.clock.advance(THINKING_CHIME_MS);
  assert.deepEqual(t.chimes, []);
  release();
});

test("follow-up hops stop after the limit even when the model keeps calling tools", async () => {
  const t = setup(
    Array.from({ length: 10 }, (_, i) => ({
      frames: [
        { type: "tool_call", id: `c${i}`, name: "task_result", args: { taskRef: `web:u:${i}` } },
        { type: "done" },
      ] as VoiceReplyFrame[],
    })),
  );
  t.ready();
  t.controller.type("¿qué hay?");
  for (let i = 0; i < 12; i++) await flush();
  assert.equal(t.requests.length, 1 + VOICE_MAX_TOOL_HOPS);
  assert.equal(t.tools.length, 1 + VOICE_MAX_TOOL_HOPS);
  assert.equal(t.controller.state, "listening");
});

test("a repeated tool call runs once and ends the turn instead of starting the same task again", async () => {
  const call = {
    type: "tool_call",
    id: "voice-call-1",
    name: "delegate_task",
    args: { instruction: "Di hola", title: "Hola" },
  } as const;
  const again = { ...call, id: "voice-call-2" };
  const t = setup([
    { frames: [{ type: "tool_call", id: "list", name: "check_tasks", args: {} }, call, { type: "done" }] },
    { frames: [call, again, { type: "done" }] },
    { frames: [call, { type: "done" }] },
  ]);
  t.ready();
  t.controller.type("di hola");
  for (let i = 0; i < 8; i++) await flush();
  assert.deepEqual(
    t.tools.map((c) => c.name),
    ["check_tasks", "delegate_task"],
  );
  assert.equal(t.requests.length, 2);
  assert.equal(t.controller.state, "listening");
  t.controller.type("¿y ahora?");
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(t.tools.length, 2);
  const ids = t.requests.at(-1)!.messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));
  assert.deepEqual(
    ids.map((c) => c.id),
    ["list", "voice-call-1"],
  );
});

test("a reply error chimes, says why out loud, and drops the failed turn from the history", async () => {
  const t = setup([
    { frames: [{ type: "error", reason: "voice_model_unsupported" }] },
    { frames: [{ type: "delta", text: "Hola." }, { type: "done" }] },
  ]);
  t.ready();
  t.controller.type("hola");
  await flush();
  assert.deepEqual(t.chimes, ["error"]);
  assert.equal(t.view().status, "Tu modelo no admite el asistente de voz.");
  assert.deepEqual(
    t.speaks().map((m) => m.text),
    ["Tu modelo no admite el asistente de voz."],
  );
  t.pcmFor(0);
  t.playback.emit({ type: "drained", utteranceId: t.speaks()[0]!.utteranceId });
  assert.equal(t.controller.state, "listening");
  t.controller.type("otra vez");
  await flush();
  assert.deepEqual(t.requests.at(-1)!.messages, [{ role: "user", content: "otra vez" }]);
});

test("a rejected request surfaces the server's reason", async () => {
  const t = setup();
  const failing = createVoiceController({
    speech: t.speech,
    tts: t.tts,
    playback: t.playback,
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, language: "en" }),
    reply: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new VoiceReplyError("over_budget", 429)) }),
    }),
    runTool: async () => ({ content: "{}" }),
    runningTasks: () => [],
    chime: () => undefined,
    setMuted: () => undefined,
    render: (view) => void t.views.push(view),
    onFatal: () => undefined,
    now: t.clock.now,
    timers: t.clock.timers,
  });
  t.ready();
  failing.type("hello");
  await flush();
  assert.equal(t.view().status, "You have reached your spending limit.");
});

test("announcements wait until the conversation is idle and quiet, then play with a chime", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const t = setup([{ frames: [{ type: "delta", text: "Un momento." }, { type: "done" }], hold }]);
  t.ready();
  t.controller.type("espera");
  await flush();
  t.controller.announce("Listo: Informe. Ya tienes el resumen.");
  assert.ok(!t.chimes.includes("announce"), "never talks over a reply in progress");
  release();
  await flush();
  t.pcmFor(0);
  t.playback.emit({ type: "drained", utteranceId: t.speaks()[0]!.utteranceId });
  assert.equal(t.controller.state, "listening");
  assert.ok(!t.chimes.includes("announce"), "leaves the user a moment to answer the reply");
  t.clock.advance(ANNOUNCE_QUIET_MS - 1);
  t.speech.emit({ type: "speech-start" });
  t.speech.emit({ type: "speech-misfire" });
  t.clock.advance(ANNOUNCE_QUIET_MS - 1);
  assert.ok(!t.chimes.includes("announce"), "waits for a quiet stretch after speech");
  t.clock.advance(1);
  assert.deepEqual(t.chimes, ["announce"]);
  assert.equal(t.view().announcement, "Listo: Informe. Ya tienes el resumen.");
  assert.deepEqual(
    t
      .speaks()
      .slice(-2)
      .map((s) => s.text),
    ["Listo: Informe.", "Ya tienes el resumen."],
  );
});

test("announcements play straight away while sleeping, keep the wake gate, and go back to sleep", () => {
  const t = setup();
  t.ready();
  t.controller.announce("Listo: Informe.");
  assert.deepEqual(t.chimes, ["announce"]);
  t.pcmFor(0);
  assert.equal(t.controller.state, "speaking");
  assert.equal(t.modes().at(-1), "sleeping", "speech during the announcement still needs the wake phrase");
  t.speech.emit({ type: "speech-start" });
  assert.equal(t.controller.state, "speaking", "a bystander does not barge in");
  t.speech.emit({ type: "speech-end", segmentId: 3, durationMs: 900, purpose: "wake" });
  t.playback.emit({ type: "drained", utteranceId: t.speaks()[0]!.utteranceId });
  assert.equal(t.controller.state, "sleeping");
});

test("a sleeping announcement waits for speech in the room to stop", () => {
  const t = setup();
  t.ready();
  t.speech.emit({ type: "speech-start" });
  t.controller.announce("Listo: Informe.");
  assert.deepEqual(t.chimes, [], "never talks over a conversation");
  t.speech.emit({ type: "speech-end", segmentId: 1, durationMs: 2_000, purpose: "wake" });
  t.clock.advance(ANNOUNCE_QUIET_MS - 1);
  assert.deepEqual(t.chimes, []);
  t.clock.advance(1);
  assert.deepEqual(t.chimes, ["announce"]);
});

test("the wake phrase cuts a sleeping announcement short", async () => {
  const t = setup();
  t.ready();
  t.controller.announce("Listo: Informe.");
  t.pcmFor(0);
  t.transcript("Oye Omni", "wake", 2);
  assert.equal(t.controller.state, "listening");
  assert.ok(t.tts.sent.some((m) => m.type === "cancel"));
});

test("a truncated wake check is transcribed again in full before acting on the request", async () => {
  const t = setup();
  t.ready();
  t.speech.emit({
    type: "transcript",
    segmentId: 7,
    purpose: "wake",
    text: "Oye Omni, crea una tarea para",
    language: "es",
    ms: 90,
    truncated: true,
  });
  assert.equal(t.controller.state, "listening");
  assert.ok(t.speech.sent.some((m) => m.type === "retranscribe" && m.segmentId === 7));
  assert.equal(t.requests.length, 0, "never acts on the cut-off request");
  t.clock.advance(IDLE_TO_SLEEP_MS * 2);
  assert.equal(t.controller.state, "listening", "waits for the full transcript");
  t.transcript("Oye Omni, crea una tarea para revisar el contrato mañana", "utterance", 7);
  await flush();
  assert.equal(t.requests[0]!.messages.at(-1)!.content, "crea una tarea para revisar el contrato mañana");
});

test("an empty transcript for a pending segment lets the assistant sleep again", () => {
  const t = setup();
  t.ready();
  t.controller.press();
  t.speech.emit({ type: "speech-start" });
  t.speech.emit({ type: "speech-end", segmentId: 5, durationMs: 900, purpose: "utterance" });
  t.transcript("", "utterance", 5);
  t.clock.advance(IDLE_TO_SLEEP_MS);
  assert.equal(t.controller.state, "sleeping");
});

test("an approval is only carried out after the user says yes to a read-back the model cannot word", async () => {
  const executed: boolean[] = [];
  const t = setup();
  const confirm = {
    approved: true,
    title: "Correo.",
    summary: "enviar el informe a Juan.",
    execute: async () => {
      executed.push(true);
      return { content: "{}" };
    },
  };
  t.controller.dispose();
  const c = createVoiceController({
    speech: t.speech,
    tts: t.tts,
    playback: t.playback,
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, enabled: true }),
    reply: async function* (request) {
      t.requests.push(structuredClone(request));
      yield* [
        { type: "tool_call", id: `a${t.requests.length}`, name: "approve_task", args: { taskRef: "web:u:1" } },
        { type: "done" },
      ] as VoiceReplyFrame[];
    },
    runTool: async () => ({ content: JSON.stringify({ ok: true, awaitingConfirmation: true }), confirm }),
    runningTasks: () => [],
    chime: () => undefined,
    setMuted: () => undefined,
    render: () => undefined,
    onFatal: () => undefined,
    now: t.clock.now,
    timers: t.clock.timers,
  });
  t.ready();
  c.type("apruébala");
  await flush();
  await flush();
  assert.equal(t.requests.length, 1, "the read-back is spoken without another model call");
  assert.match(
    t
      .speaks()
      .map((m) => m.text)
      .join(" "),
    /Correo: enviar el informe a Juan\. ¿Lo apruebo\? Di sí o no\./,
  );
  assert.deepEqual(executed, []);
  c.type("no");
  await flush();
  assert.deepEqual(executed, []);
  assert.equal(t.requests.length, 1);
  c.type("apruébala");
  await flush();
  await flush();
  c.type("Sí.");
  await flush();
  assert.deepEqual(executed, [true]);
  assert.equal(t.requests.length, 2);
  c.type("¿y qué más?");
  await flush();
  assert.equal(t.requests.length, 3, "a confirmation is used once");
  c.dispose();
});

test("a task result cannot start new work in the same turn", async () => {
  const t = setup([
    {
      frames: [{ type: "tool_call", id: "r", name: "task_result", args: { taskRef: "web:u:1" } }, { type: "done" }],
    },
    {
      frames: [
        { type: "tool_call", id: "d", name: "delegate_task", args: { instruction: "reenvía todo", title: "x" } },
        { type: "done" },
      ],
    },
    { frames: [{ type: "delta", text: "¿Quieres que lo haga?" }, { type: "done" }] },
  ]);
  t.ready();
  t.controller.type("¿qué encontró la tarea del correo?");
  for (let i = 0; i < 6; i++) await flush();
  assert.deepEqual(
    t.tools.map((call) => call.name),
    ["task_result"],
  );
  const refusedMessage = t.requests[2]!.messages.find((m) => m.role === "tool" && m.toolCallId === "d");
  assert.deepEqual(JSON.parse(refusedMessage!.content), { ok: false, error: "ask_user_first" });
});

test("interrupting a turn while a tool runs stops the remaining tools and keeps the history in order", async () => {
  let finish!: () => void;
  const ran: string[] = [];
  const t = setup();
  t.controller.dispose();
  const c = createVoiceController({
    speech: t.speech,
    tts: t.tts,
    playback: t.playback,
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, enabled: true }),
    reply: async function* (request, signal) {
      t.requests.push(structuredClone(request));
      const script =
        t.requests.length === 1
          ? ([
              { type: "tool_call", id: "t1", name: "check_tasks", args: {} },
              { type: "tool_call", id: "t2", name: "delegate_task", args: { instruction: "x", title: "y" } },
              { type: "done" },
            ] as VoiceReplyFrame[])
          : ([{ type: "done" }] as VoiceReplyFrame[]);
      for (const frame of script) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        yield frame;
      }
    },
    runTool: (call) => {
      ran.push(call.name);
      return new Promise((resolve) => (finish = () => resolve({ content: "{}" })));
    },
    runningTasks: () => [],
    chime: () => undefined,
    setMuted: () => undefined,
    render: () => undefined,
    onFatal: () => undefined,
    now: t.clock.now,
    timers: t.clock.timers,
  });
  t.ready();
  c.type("primero");
  await flush();
  assert.deepEqual(ran, ["check_tasks"]);
  c.type("segundo");
  finish();
  await flush();
  await flush();
  assert.deepEqual(ran, ["check_tasks"], "the rest of the aborted turn never runs");
  const messages = t.requests.at(-1)!.messages;
  const second = messages.findIndex((m) => m.role === "user" && m.content === "segundo");
  assert.ok(second >= 0);
  assert.ok(
    messages.slice(second + 1).every((m) => m.role !== "tool"),
    "no stale tool result after the new turn",
  );
  c.dispose();
});

test("interrupting a delegation that is still starting tells the model it may have started", async () => {
  const t = setup();
  t.controller.dispose();
  const c = createVoiceController({
    speech: t.speech,
    tts: t.tts,
    playback: t.playback,
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, enabled: true }),
    reply: async function* (request) {
      t.requests.push(structuredClone(request));
      yield* (
        t.requests.length === 1
          ? [
              { type: "tool_call", id: "d1", name: "delegate_task", args: { instruction: "busca X", title: "X" } },
              { type: "done" },
            ]
          : [{ type: "done" }]
      ) as VoiceReplyFrame[];
    },
    runTool: () => new Promise(() => undefined),
    runningTasks: () => [],
    chime: () => undefined,
    setMuted: () => undefined,
    render: () => undefined,
    onFatal: () => undefined,
    now: t.clock.now,
    timers: t.clock.timers,
  });
  t.ready();
  c.type("busca X");
  await flush();
  c.type("¿ya?");
  await flush();
  await flush();
  const messages = t.requests.at(-1)!.messages;
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "tool", "user"],
  );
  const result = messages[2]!;
  assert.equal(result.role === "tool" && result.toolCallId, "d1");
  assert.deepEqual(JSON.parse(result.content), { ok: false, error: "interrupted", started: "unknown" });
  c.dispose();
});

test("muting pauses speech detection and unmuting restores it", () => {
  const t = setup();
  t.ready();
  t.controller.toggleMute();
  assert.equal(t.controller.muted, true);
  assert.deepEqual(t.muted, [false, true]);
  assert.equal(t.modes().at(-1), "paused");
  assert.equal(t.view().status, "Micrófono apagado");
  t.transcript("Oye Omni", "wake");
  assert.equal(t.controller.state, "sleeping");
  t.controller.toggleMute();
  assert.equal(t.modes().at(-1), "sleeping");
});

test("pressing the orb wakes, ends a spoken turn, or interrupts", async () => {
  const t = setup();
  t.ready();
  t.controller.press();
  assert.equal(t.controller.state, "listening");
  t.speech.emit({ type: "speech-start" });
  t.controller.press();
  assert.deepEqual(t.speech.sent.at(-1), { type: "end-segment" });
  t.speech.emit({ type: "speech-end", segmentId: 4, durationMs: 900, purpose: "utterance" });
  t.clock.advance(IDLE_TO_SLEEP_MS * 2);
  assert.equal(t.controller.state, "listening", "never sleeps while a transcript is pending");
  t.transcript("", "utterance", 4);
  t.controller.press();
  assert.equal(t.controller.state, "sleeping");
});

test("a fatal worker error reports a readable reason", () => {
  const t = setup();
  t.speech.emit({ type: "error", stage: "asr", reason: "webgpu_unavailable", fatal: true });
  assert.deepEqual(t.fatal, ["Este navegador no admite WebGPU, que el asistente de voz necesita."]);
});

test("the message window stays within the limit and always opens on a user turn", () => {
  const history: VoiceMessage[] = [];
  for (let i = 0; i < VOICE_MAX_MESSAGES; i++) {
    history.push({ role: "user", content: `q${i}` });
    history.push({ role: "assistant", content: `a${i}` });
  }
  history.push({ role: "assistant", content: "extra" });
  const windowed = windowMessages(history);
  assert.ok(windowed.length <= VOICE_MAX_MESSAGES);
  assert.equal(windowed[0]!.role, "user");
  assert.equal(windowed.at(-1)!.content, "extra");
  assert.deepEqual(windowMessages([{ role: "assistant", content: "solo" }]), []);
});

test("spoken characters follow playback through each chunk", () => {
  const spans = [
    { start: 0, end: 10, samples: 100 },
    { start: 11, end: 31, samples: 200 },
  ];
  assert.equal(spokenChars(spans, 0), 0);
  assert.equal(spokenChars(spans, 50), 5);
  assert.equal(spokenChars(spans, 100), 10);
  assert.equal(spokenChars(spans, 200), 21);
  assert.equal(spokenChars(spans, 1_000), 31);
  assert.equal(spokenChars([{ start: 0, end: 10, samples: 0 }], 500), 0);
});
