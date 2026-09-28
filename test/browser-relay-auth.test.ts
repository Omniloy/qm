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

async function relayServer(authorizesScope?: (c: CapabilityClaims) => Promise<boolean>): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer();
  attachBrowserRelay(server, { capabilitySecret: SECRET, ...(authorizesScope ? { authorizesScope } : {}) });
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
