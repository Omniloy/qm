import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
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
import {
  BROWSER_RELAY_AUD,
  BROWSER_RELAY_CDP_AUD,
  PAIRING_REVOKED,
  attachBrowserRelay,
  type BrowserRelayOptions,
} from "../src/browser-relay/server.ts";
import { createRelayHub } from "../src/browser-relay/relay.ts";
import { browserRelayRoutes } from "../src/api/routes/browser-relay.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { personalScope, type ScopeId } from "../src/types.ts";

const SECRET = "relay-test-secret";
const ALICE = "alice";
const hour = () => Date.now() + 60 * 60_000;

function mint(claims: Partial<CapabilityClaims>): Promise<string> {
  return mintCapabilityToken({ actorId: ALICE, scopeId: personalScope(ALICE), exp: hour(), ...claims }, SECRET);
}

const cdpToken = () => mint({ aud: BROWSER_RELAY_CDP_AUD, liveActor: true });

async function relayServer(opts: Omit<BrowserRelayOptions, "capabilitySecret"> = {}): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer();
  attachBrowserRelay(server, { capabilitySecret: SECRET, ...opts });
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
  const { server, url } = await relayServer({
    authorizesScope: async (c) => {
      seen.push(c);
      return false;
    },
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
  const { server, url } = await relayServer({
    stillChosen: async (actorId) => {
      asked.push(actorId);
      return chosen;
    },
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
const RECHECK = 20;

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

test("a connection that stays up is renewed once a day by its periodic check, one token per day", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { server, url } = await relayServer({ pairingRecheckMs: RECHECK });
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairing(30 * DAY - HOUR)}`);
    await settle();
    assert.deepEqual(renewals(ext.frames), [], "minted within the day");

    t.mock.timers.tick(DAY);
    assert.ok(await until(() => renewals(ext.frames).length > 0), "renewed without reconnecting");
    await settle();
    assert.equal(renewals(ext.frames).length, 1, "the checks after it mint nothing more that day");
    const fresh = await verifyCapabilityToken(String(renewals(ext.frames)[0]!.token), SECRET);
    assert.ok(fresh!.exp > Date.now() + 29 * DAY);

    t.mock.timers.tick(DAY + HOUR);
    assert.ok(await until(() => renewals(ext.frames).length === 2), "and again the next day");
  } finally {
    hangUp(server);
  }
});

test("a connection whose token ran out while it stayed open is not renewed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { server, url } = await relayServer({ pairingRecheckMs: RECHECK });
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairing(30 * DAY - HOUR)}`);
    t.mock.timers.tick(31 * DAY);
    await settle();
    assert.deepEqual(renewals(ext.frames), []);
  } finally {
    hangUp(server);
  }
});

function pairingCtx(
  over: { capability?: CapabilityClaims; actor?: { p: string; imp?: string } },
  deps: Record<string, unknown> = {},
) {
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
    deps: {
      capabilitySecret: SECRET,
      auditLog: { record: () => undefined },
      config: createMemoryConfigStore("org"),
      ...deps,
    },
    ...over,
  } as unknown as ApiCtx;
  return { ctx, out };
}

const routeAt = (path: string) => browserRelayRoutes.find((route) => "path" in route && route.path === path)!;
const pair = routeAt("/v1/browser-relay/pairing");
const disconnect = routeAt("/v1/browser-relay/disconnect");

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
  assert.equal(minted?.pairingGeneration, 1, "a first pairing retires every token from before generations");
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

const pairingAt = (generation: number | undefined, expiresIn = 30 * DAY - HOUR) =>
  mint({
    aud: BROWSER_RELAY_AUD,
    exp: Date.now() + expiresIn,
    ...(generation === undefined ? {} : { pairingGeneration: generation }),
  });

function closeOf(ws: WebSocket, ms = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const open = setTimeout(() => resolve({ code: 0, reason: "still open" }), ms);
    ws.once("close", (code, reason) => {
      clearTimeout(open);
      resolve({ code, reason: String(reason) });
    });
  });
}

test("a pairing token from before the person's latest pairing is refused at connect", async () => {
  let current = 2;
  const { server, url } = await relayServer({ pairingGeneration: async () => current });
  try {
    const ext = async (t: string) => dial(`${url}/v1/browser-relay/extension?t=${encodeURIComponent(t)}`);
    assert.equal(await ext(await pairingAt(2)), "open");
    assert.equal(await ext(await pairingAt(1, 10 * DAY)), 401, "an older pairing, even one due for renewal");
    assert.equal(await ext(await pairingAt(undefined)), 401, "a token from before generations is generation 0");
    current = 3;
    assert.equal(await ext(await pairingAt(2)), 401, "the same token once the person pairs again");
  } finally {
    server.close();
  }
});

test("a token from before pairings had generations still connects, and is renewed as generation 0", async () => {
  const audits: AuditEvent[] = [];
  const { server, url } = await relayServer({
    pairingGeneration: async () => 0,
    auditLog: { record: (e) => audits.push(e) },
  });
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairingAt(undefined, 20 * DAY)}`);
    assert.ok(await until(() => renewals(ext.frames).length > 0), "nobody has to download the extension again");
    const fresh = await verifyCapabilityToken(String(renewals(ext.frames)[0]!.token), SECRET);
    assert.equal(fresh?.pairingGeneration, 0);
    assert.deepEqual(
      audits.map((a) => [a.action, a.principalId, a.scopeLabel, a.detail]),
      [["browser-relay.renew", ALICE, personalScope(ALICE), "pairing generation 0"]],
      "every renewal leaves an audit row",
    );
  } finally {
    hangUp(server);
  }
});

test("an open connection whose pairing was replaced is closed by its next check, never renewed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let current = 1;
  const audits: AuditEvent[] = [];
  const { server, url } = await relayServer({
    pairingGeneration: async () => current,
    auditLog: { record: (e) => audits.push(e) },
    pairingRecheckMs: RECHECK,
  });
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairingAt(1)}`);
    const closed = closeOf(ext.ws);
    await settle();
    current = 2;
    t.mock.timers.tick(DAY);
    assert.deepEqual(await closed, { code: 1008, reason: PAIRING_REVOKED });
    assert.deepEqual(renewals(ext.frames), [], "the renewal it was due is never sent");
    assert.deepEqual(audits, []);
  } finally {
    hangUp(server);
  }
});

test("a silent connection whose pairing was replaced is still cut off by the periodic check", async () => {
  let current = 4;
  const asked: string[] = [];
  const { server, url } = await relayServer({
    pairingGeneration: async (actorId) => {
      asked.push(actorId);
      return current;
    },
    pairingRecheckMs: RECHECK,
  });
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairingAt(4)}`);
    const closed = closeOf(ext.ws);
    await settle();
    assert.equal(ext.ws.readyState, WebSocket.OPEN);
    current = 5;
    assert.deepEqual(await closed, { code: 1008, reason: PAIRING_REVOKED }, "with no frame or pong from it");
    assert.ok(asked.length > 2 && asked.every((id) => id === ALICE));
  } finally {
    hangUp(server);
  }
});

test("an open connection is cut off when its pairing can no longer be checked", async () => {
  let failing = false;
  const { server, url } = await relayServer({
    pairingGeneration: async () => {
      if (failing) throw new Error("the store is down");
      return 0;
    },
    pairingRecheckMs: RECHECK,
  });
  try {
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${await pairingAt(undefined)}`);
    const closed = closeOf(ext.ws);
    await settle();
    failing = true;
    assert.equal((await closed).code, 1011, "it fails closed, like the check at connect");
  } finally {
    hangUp(server);
  }
});

function maskedFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const head =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!))]);
}

function rawExtension(url: string, token: string): Promise<{ sock: Socket; received: () => string }> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = connect(Number(port), "127.0.0.1");
    let seen = "";
    sock.on("data", (d) => {
      seen += d.toString("latin1");
      if (!seen.includes("\r\n\r\n")) return;
      if (seen.startsWith("HTTP/1.1 101")) resolve({ sock, received: () => seen });
      else reject(new Error(seen.split("\r\n")[0]));
    });
    sock.on("connect", () =>
      sock.write(
        `GET /v1/browser-relay/extension?t=${encodeURIComponent(token)} HTTP/1.1\r\nHost: relay\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      ),
    );
  });
}

test("a cut-off socket that ignores its close frame cannot speak to the person's next Chrome", async () => {
  let current = 1;
  const shares: boolean[] = [];
  const hub = createRelayHub({ onShareChanged: (_p, sharing) => shares.push(sharing) });
  const server = createServer();
  attachBrowserRelay(server, { hub, capabilitySecret: SECRET, pairingGeneration: async () => current });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const stale = await rawExtension(url, await pairingAt(1));
    assert.ok(await until(() => hub.connected(ALICE).extension));
    current = 2;
    hub.disconnect(ALICE, PAIRING_REVOKED);
    assert.ok(await until(() => stale.received().includes(PAIRING_REVOKED)), "the close frame went out");

    const next = await listen(`${url}/v1/browser-relay/extension?t=${await pairingAt(2)}`);
    const agent = await listen(`${url}/v1/browser-relay/cdp?t=${await cdpToken()}`);
    assert.ok(await until(() => hub.connected(ALICE).extension && hub.connected(ALICE).cdp));
    stale.sock.write(maskedFrame(JSON.stringify({ qm: "attached", title: "spoofed", url: "https://evil.example/" })));
    stale.sock.write(maskedFrame(JSON.stringify({ id: 7, result: { spoofed: true } })));
    await settle();

    assert.deepEqual(agent.frames, [], "the agent never hears from it");
    assert.deepEqual(shares, [], "and it cannot choose Chrome again");
    assert.equal(hub.describe(ALICE), null);
    assert.equal(next.ws.readyState, WebSocket.OPEN);
    stale.sock.destroy();
  } finally {
    hangUp(server);
  }
});

test("Disconnect Chrome closes the person's live sockets and their token never connects again", async () => {
  const config = createMemoryConfigStore("org");
  const hub = createRelayHub();
  const server = createServer();
  attachBrowserRelay(server, {
    hub,
    capabilitySecret: SECRET,
    pairingGeneration: (actorId) => config.getBrowserPairingGenerationDurable(personalScope(actorId)),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const audits: AuditEvent[] = [];
  const deps = { config, browserRelay: hub, auditLog: { record: (e: AuditEvent) => audits.push(e) } };
  try {
    const paired = pairingCtx({ actor: { p: ALICE } }, deps);
    await pair.handle(paired.ctx);
    const token = (paired.out.body as { token: string }).token;
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${encodeURIComponent(token)}`);
    const agent = await listen(`${url}/v1/browser-relay/cdp?t=${await cdpToken()}`);
    const bobToken = await mint({ actorId: "bob", scopeId: personalScope("bob"), aud: BROWSER_RELAY_AUD });
    const bob = await listen(`${url}/v1/browser-relay/extension?t=${bobToken}`);
    assert.ok(await until(() => hub.connected(ALICE).extension && hub.connected(ALICE).cdp));
    const extClosed = closeOf(ext.ws);
    const agentClosed = closeOf(agent.ws);

    const done = pairingCtx({ actor: { p: ALICE } }, deps);
    await disconnect.handle(done.ctx);
    assert.equal(done.out.status, 200);
    assert.deepEqual(hub.connected(ALICE), { extension: false, cdp: false, sharing: false }, "gone at once");
    assert.deepEqual(await extClosed, { code: 1008, reason: PAIRING_REVOKED });
    assert.equal((await agentClosed).code, 1001, "the agent's leg goes with it");
    assert.equal(await dial(`${url}/v1/browser-relay/extension?t=${encodeURIComponent(token)}`), 401);
    assert.equal(await config.getBrowserProviderDurable(personalScope(ALICE)), null, "Chrome is no longer chosen");
    assert.equal(bob.ws.readyState, WebSocket.OPEN, "someone else's Chrome is untouched");
    assert.deepEqual(
      audits.map((a) => [a.action, a.principalId, a.detail]),
      [
        ["browser-relay.pair", ALICE, "pairing generation 1"],
        ["browser-relay.disconnect", ALICE, "pairing generation 2"],
      ],
    );
  } finally {
    hangUp(server);
  }
});

test("pairing again cuts off the Chrome connected with the previous pairing", async () => {
  const config = createMemoryConfigStore("org");
  const hub = createRelayHub();
  const server = createServer();
  attachBrowserRelay(server, {
    hub,
    capabilitySecret: SECRET,
    pairingGeneration: (actorId) => config.getBrowserPairingGenerationDurable(personalScope(actorId)),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const deps = { config, browserRelay: hub };
  try {
    const first = pairingCtx({ actor: { p: ALICE } }, deps);
    await pair.handle(first.ctx);
    const old = (first.out.body as { token: string }).token;
    const ext = await listen(`${url}/v1/browser-relay/extension?t=${encodeURIComponent(old)}`);
    const closed = closeOf(ext.ws);

    const second = pairingCtx({ actor: { p: ALICE } }, deps);
    await pair.handle(second.ctx);
    const next = (second.out.body as { token: string }).token;
    assert.equal((await closed).code, 1008);
    assert.equal(await dial(`${url}/v1/browser-relay/extension?t=${encodeURIComponent(old)}`), 401);
    assert.equal(await dial(`${url}/v1/browser-relay/extension?t=${encodeURIComponent(next)}`), "open");
  } finally {
    hangUp(server);
  }
});

test("only the person, from their own web session, can disconnect their Chrome", async () => {
  const config = createMemoryConfigStore("org");
  const refused: Record<string, Parameters<typeof pairingCtx>[0]> = {
    "the agent's own live personal turn": { capability: await claims({ aud: CONTROL_PLANE_AUD, liveActor: true }) },
    "a web session capability": { capability: await claims({ liveActor: true }) },
    "an admin impersonating the person": { actor: { p: ALICE, imp: "admin" } },
  };
  for (const [label, over] of Object.entries(refused)) {
    const r = pairingCtx(over, { config });
    await disconnect.handle(r.ctx);
    assert.equal(r.out.status, 403, label);
  }
  assert.equal(await config.getBrowserPairingGenerationDurable(personalScope(ALICE)), 0, "nothing was revoked");
  assert.equal(disconnect.auth, "source");
});
