import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import {
  BLOB_TRANSFER_AUD,
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  SECRET_DROP_AUD,
  mintCapabilityToken,
  verifyCapabilityToken,
  type CapabilityClaims,
} from "../src/auth/capability-token.ts";
import { BROWSER_RELAY_AUD, BROWSER_RELAY_CDP_AUD, attachBrowserRelay } from "../src/browser-relay/server.ts";
import { browserRelayRoutes } from "../src/api/routes/browser-relay.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { personalScope, type ScopeId } from "../src/types.ts";

const SECRET = "relay-test-secret";
const ALICE = "alice";
const hour = () => Date.now() + 60 * 60_000;

function mint(claims: Partial<CapabilityClaims>): Promise<string> {
  return mintCapabilityToken({ actorId: ALICE, scopeId: personalScope(ALICE), exp: hour(), ...claims }, SECRET);
}

const cdpToken = () => mint({ aud: BROWSER_RELAY_CDP_AUD, liveActor: true });

async function relayServer(
  authorizesScope?: (c: CapabilityClaims) => Promise<boolean>,
  stillChosen?: (actorId: string) => Promise<boolean>,
): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer();
  attachBrowserRelay(server, {
    capabilitySecret: SECRET,
    ...(authorizesScope ? { authorizesScope } : {}),
    ...(stillChosen ? { stillChosen } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function dial(url: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(0));
  });
}

test("the CDP leg opens only for the dedicated live, personal, untriggered relay token", async () => {
  const { server, url } = await relayServer();
  try {
    const cdp = (t: string) => dial(`${url}/v1/browser-relay/cdp?t=${encodeURIComponent(t)}`);
    assert.equal(await cdp(await cdpToken()), "open");

    const rejected: Record<string, Partial<CapabilityClaims>> = {
      "a DM turn's control-plane token": { aud: CONTROL_PLANE_AUD, liveActor: true },
      "a portal session capability": { liveActor: true },
      "a pairing token": { aud: BROWSER_RELAY_AUD },
      "a secret-drop link token": { aud: SECRET_DROP_AUD, drop: "d1" },
      "a blob transfer token": { aud: BLOB_TRANSFER_AUD, blob: { dir: "read" } },
      "a deployed app's credential token": {
        aud: CREDENTIAL_BROKER_AUD,
        deployment: "app1",
        exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
      },
      "a relay token from a channel turn": {
        aud: BROWSER_RELAY_CDP_AUD,
        liveActor: true,
        scopeId: "channel:C1" as ScopeId,
      },
      "a relay token from a cron turn": { aud: BROWSER_RELAY_CDP_AUD, liveActor: true, triggered: true },
      "a relay token from a steered, non-live turn": { aud: BROWSER_RELAY_CDP_AUD },
      "a relay token for someone else's personal scope": {
        aud: BROWSER_RELAY_CDP_AUD,
        liveActor: true,
        scopeId: personalScope("bob"),
      },
      "a relay token from a deployed app": { aud: BROWSER_RELAY_CDP_AUD, liveActor: true, deployment: "app1" },
      "an expired relay token": { aud: BROWSER_RELAY_CDP_AUD, liveActor: true, exp: Date.now() - 1 },
    };
    for (const [label, claims] of Object.entries(rejected)) {
      assert.equal(await cdp(await mint(claims)), 401, label);
    }
    assert.equal(await dial(`${url}/v1/browser-relay/cdp`), 401, "no token at all");
  } finally {
    server.close();
  }
});

test("the CDP leg re-checks the scope with the core authorizer", async () => {
  const seen: CapabilityClaims[] = [];
  const { server, url } = await relayServer(async (c) => {
    seen.push(c);
    return false;
  });
  try {
    assert.equal(await dial(`${url}/v1/browser-relay/cdp?t=${await cdpToken()}`), 401);
    assert.equal(seen[0]?.actorId, ALICE);
  } finally {
    server.close();
  }
});

test("a turn's relay key stops working once the person stops or switches browsers", async () => {
  let chosen = true;
  const asked: string[] = [];
  const { server, url } = await relayServer(undefined, async (actorId) => {
    asked.push(actorId);
    return chosen;
  });
  try {
    const key = await cdpToken();
    assert.equal(await dial(`${url}/v1/browser-relay/cdp?t=${key}`), "open");
    chosen = false;
    assert.equal(await dial(`${url}/v1/browser-relay/cdp?t=${key}`), 401, "the same key, an hour from expiry");
    assert.deepEqual(asked, [ALICE, ALICE]);
    assert.equal(
      await dial(`${url}/v1/browser-relay/extension?t=${await mint({ aud: BROWSER_RELAY_AUD })}`),
      "open",
      "the extension itself can still connect, so Share this tab can turn it back on",
    );
  } finally {
    server.close();
  }
});

test("the extension learns QM's own address as soon as it connects", async () => {
  const server = createServer();
  attachBrowserRelay(server, { capabilitySecret: SECRET, appUrl: "https://qm.example.com" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ws = new WebSocket(`${url}/v1/browser-relay/extension?t=${await mint({ aud: BROWSER_RELAY_AUD })}`);
    const first = await new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(String(data)));
      ws.once("error", reject);
    });
    ws.close();
    assert.deepEqual(JSON.parse(first), { qm: "origins", app: "https://qm.example.com" });
  } finally {
    server.close();
  }
});

test("the extension leg takes only a pairing token", async () => {
  const { server, url } = await relayServer();
  try {
    const ext = async (t: string) => dial(`${url}/v1/browser-relay/extension?t=${encodeURIComponent(t)}`);
    assert.equal(await ext(await mint({ aud: BROWSER_RELAY_AUD })), "open");
    assert.equal(await ext(await cdpToken()), 401);
    assert.equal(await ext(await mint({ aud: CONTROL_PLANE_AUD, liveActor: true })), 401);
  } finally {
    server.close();
  }
});

const DAY = 24 * 60 * 60_000;

const listening = new Set<WebSocket>();

function hangUp(server: Server): void {
  for (const ws of listening) ws.terminate();
  listening.clear();
  server.close();
}

function listen(url: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    listening.add(ws);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    ws.once("open", () => resolve({ ws, frames }));
    ws.once("error", reject);
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const stop = performance.now() + ms;
  while (performance.now() < stop) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

const settle = () => new Promise((r) => setTimeout(r, 100));
const renewals = (frames: Array<Record<string, unknown>>) => frames.filter((f) => f.qm === "token");
const pairing = (expiresIn: number) => mint({ aud: BROWSER_RELAY_AUD, exp: Date.now() + expiresIn });

const HOUR = 60 * 60_000;

test("a pairing token over a day old is swapped for a fresh one for the same person", async () => {
  const { server, url } = await relayServer();
  try {
    const agent = await listen(`${url}/v1/browser-relay/cdp?t=${await cdpToken()}`);
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairing(20 * DAY)}`);
    assert.ok(await until(() => renewals(ext.frames).length > 0), "the extension is handed a fresh token");

    const token = String(renewals(ext.frames)[0]!.token);
    const fresh = await verifyCapabilityToken(token, SECRET);
    assert.equal(fresh?.actorId, ALICE);
    assert.equal(fresh?.aud, BROWSER_RELAY_AUD);
    assert.equal(fresh?.scopeId, personalScope(ALICE));
    assert.ok(fresh!.exp > Date.now() + 29 * DAY, "good for another 30 days");
    assert.equal(await dial(`${url}/v1/browser-relay/cdp?t=${encodeURIComponent(token)}`), 401, "not an agent key");
    assert.deepEqual(agent.frames, [], "the agent's side never sees it");
  } finally {
    hangUp(server);
  }
});

test("a pairing token under a day old is not renewed, and the agent's key never is", async () => {
  const { server, url } = await relayServer();
  try {
    const young = await listen(`${url}/v1/browser-relay/extension?t=${await pairing(30 * DAY - HOUR)}`);
    const agent = await listen(`${url}/v1/browser-relay/cdp?t=${await cdpToken()}`);
    young.ws.pong();
    agent.ws.pong();
    agent.ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));

    const bobToken = await mint({
      actorId: "bob",
      scopeId: personalScope("bob"),
      aud: BROWSER_RELAY_AUD,
      exp: Date.now() + 10 * DAY,
    });
    const bob = await listen(`${url}/v1/browser-relay/extension?t=${bobToken}`);
    assert.ok(await until(() => renewals(bob.frames).length > 0), "an older token on the same relay is renewed");
    await settle();

    assert.deepEqual(renewals(young.frames), [], "a token minted within the day is left alone");
    assert.deepEqual(renewals(agent.frames), [], "the agent's hour-long key is never answered with a pairing token");
  } finally {
    hangUp(server);
  }
});

test("a connection that stays up is renewed once a day on its keepalive, one token per day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { server, url } = await relayServer();
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairing(30 * DAY - HOUR)}`);
    ext.ws.pong();
    await settle();
    assert.deepEqual(renewals(ext.frames), [], "minted within the day");

    t.mock.timers.tick(DAY);
    for (let i = 0; i < 10; i++) ext.ws.send(JSON.stringify({ qm: "ping" }));
    assert.ok(await until(() => renewals(ext.frames).length > 0), "renewed without reconnecting");
    await settle();
    assert.equal(renewals(ext.frames).length, 1, "a burst of keepalives mints one token, not one each");
    const fresh = await verifyCapabilityToken(String(renewals(ext.frames)[0]!.token), SECRET);
    assert.ok(fresh!.exp > Date.now() + 29 * DAY);

    t.mock.timers.tick(DAY + HOUR);
    ext.ws.pong();
    assert.ok(await until(() => renewals(ext.frames).length === 2), "and again on a pong the next day");
  } finally {
    hangUp(server);
  }
});

test("a connection whose token ran out while it stayed open is not renewed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { server, url } = await relayServer();
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairing(30 * DAY - HOUR)}`);
    t.mock.timers.tick(31 * DAY);
    ext.ws.pong();
    ext.ws.send(JSON.stringify({ qm: "ping" }));
    await settle();
    assert.deepEqual(renewals(ext.frames), []);
  } finally {
    hangUp(server);
  }
});

function pairingCtx(over: { capability?: CapabilityClaims; actor?: { p: string } }) {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return this;
    },
    end(data?: string) {
      out.body = data ? JSON.parse(data) : undefined;
    },
  };
  const ctx = {
    res,
    deps: { capabilitySecret: SECRET, auditLog: { record: () => undefined } },
    ...over,
  } as unknown as ApiCtx;
  return { ctx, out };
}

const pair = browserRelayRoutes[0]!;

async function claims(c: Partial<CapabilityClaims>): Promise<CapabilityClaims> {
  return (await verifyCapabilityToken(await mint(c), SECRET))!;
}

test("pairing is minted only for a portal identity, never from any capability token", async () => {
  const portal = pairingCtx({ actor: { p: ALICE } });
  await pair.handle(portal.ctx);
  assert.equal(portal.out.status, 200);
  const minted = await verifyCapabilityToken((portal.out.body as { token: string }).token, SECRET);
  assert.equal(minted?.aud, BROWSER_RELAY_AUD);
  assert.equal(minted?.actorId, ALICE);
  assert.equal(minted?.scopeId, personalScope(ALICE));
  assert.ok(minted!.exp > Date.now() + 29 * DAY);
  assert.equal(pair.auth, "source");

  const refused: Record<string, Partial<CapabilityClaims>> = {
    "the agent's own live personal turn": { aud: CONTROL_PLANE_AUD, liveActor: true },
    "a web session capability": { liveActor: true },
  };
  for (const [label, c] of Object.entries(refused)) {
    const r = pairingCtx({ capability: await claims(c) });
    await pair.handle(r.ctx);
    assert.equal(r.out.status, 403, label);
  }
});
