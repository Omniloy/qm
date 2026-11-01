import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import {
  createAnnouncer,
  fallbackAnnouncement,
  type Announcement,
  type AnnouncerDeps,
} from "../src/voice-assistant/announcer.ts";
import type { AnnounceScope, VoiceReplyFrame, VoiceReplyRequest } from "../src/voice-assistant/protocol.ts";

function session(threadRef: string, over: Partial<CoreSession> = {}): CoreSession {
  return {
    id: `s-${threadRef}`,
    type: "dm",
    scopeId: "personal:ana",
    threadRef,
    createdAt: 1,
    title: `Tarea ${threadRef}`,
    ...over,
  };
}

function setup(
  options: {
    sessions?: CoreSession[];
    scope?: AnnounceScope;
    voiceThreads?: string[];
    foreground?: string | null;
    summary?: VoiceReplyFrame[] | Error;
    failed?: boolean;
    titles?: Record<string, string>;
  } = {},
) {
  let sessions = options.sessions ?? [];
  const delivered: Announcement[] = [];
  const requests: VoiceReplyRequest[] = [];
  const deps: AnnouncerDeps = {
    scope: () => options.scope ?? "all",
    language: () => "es",
    isVoiceThread: (threadRef) => (options.voiceThreads ?? []).includes(threadRef),
    foregroundThread: () => options.foreground ?? null,
    sessions: async () => sessions,
    tail: async () => ({
      title: null,
      reply: "El informe está listo con tres conclusiones.",
      failed: options.failed === true,
    }),
    pendingApproval: async () => "Enviar un correo a Laura",
    async *summarize(request) {
      requests.push(request);
      const summary = options.summary ?? [
        { type: "delta", text: "Listo: informe. " },
        { type: "delta", text: "Tiene tres conclusiones." },
        { type: "done" },
      ];
      if (summary instanceof Error) throw summary;
      for (const frame of summary) yield frame;
    },
    title: (threadRef) => options.titles?.[threadRef],
    deliver: (announcement) => void delivered.push(announcement),
  };
  const announcer = createAnnouncer(deps);
  return {
    announcer,
    delivered,
    requests,
    setSessions: (next: CoreSession[]) => {
      sessions = next;
    },
  };
}

const at = 1_700_000_000_000;

test("a thread going from working to idle is summarised and announced", async () => {
  const t = setup({ sessions: [session("web:ana:1", { working: true })] });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:1", sessionId: "s-web:ana:1", state: "idle", at });
  await t.announcer.settled();
  assert.deepEqual(t.delivered, [
    {
      threadRef: "web:ana:1",
      kind: "done",
      title: "Tarea web:ana:1",
      text: "Listo: informe. Tiene tres conclusiones.",
      detail: "El informe está listo con tres conclusiones.",
    },
  ]);
  const request = t.requests[0]!;
  assert.equal(request.purpose, "announce");
  assert.equal(request.tools, false);
  assert.equal(request.messages[0]!.role, "user");
  assert.match(request.messages[0]!.content, /Tarea: Tarea web:ana:1\nEstado: terminada/);
  assert.match(request.messages[0]!.content, /tres conclusiones/);
});

test("idle without a prior working state, metadata frames and repeats are not announced", async () => {
  const t = setup({ sessions: [session("web:ana:1")] });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:1", state: "idle", at });
  t.announcer.handle({ threadRef: "web:ana:1", state: "metadata", at });
  t.announcer.handle({ threadRef: "web:ana:1", state: "working", at });
  t.announcer.handle({ threadRef: "web:ana:1", state: "idle", at });
  t.announcer.handle({ threadRef: "web:ana:1", state: "idle", at });
  await t.announcer.settled();
  assert.equal(t.delivered.length, 1);
});

test("a task waiting on approval is announced with what it wants to do", async () => {
  const t = setup({ sessions: [session("web:ana:2", { working: true })] });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:2", state: "awaiting_approval", at });
  await t.announcer.settled();
  assert.equal(t.delivered[0]!.kind, "approval");
  assert.match(t.requests[0]!.messages[0]!.content, /Estado: espera aprobación\n\nEnviar un correo a Laura/);
});

test("a failed run is announced as not finished", async () => {
  const t = setup({ sessions: [session("web:ana:3", { working: true })], failed: true });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:3", state: "idle", at });
  await t.announcer.settled();
  assert.equal(t.delivered[0]!.kind, "failed");
});

test("the voice-only scope announces only threads the voice assistant started", async () => {
  const t = setup({
    scope: "voice",
    voiceThreads: ["web:ana:voz"],
    sessions: [session("web:ana:voz", { working: true }), session("web:ana:otra", { working: true })],
  });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:otra", state: "idle", at });
  t.announcer.handle({ threadRef: "web:ana:voz", state: "idle", at });
  await t.announcer.settled();
  assert.deepEqual(
    t.delivered.map((a) => a.threadRef),
    ["web:ana:voz"],
  );
});

test("subagent threads and the conversation on screen stay silent", async () => {
  const t = setup({
    foreground: "web:ana:visible",
    sessions: [session("agent:main:subagent:x", { working: true }), session("web:ana:visible", { working: true })],
  });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "agent:main:subagent:x", state: "idle", at });
  t.announcer.handle({ threadRef: "web:ana:visible", state: "idle", at });
  await t.announcer.settled();
  assert.deepEqual(t.delivered, []);
});

test("a resync announces tasks that finished while the stream was down", async () => {
  const t = setup({ sessions: [session("web:ana:1", { working: true }), session("web:ana:2", { working: true })] });
  await t.announcer.start();
  t.setSessions([session("web:ana:1", { working: false }), session("web:ana:2", { working: true })]);
  await t.announcer.resync();
  await t.announcer.settled();
  assert.deepEqual(
    t.delivered.map((a) => a.threadRef),
    ["web:ana:1"],
  );
  await t.announcer.resync();
  await t.announcer.settled();
  assert.equal(t.delivered.length, 1, "a second resync with no change says nothing");
});

test("a failed summary falls back to a plain sentence", async () => {
  const t = setup({ sessions: [session("web:ana:1", { working: true })], summary: new Error("upstream_error") });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:1", state: "idle", at });
  await t.announcer.settled();
  assert.equal(t.delivered[0]!.text, "Listo: Tarea web:ana:1.");
  assert.equal(fallbackAnnouncement("approval", "Correo", "en"), "Correo needs your approval.");
  assert.equal(
    fallbackAnnouncement("done", "Responde con un saludo: hola.", "es"),
    "Listo: Responde con un saludo: hola.",
  );
  assert.equal(fallbackAnnouncement("failed", "Informe Q3?!", "en"), "Could not finish: Informe Q3.");
});

test("nothing is delivered after dispose", async () => {
  const t = setup({ sessions: [session("web:ana:1", { working: true })] });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:1", state: "idle", at });
  t.announcer.dispose();
  await t.announcer.settled();
  assert.deepEqual(t.delivered, []);
});

test("a task started by voice is announced under the title the assistant gave it", async () => {
  const t = setup({
    sessions: [session("web:ana:voice:1", { working: true })],
    titles: { "web:ana:voice:1": "Resumen del correo" },
  });
  await t.announcer.start();
  t.announcer.handle({ threadRef: "web:ana:voice:1", sessionId: "s-web:ana:voice:1", state: "idle", at });
  await t.announcer.settled();
  assert.equal(t.delivered[0]!.title, "Resumen del correo");
  assert.match(t.requests[0]!.messages[0]!.content, /Tarea: Resumen del correo\n/);
});
