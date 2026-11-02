import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession, PendingApproval } from "../src/core-bridge.ts";
import { VoiceReplyError, parseSseEvent, parseVoiceTranscript, streamVoiceReply } from "../src/voice-assistant/llm.ts";
import {
  DEFAULT_VOICE_SETTINGS,
  type VoiceReplyFrame,
  type VoiceReplyRequest,
  type VoiceSettings,
} from "../src/voice-assistant/protocol.ts";
import { parseVoicePreferences, runnableVoiceSettings } from "../src/voice-assistant/settings-store.ts";
import { isVoiceThread, runVoiceTool, taskSummaries, type VoiceToolDeps } from "../src/voice-assistant/tools.ts";

const REQUEST: VoiceReplyRequest = {
  purpose: "reply",
  language: "es",
  tools: true,
  messages: [{ role: "user", content: "hola" }],
};

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(frames: AsyncIterable<VoiceReplyFrame>): Promise<VoiceReplyFrame[]> {
  const out: VoiceReplyFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

test("the reply stream posts the request and parses frames split across chunks", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const frames = await collect(
    streamVoiceReply(REQUEST, new AbortController().signal, async (url, init) => {
      seen.push({ url, init });
      return new Response(
        sse([
          ": ping\n\n",
          'data: {"type":"delta","text":"Ho',
          'la"}\n\ndata: {"type":"tool_call","id":"c1","name":"check_tasks","args":{}}\n\n',
          'data: {"type":"done","model":"gpt-6.1-terra"}\n\ndata: {"type":"delta","text":"late"}\n\n',
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  assert.equal(seen[0]!.url, "/api/voice/reply");
  assert.equal(seen[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), REQUEST);
  assert.deepEqual(frames, [
    { type: "delta", text: "Hola" },
    { type: "tool_call", id: "c1", name: "check_tasks", args: {} },
    { type: "done", model: "gpt-6.1-terra" },
  ]);
});

test("a non-2xx response throws with the server's reason", async () => {
  await assert.rejects(
    collect(
      streamVoiceReply(REQUEST, new AbortController().signal, async () =>
        Response.json({ error: "over_budget" }, { status: 429 }),
      ),
    ),
    (error: unknown) => error instanceof VoiceReplyError && error.reason === "over_budget" && error.status === 429,
  );
  await assert.rejects(
    collect(streamVoiceReply(REQUEST, new AbortController().signal, async () => new Response("nope", { status: 502 }))),
    (error: unknown) => error instanceof VoiceReplyError && error.reason === "upstream_error",
  );
});

test("a stream that ends without a terminal frame is an upstream error", async () => {
  await assert.rejects(
    collect(
      streamVoiceReply(
        REQUEST,
        new AbortController().signal,
        async () => new Response(sse(['data: {"type":"delta","text":"a"}\n\n']), { status: 200 }),
      ),
    ),
    (error: unknown) => error instanceof VoiceReplyError && error.reason === "upstream_error",
  );
  assert.equal(parseSseEvent("data: {not json}"), null);
  assert.equal(parseSseEvent('data: {"type":"other"}'), null);
});

function session(threadRef: string, over: Partial<CoreSession> = {}): CoreSession {
  return { id: `s-${threadRef}`, type: "dm", scopeId: "personal:ana", threadRef, createdAt: 1, ...over };
}

function deps(sessions: CoreSession[], over: Partial<VoiceToolDeps> = {}) {
  const log: string[] = [];
  let settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, enabled: true };
  const base: VoiceToolDeps = {
    user: "ana@example.com",
    settings: () => settings,
    saveSettings: async (patch) => {
      settings = { ...settings, ...parseVoicePreferences({ ...settings, ...patch }) };
      log.push(`settings:${settings.language}:${settings.voice}`);
      return settings;
    },
    sessions: async () => sessions,
    titles: new Map(),
    startingTasks: () => new Map(),
    startTurn: async (body) => {
      log.push(`turn:${body.threadRef}:${body.text}:${body.idempotencyKey}`);
      return { runId: "run-1" };
    },
    tail: async () => ({ title: "Informe", reply: "Tres conclusiones.", failed: false }),
    approvals: async () => [{ requestId: "req-9", command: "send_mail" }],
    resolveApproval: async (decision) => void log.push(`approval:${decision.requestId}:${decision.approved}`),
    activeRun: async () => "run-7",
    abortRun: async (runId) => void log.push(`abort:${runId}`),
    open: (s) => void log.push(`open:${s.threadRef}`),
    delegated: (threadRef, title) => void log.push(`delegated:${threadRef}:${title}`),
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
    ...over,
  };
  return { deps: base, log };
}

test("delegate_task starts a real agent turn on a new web thread of the user", async () => {
  const { deps: d, log } = deps([]);
  const outcome = await runVoiceTool(
    { id: "c", name: "delegate_task", args: { instruction: "Resume el correo", title: "Resumen" } },
    d,
  );
  assert.deepEqual(JSON.parse(outcome.content), {
    ok: true,
    taskRef: "web:ana@example.com:voice:id1",
    title: "Resumen",
    state: "working",
  });
  assert.deepEqual(log, [
    "turn:web:ana@example.com:voice:id1:Resume el correo:id2",
    "delegated:web:ana@example.com:voice:id1:Resumen",
  ]);
  assert.ok(isVoiceThread("ana@example.com", "web:ana@example.com:voice:id1"));
  assert.ok(!isVoiceThread("ana@example.com", "web:ana@example.com:id1"));
  assert.ok(!isVoiceThread("ana@example.com", "web:bob@example.com:voice:id1"));
});

test("task tools resolve the taskRef against the user's sessions", async () => {
  const sessions = [
    session("web:ana:1", { working: true, title: "Informe" }),
    session("web:ana:2", { awaitingInput: true }),
  ];
  const { deps: d, log } = deps(sessions);
  const result = JSON.parse(
    (await runVoiceTool({ id: "c", name: "task_result", args: { taskRef: "web:ana:1" } }, d)).content,
  );
  assert.equal(result.result, "Tres conclusiones.");
  assert.equal(result.state, "working");
  const approve = await runVoiceTool({ id: "c", name: "approve_task", args: { taskRef: "web:ana:2" } }, d);
  const reject = await runVoiceTool({ id: "c", name: "reject_task", args: { taskRef: "web:ana:2" } }, d);
  assert.deepEqual(log, [], "approvals wait for the user's spoken confirmation");
  assert.equal(JSON.parse(approve.content).awaitingConfirmation, true);
  assert.deepEqual(
    { approved: approve.confirm?.approved, title: approve.confirm?.title, summary: approve.confirm?.summary },
    { approved: true, title: "Untitled", summary: "send_mail" },
  );
  assert.equal(reject.confirm?.approved, false);
  await approve.confirm!.execute();
  await reject.confirm!.execute();
  await runVoiceTool({ id: "c", name: "stop_task", args: { taskRef: "web:ana:1" } }, d);
  await runVoiceTool({ id: "c", name: "open_task", args: { taskRef: "web:ana:1" } }, d);
  assert.deepEqual(log, ["approval:req-9:true", "approval:req-9:false", "abort:run-7", "open:web:ana:1"]);
  const missing = await runVoiceTool({ id: "c", name: "open_task", args: { taskRef: "web:ana:404" } }, d);
  assert.equal(missing.isError, true);
  assert.equal(JSON.parse(missing.content).error, "task_not_found");
});

test("a confirmed approval resolves only the approval that was read back, and security holds stay on screen", async () => {
  let pending: PendingApproval[] = [{ requestId: "req-1", command: "read_calendar" }];
  const { deps: d, log } = deps([session("web:ana:2", { awaitingInput: true })], { approvals: async () => pending });
  const asked = await runVoiceTool({ id: "c", name: "approve_task", args: { taskRef: "web:ana:2" } }, d);
  pending = [{ requestId: "req-2", command: "send_mail" }];
  const changed = await asked.confirm!.execute();
  assert.deepEqual(JSON.parse(changed.content), { ok: false, error: "approval_changed" });
  assert.deepEqual(log, []);
  pending = [
    {
      requestId: "req-3",
      command: "x",
      securityHoldView: {} as NonNullable<PendingApproval["securityHoldView"]>,
    },
  ];
  const held = await runVoiceTool({ id: "c", name: "approve_task", args: { taskRef: "web:ana:2" } }, d);
  assert.deepEqual(JSON.parse(held.content), { ok: false, error: "security_hold_open_task" });
  assert.equal(held.confirm, undefined);
});

test("tool failures come back as errors the model can read", async () => {
  const { deps: d } = deps([session("web:ana:1")], {
    approvals: async () => [],
    activeRun: async () => null,
    startTurn: async () => {
      throw new Error("boom");
    },
  });
  const nothing = await runVoiceTool({ id: "c", name: "approve_task", args: { taskRef: "web:ana:1" } }, d);
  assert.equal(JSON.parse(nothing.content).error, "nothing_to_approve");
  const idle = await runVoiceTool({ id: "c", name: "stop_task", args: { taskRef: "web:ana:1" } }, d);
  assert.equal(JSON.parse(idle.content).error, "not_running");
  const thrown = await runVoiceTool({ id: "c", name: "delegate_task", args: { instruction: "x", title: "y" } }, d);
  assert.deepEqual(JSON.parse(thrown.content), { ok: false, error: "boom" });
});

test("task summaries put work needing the user first and skip subagents and archived threads", () => {
  const summaries = taskSummaries([
    session("web:ana:idle", { title: "Viejo", lastActivityAt: 5 }),
    session("web:ana:work", { working: true, title: "Informe", lastActivityAt: 1 }),
    session("web:ana:wait", { awaitingInput: true, title: "Correo", lastActivityAt: 2 }),
    session("agent:main:subagent:x", { working: true }),
    session("web:ana:gone", { archived: true, working: true }),
  ]);
  assert.deepEqual(summaries, [
    { taskRef: "web:ana:wait", title: "Correo", state: "awaiting_approval" },
    { taskRef: "web:ana:work", title: "Informe", state: "working" },
    { taskRef: "web:ana:idle", title: "Viejo", state: "idle" },
  ]);
});

test("task summaries carry the delegated title and never the task's output", () => {
  const titles = new Map([["web:ana:voice:1", "Resumen del correo"]]);
  const summaries = taskSummaries([session("web:ana:voice:1", { title: "Resume el último correo" })], titles);
  assert.deepEqual(summaries, [{ taskRef: "web:ana:voice:1", title: "Resumen del correo", state: "idle" }]);
});

test("a task that started before its session is listed still counts as running, until the list has it", () => {
  const titles = new Map([["web:ana:voice:new", "Resumir el README"]]);
  const starting = new Map([
    ["web:ana:voice:new", "working" as const],
    ["web:ana:voice:old", "working" as const],
    ["web:ana:voice:done", "idle" as const],
  ]);
  const summaries = taskSummaries(
    [session("web:ana:voice:old", { working: true, title: "Informe", lastActivityAt: 9 })],
    titles,
    starting,
  );
  assert.deepEqual(summaries, [
    { taskRef: "web:ana:voice:new", title: "Resumir el README", state: "working" },
    { taskRef: "web:ana:voice:old", title: "Informe", state: "working" },
  ]);
  assert.equal(taskSummaries([], new Map(), starting, 1).length, 1);
});

test("check_tasks reports a task that is starting before its session is listed", async () => {
  const { deps: d } = deps([], { startingTasks: () => new Map([["web:ana:voice:new", "working" as const]]) });
  const listed = await runVoiceTool({ id: "c", name: "check_tasks", args: {} }, d);
  assert.deepEqual(JSON.parse(listed.content).tasks, [{ taskRef: "web:ana:voice:new", title: "", state: "working" }]);
});

test("set_language and set_voice change the settings and validate their arguments strictly", async () => {
  const { deps: d, log } = deps([]);
  const english = await runVoiceTool({ id: "c", name: "set_language", args: { language: "en" } }, d);
  assert.deepEqual(JSON.parse(english.content), { ok: true, language: "en", voice: "4SZHfMpw-p46Ywgs" });
  const male = await runVoiceTool({ id: "c", name: "set_voice", args: { gender: "male" } }, d);
  assert.deepEqual(JSON.parse(male.content), { ok: true, voice: "LMDIYE0Oa377Qh6Z", label: "Easton (US)" });
  const next = await runVoiceTool({ id: "c", name: "set_voice", args: { next: true } }, d);
  assert.equal(JSON.parse(next.content).voice, "40QrMVgAxFiUnP9f");
  const again = await runVoiceTool({ id: "c", name: "set_voice", args: { gender: "male" } }, d);
  assert.equal(
    JSON.parse(again.content).voice,
    "d9XCyhjo4JhkHF1d",
    "asking for the same gender moves to another voice of it",
  );
  const named = await runVoiceTool({ id: "c", name: "set_voice", args: { voice: "nGzMHMPAWGaJFHOo" } }, d);
  assert.equal(JSON.parse(named.content).label, "Delia (US)");
  assert.deepEqual(log, [
    "settings:en:4SZHfMpw-p46Ywgs",
    "settings:en:LMDIYE0Oa377Qh6Z",
    "settings:en:40QrMVgAxFiUnP9f",
    "settings:en:d9XCyhjo4JhkHF1d",
    "settings:en:nGzMHMPAWGaJFHOo",
  ]);
  for (const args of [{ voice: "Z9" }, { gender: "robot" }, { next: false }, {}, { voice: "F1", next: true }])
    assert.equal(
      (await runVoiceTool({ id: "c", name: "set_voice", args } as never, d)).isError,
      true,
      JSON.stringify(args),
    );
  for (const args of [{ language: "fr" }, {}, { language: "es", extra: 1 }])
    assert.equal(
      (await runVoiceTool({ id: "c", name: "set_language", args } as never, d)).isError,
      true,
      JSON.stringify(args),
    );
  assert.equal(log.length, 5, "invalid calls never touch the settings");
});

test("set_voice on the fallback engine picks from the voices the model was offered and keeps the chosen engine", async () => {
  let stored: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, enabled: true };
  const runtime = () => runnableVoiceSettings(stored, false);
  const { deps: d } = deps([], {
    settings: runtime,
    saveSettings: async (patch) => {
      stored = { ...stored, ...parseVoicePreferences({ ...stored, ...patch }) };
      return runtime();
    },
  });
  assert.equal(runtime().ttsEngine, "supertonic-3");
  const named = await runVoiceTool({ id: "c", name: "set_voice", args: { voice: "M3" } }, d);
  assert.deepEqual(JSON.parse(named.content), { ok: true, voice: "M3", label: "Voz masculina 3" });
  const next = await runVoiceTool({ id: "c", name: "set_voice", args: { next: true } }, d);
  assert.equal(JSON.parse(next.content).voice, "M4");
  assert.equal(stored.ttsEngine, "phonon-40m");
  assert.equal(runnableVoiceSettings(stored, true).ttsEngine, "phonon-40m");
});

test("written frames pass through the stream and transcript entries are validated", async () => {
  const frames = await collect(
    streamVoiceReply(
      REQUEST,
      new AbortController().signal,
      async () =>
        new Response(
          sse(['data: {"type":"written","id":"e1","markdown":"**Hecho**"}\n\n', 'data: {"type":"done"}\n\n']),
          { status: 200 },
        ),
    ),
  );
  assert.deepEqual(frames[0], { type: "written", id: "e1", markdown: "**Hecho**" });
  assert.deepEqual(
    parseVoiceTranscript([
      { id: "a", role: "user", text: "hola", at: 1 },
      { id: "b", role: "assistant", text: "**hola**" },
      { id: "c", role: "system", text: "x", at: 2 },
      { role: "user", text: "sin id" },
      null,
    ]),
    [
      { id: "a", role: "user", text: "hola", at: 1 },
      { id: "b", role: "assistant", text: "**hola**", at: 0 },
    ],
  );
  assert.deepEqual(parseVoiceTranscript({ entries: [] }), []);
});

test("send_task_message continues the existing task thread and says whether it was queued", async () => {
  const { deps: d, log } = deps([session("web:ana@example.com:voice:t1"), session("web:ana@example.com:other")]);
  const sent = await runVoiceTool(
    { id: "c", name: "send_task_message", args: { taskRef: "web:ana@example.com:voice:t1", text: "  Añade Q4  " } },
    d,
  );
  assert.deepEqual(JSON.parse(sent.content), {
    ok: true,
    taskRef: "web:ana@example.com:voice:t1",
    status: "sent",
  });
  assert.deepEqual(log, ["turn:web:ana@example.com:voice:t1:Añade Q4:id1"]);
  const byId = await runVoiceTool(
    { id: "c", name: "send_task_message", args: { taskRef: "s-web:ana@example.com:other", text: "sigue" } },
    { ...d, startTurn: async () => ({ status: "queued", runId: "run-2", steered: true }) },
  );
  assert.deepEqual(JSON.parse(byId.content), { ok: true, taskRef: "web:ana@example.com:other", status: "queued" });
});

test("send_task_message refuses unknown tasks and empty messages", async () => {
  const { deps: d, log } = deps([session("web:ana@example.com:voice:t1")]);
  const unknown = await runVoiceTool(
    { id: "c", name: "send_task_message", args: { taskRef: "web:bob@example.com:x", text: "hola" } },
    d,
  );
  assert.equal(unknown.isError, true);
  assert.equal(JSON.parse(unknown.content).error, "task_not_found");
  const empty = await runVoiceTool(
    { id: "c", name: "send_task_message", args: { taskRef: "web:ana@example.com:voice:t1", text: "  " } },
    d,
  );
  assert.equal(empty.isError, true);
  assert.deepEqual(log, []);
});

test("ask_user waits for the person", async () => {
  const { deps: d } = deps([]);
  const outcome = await runVoiceTool({ id: "c", name: "ask_user", args: { question: "¿Qué trimestre?" } }, d);
  assert.deepEqual(JSON.parse(outcome.content), { ok: true, status: "waiting_for_user" });
  assert.equal(outcome.ask, true);
});

test("tools that act report what they did as activity taken from their real result", async () => {
  const sessions = [
    session("web:ana@example.com:voice:t1", { title: "Informe" }),
    session("web:ana:2", { awaitingInput: true, title: "Correo" }),
  ];
  const { deps: d } = deps(sessions);
  const delegated = await runVoiceTool(
    { id: "c", name: "delegate_task", args: { instruction: "Resume el correo", title: "Resumen" } },
    d,
  );
  assert.deepEqual(delegated.activity, {
    kind: "task_created",
    title: "Resumen",
    taskRef: "web:ana@example.com:voice:id1",
  });
  const sent = await runVoiceTool(
    { id: "c", name: "send_task_message", args: { taskRef: "web:ana@example.com:voice:t1", text: "sigue" } },
    d,
  );
  assert.deepEqual(sent.activity, { kind: "message_sent", title: "Informe", taskRef: "web:ana@example.com:voice:t1" });
  const asked = await runVoiceTool({ id: "c", name: "approve_task", args: { taskRef: "web:ana:2" } }, d);
  assert.equal(asked.activity, undefined, "asking for approval is not an approval");
  assert.deepEqual((await asked.confirm!.execute()).activity, {
    kind: "approved",
    title: "Correo",
    taskRef: "web:ana:2",
  });
  const rejected = await runVoiceTool({ id: "c", name: "reject_task", args: { taskRef: "web:ana:2" } }, d);
  assert.equal((await rejected.confirm!.execute()).activity, undefined);
  const failed = await runVoiceTool(
    { id: "c", name: "delegate_task", args: { instruction: "x", title: "y" } },
    { ...d, startTurn: async () => ({}) },
  );
  assert.equal(failed.activity, undefined);
});

test("activity names a delegated task by the title the voice agent gave it, not its first prompt", async () => {
  const sessions = [session("web:ana@example.com:voice:t1", { title: "Escribe un haiku original sobre el otoño…" })];
  const { deps: d } = deps(sessions, { titles: new Map([["web:ana@example.com:voice:t1", "Haiku de otoño"]]) });
  const sent = await runVoiceTool(
    { id: "c", name: "send_task_message", args: { taskRef: "web:ana@example.com:voice:t1", text: "que rime" } },
    d,
  );
  assert.equal(sent.activity?.title, "Haiku de otoño");
  const checked = await runVoiceTool({ id: "c", name: "check_tasks", args: {} }, d);
  assert.equal(JSON.parse(checked.content).tasks[0].title, "Haiku de otoño");
});

test("activity frames and stored activity are validated, and old entries without activity still load", () => {
  assert.deepEqual(
    parseSseEvent('data: {"type":"activity","activity":{"kind":"conversations_read","count":2,"extra":1}}'),
    { type: "activity", activity: { kind: "conversations_read", count: 2 } },
  );
  assert.equal(parseSseEvent('data: {"type":"activity","activity":{"kind":"hacked"}}'), null);
  assert.deepEqual(
    parseVoiceTranscript([
      { id: "a", role: "assistant", text: "Hecho", at: 1 },
      {
        id: "b",
        role: "assistant",
        text: "",
        at: 2,
        activity: [{ kind: "memory_saved" }, { kind: "nope" }, { kind: "approved", title: " Correo ", count: -1 }],
      },
    ]),
    [
      { id: "a", role: "assistant", text: "Hecho", at: 1 },
      {
        id: "b",
        role: "assistant",
        text: "",
        at: 2,
        activity: [{ kind: "memory_saved" }, { kind: "approved", title: "Correo" }],
      },
    ],
  );
});
