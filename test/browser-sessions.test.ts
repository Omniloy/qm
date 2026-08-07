import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createLiveBrowserSessionStore,
  type StoredLiveBrowserSession,
} from "../src/connectors/browser-live-session-store.ts";
import { browserSessionRoutes } from "../src/api/routes/browser-sessions.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { scopeId } from "../src/types.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";

const NOW = 1_800_000_000_000;
const KEY = deriveConnectorKey("browser-sessions-test");
const ADA = "ada@example.com";

const store = () => createLiveBrowserSessionStore({ sessions: createMemoryMap<StoredLiveBrowserSession>(), key: KEY });

const LIVE = "https://live.anchorbrowser.io/inspector.html?sessionId=s1&rt=abc";

const session = (over: Record<string, unknown> = {}) => ({
  principalId: ADA,
  provider: "anchor",
  sessionId: "s1",
  threadRef: "dm:ada:t1",
  liveViewUrl: LIVE,
  controlMode: "agent" as const,
  expiresAt: NOW + 30 * 60_000,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

/* ------------------------------------------------------------------ store */

test("the live-view URL is encrypted at rest, because it is bearer material", async () => {
  const map = createMemoryMap<StoredLiveBrowserSession>();
  const s = createLiveBrowserSessionStore({ sessions: map, key: KEY });
  await s.put(session());

  const raw = JSON.stringify(await map.get(ADA));
  assert.doesNotMatch(raw, /inspector\.html/, "the raw record must not carry the URL in the clear");
  assert.equal((await s.get(ADA, NOW))?.liveViewUrl, LIVE, "but its owner still reads it back");
});

test("an expired browser is gone rather than stale", async () => {
  // The provider caps sessions at 30 minutes. Serving one past its expiry
  // would render a pane onto a browser that no longer exists.
  const s = store();
  await s.put(session({ expiresAt: NOW - 1 }));
  assert.equal(await s.get(ADA, NOW), null);
  assert.equal(await s.get(ADA, NOW), null, "and it is not resurrected on a second read");
});

test("handing control back clears the marker, so the flag answers 'right now'", async () => {
  const s = store();
  await s.put(session());

  const taken = await s.setControl(ADA, "human_control", NOW + 1000);
  assert.equal(taken?.controlMode, "human_control");
  assert.equal(taken?.handedOffAt, NOW + 1000);

  const given = await s.setControl(ADA, "agent", NOW + 2000);
  assert.equal(given?.controlMode, "agent");
  assert.equal(given?.handedOffAt, undefined, "a stale timestamp would read as a person still holding it");
});

test("there is nothing to hand over when no browser is open", async () => {
  assert.equal(await store().setControl(ADA, "human_control", NOW), null);
});

/* ----------------------------------------------------------------- routes */

const route = (method: string, path: string) =>
  browserSessionRoutes.find((r) => "path" in r && r.path === path && r.method === method)!;

function ctx(over: Partial<ApiCtx> & { deps?: unknown } = {}): { ctx: ApiCtx; sent: { status: number; body: any }[] } {
  const sent: { status: number; body: any }[] = [];
  const res = {
    writeHead() {
      return res;
    },
    end(payload: string) {
      const last = sent[sent.length - 1];
      if (last) last.body = payload ? JSON.parse(payload) : {};
    },
    setHeader() {},
  } as unknown as ApiCtx["res"];
  const base = {
    res: new Proxy(res, {
      get(t, k) {
        if (k === "writeHead")
          return (status: number) => {
            sent.push({ status, body: {} });
            return t;
          };
        return (t as any)[k];
      },
    }),
    body: {},
    capability: null,
    params: {},
    deps: {},
  } as unknown as ApiCtx;
  return { ctx: Object.assign(base, over) as ApiCtx, sent };
}

const cap = (over: Record<string, unknown> = {}) => ({
  actorId: ADA,
  scopeId: scopeId("personal", ADA),
  threadRef: "dm:ada:t1",
  liveActor: true,
  ...over,
});

test("an unattended run cannot open a browser", async () => {
  // A cron or a webhook has nobody at the keyboard. Opening a browser that
  // stays logged in as a person is their decision, and this refuses before it
  // reads anything.
  const s = store();
  const { ctx: c, sent } = ctx({
    deps: { liveBrowserSessions: s } as never,
    capability: cap({ triggered: true }) as never,
    body: { provider: "anchor", sessionId: "s1", liveViewUrl: LIVE, expiresAt: NOW + 60_000 },
  });
  await route("POST", "/v1/browser-sessions").handle(c);
  assert.equal(sent[0]?.status, 403);
  assert.match(sent[0]?.body.message, /person's decision/);
  assert.equal(await s.get(ADA, NOW), null, "nothing was recorded");
});

test("a browser cannot be registered against a room", async () => {
  const s = store();
  const { ctx: c, sent } = ctx({
    deps: { liveBrowserSessions: s } as never,
    capability: cap({ scopeId: scopeId("channel", "C1") }) as never,
    body: { provider: "anchor", sessionId: "s1", liveViewUrl: LIVE, expiresAt: NOW + 60_000 },
  });
  await route("POST", "/v1/browser-sessions").handle(c);
  assert.equal(sent[0]?.status, 403);
  assert.match(sent[0]?.body.message, /one person, not to a room/);
});

test("the CDP URL is refused where the viewer URL belongs", async () => {
  // Anchor embeds the API key in cdp_url in plaintext, and this value is
  // handed to a browser tab. Mixing them up would leak the key to the DOM.
  const s = store();
  const { ctx: c, sent } = ctx({
    deps: { liveBrowserSessions: s } as never,
    capability: cap() as never,
    body: {
      provider: "anchor",
      sessionId: "s1",
      liveViewUrl: "wss://connect.anchorbrowser.io?apiKey=sk-secret&sessionId=s1",
      expiresAt: NOW + 60_000,
    },
  });
  await route("POST", "/v1/browser-sessions").handle(c);
  assert.equal(sent[0]?.status, 400);
  assert.match(sent[0]?.body.message, /not the CDP URL/);
});

test("the thread comes from the token, so a turn cannot attach a browser elsewhere", async () => {
  const s = store();
  const { ctx: c, sent } = ctx({
    deps: { liveBrowserSessions: s, auditLog: { record: () => undefined } } as never,
    capability: cap({ threadRef: "dm:ada:real" }) as never,
    body: {
      provider: "anchor",
      sessionId: "s1",
      liveViewUrl: LIVE,
      expiresAt: NOW + 60_000,
      threadRef: "dm:someone-else:t9",
    },
  });
  await route("POST", "/v1/browser-sessions").handle(c);
  assert.equal(sent[0]?.status, 200);
  assert.equal(sent[0]?.body.session.threadRef, "dm:ada:real", "the body's threadRef is ignored");
});

test("the agent cannot take the wheel from the person holding it", async () => {
  const s = store();
  await s.put(session());
  const { ctx: c, sent } = ctx({
    deps: { liveBrowserSessions: s } as never,
    capability: cap({ liveActor: false }) as never,
    params: { id: "s1" },
    body: { mode: "human_control" },
  });
  await route("POST", "/v1/browser-sessions/:id/handoff").handle(c);
  assert.equal(sent[0]?.status, 403);
  assert.match(sent[0]?.body.message, /handed over by the person/);
});

test("handing over a browser that already ended says so, rather than 404", async () => {
  const s = store();
  const { ctx: c, sent } = ctx({
    deps: { liveBrowserSessions: s } as never,
    capability: cap() as never,
    params: { id: "s1" },
    body: { mode: "human_control" },
  });
  await route("POST", "/v1/browser-sessions/:id/handoff").handle(c);
  assert.equal(sent[0]?.status, 409);
  assert.match(sent[0]?.body.message, /already ended/);
});

test("no browser is a state, not an error", async () => {
  // The pane must be able to ask without treating absence as a failure.
  const { ctx: c, sent } = ctx({ deps: { liveBrowserSessions: store() } as never, capability: cap() as never });
  await route("GET", "/v1/browser-sessions/current").handle(c);
  assert.equal(sent[0]?.status, 200);
  assert.equal(sent[0]?.body.session, null);
});

test("ending a browser twice is not an error", async () => {
  const s = store();
  await s.put(session());
  const run = async () => {
    const { ctx: c, sent } = ctx({
      deps: { liveBrowserSessions: s, auditLog: { record: () => undefined } } as never,
      capability: cap() as never,
      params: { id: "s1" },
    });
    await route("DELETE", "/v1/browser-sessions/:id").handle(c);
    return sent[0]?.status;
  };
  assert.equal(await run(), 200);
  assert.equal(await run(), 200, "the skill's cleanup and a person's click can race");
});

test("state is cheap and carries no secret", async () => {
  // The runner polls this between every step, so it must not mint a URL.
  const s = store();
  await s.put(session());
  const { ctx: c, sent } = ctx({
    deps: { liveBrowserSessions: s } as never,
    capability: cap() as never,
    params: { id: "s1" },
  });
  await route("GET", "/v1/browser-sessions/:id/state").handle(c);
  assert.equal(sent[0]?.status, 200);
  assert.equal(sent[0]?.body.controlMode, "agent");
  assert.equal(sent[0]?.body.liveViewUrl, undefined);
});
