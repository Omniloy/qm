import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession, PendingApproval } from "../src/core-bridge.ts";
import { VoiceReplyError, parseSseEvent, streamVoiceReply } from "../src/voice-assistant/llm.ts";
import type { VoiceReplyFrame, VoiceReplyRequest } from "../src/voice-assistant/protocol.ts";
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
  const base: VoiceToolDeps = {
    user: "ana@example.com",
    sessions: async () => sessions,
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
    delegated: () => void log.push("delegated"),
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
  assert.deepEqual(log, ["turn:web:ana@example.com:voice:id1:Resume el correo:id2", "delegated"]);
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
