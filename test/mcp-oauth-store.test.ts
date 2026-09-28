import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import type { McpOAuthNet, McpOAuthRegistration } from "../src/mcp/mcp-oauth.ts";
import {
  createMcpOAuthStores,
  type McpCatalog,
  type McpOAuthClient,
  type McpUserToken,
} from "../src/mcp/mcp-oauth-store.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";

const TOKEN_URL = "https://auth.example.com/token";
const KEY = deriveConnectorKey("mcp-oauth-store-test-key-material");

function registration(partial: Partial<McpOAuthRegistration> = {}): McpOAuthRegistration {
  return {
    serverId: "granola",
    serverUrl: "https://mcp.example.com/mcp",
    resource: "https://mcp.example.com/mcp",
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: TOKEN_URL,
    issParameterSupported: false,
    clientId: "client-1",
    clientSecret: "client-secret-plain",
    tokenEndpointAuthMethod: "client_secret_basic",
    registrationAccessToken: "registration-token-plain",
    redirectUri: "https://mo.example.com/v1/connectors/oauth/mcp-granola/callback",
    source: "dcr",
    registeredAt: 1,
    registeredBy: "internal:admin",
    ...partial,
  };
}

function setup(respond: (body: URLSearchParams) => Response | Promise<Response>) {
  let clock = 10_000_000;
  const tokenCalls: URLSearchParams[] = [];
  const net: McpOAuthNet = {
    lookup: async () => ["34.1.2.3"],
    now: () => clock,
    fetchImpl: (async (_url: string | URL | Request, init: RequestInit = {}) => {
      const body = new URLSearchParams(String(init.body ?? ""));
      tokenCalls.push(body);
      return respond(body);
    }) as typeof fetch,
  };
  const maps = {
    clients: createMemoryMap<McpOAuthClient>(),
    tokens: createMemoryMap<McpUserToken>(),
    catalogs: createMemoryMap<McpCatalog>(),
  };
  const lock = createMemoryAdvisoryLock();
  const make = () => createMcpOAuthStores({ ...maps, key: KEY, lock, net, now: () => clock });
  return {
    maps,
    make,
    tokenCalls,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

async function dump(map: DurableMap<unknown>): Promise<string> {
  return JSON.stringify(await map.entries());
}

const ok = (access: string, refresh?: string) =>
  new Response(
    JSON.stringify({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      ...(refresh ? { refresh_token: refresh } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

test("registration secrets and user tokens are never stored in plaintext", async () => {
  const s = setup(() => ok("unused"));
  const stores = s.make();
  await stores.clients.put(registration());
  await stores.tokens.set(
    "granola",
    "internal:alice",
    { accessToken: "access-plain", refreshToken: "refresh-plain" },
    "client-1",
  );
  const raw = (await dump(s.maps.clients as DurableMap<unknown>)) + (await dump(s.maps.tokens as DurableMap<unknown>));
  for (const secret of ["client-secret-plain", "registration-token-plain", "access-plain", "refresh-plain"]) {
    assert.doesNotMatch(raw, new RegExp(secret));
  }
  const back = await stores.clients.get("granola");
  assert.equal(back?.clientSecret, "client-secret-plain");
  assert.equal(back?.registrationAccessToken, "registration-token-plain");
  assert.equal(await stores.tokens.accessToken("granola", "internal:alice"), "access-plain");
  assert.equal(await stores.tokens.accessToken("granola", "internal:bob"), null);
});

test("an expiring token refreshes once across concurrent callers and instances, keeping a rotated refresh token", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const s = setup(async () => {
    await gate;
    return ok("access-2", "refresh-2");
  });
  const a = s.make();
  const b = s.make();
  await a.clients.put(registration());
  await a.tokens.set(
    "granola",
    "internal:alice",
    { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: s.now() + 30_000 },
    "client-1",
  );
  const pending = [
    a.tokens.accessToken("granola", "internal:alice"),
    a.tokens.accessToken("granola", "internal:alice"),
    b.tokens.accessToken("granola", "internal:alice"),
  ];
  await new Promise((r) => setTimeout(r, 10));
  release();
  assert.deepEqual(await Promise.all(pending), ["access-2", "access-2", "access-2"]);
  assert.equal(s.tokenCalls.length, 1);
  assert.equal(s.tokenCalls[0]!.get("refresh_token"), "refresh-1");
  assert.equal(s.tokenCalls[0]!.get("resource"), "https://mcp.example.com/mcp");
  s.advance(3_600_000);
  await a.tokens.accessToken("granola", "internal:alice");
  assert.equal(s.tokenCalls[1]!.get("refresh_token"), "refresh-2");
});

test("a refresh without a new refresh token keeps the old one", async () => {
  const s = setup(() => ok("access-2"));
  const stores = s.make();
  await stores.clients.put(registration());
  await stores.tokens.set(
    "granola",
    "internal:alice",
    { accessToken: "a1", refreshToken: "r1", expiresAt: s.now() },
    "client-1",
  );
  assert.equal(await stores.tokens.forceRefresh("granola", "internal:alice"), "access-2");
  assert.equal(await stores.tokens.forceRefresh("granola", "internal:alice"), "access-2");
  assert.equal(s.tokenCalls[1]!.get("refresh_token"), "r1");
});

test("a rejected refresh marks the token for reconnect without keeping token text", async () => {
  const s = setup(
    () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  const stores = s.make();
  await stores.clients.put(registration());
  await stores.tokens.set(
    "granola",
    "internal:alice",
    { accessToken: "a1", refreshToken: "r1", expiresAt: s.now() },
    "client-1",
  );
  assert.equal(await stores.tokens.accessToken("granola", "internal:alice"), null);
  const status = await stores.tokens.status("granola", "internal:alice");
  assert.equal(status.connected, false);
  assert.equal(status.needsReconnect, true);
  assert.match(status.refreshError ?? "", /invalid_grant/);
  assert.doesNotMatch(JSON.stringify(status), /a1|r1/);
  assert.equal(await stores.tokens.accessToken("granola", "internal:alice"), null);
  assert.equal(s.tokenCalls.length, 1);
});

test("a transient refresh failure throws and does not mark reconnect", async () => {
  const s = setup(() => new Response("down", { status: 503 }));
  const stores = s.make();
  await stores.clients.put(registration());
  await stores.tokens.set(
    "granola",
    "internal:alice",
    { accessToken: "a1", refreshToken: "r1", expiresAt: s.now() },
    "client-1",
  );
  await assert.rejects(stores.tokens.accessToken("granola", "internal:alice"), /HTTP 503/);
  assert.equal((await stores.tokens.status("granola", "internal:alice")).needsReconnect, undefined);
});

test("a token issued to a previous client registration is unusable", async () => {
  const s = setup(() => ok("unused"));
  const stores = s.make();
  await stores.clients.put(registration());
  await stores.tokens.set("granola", "internal:alice", { accessToken: "a1" }, "client-1");
  await stores.clients.put(registration({ clientId: "client-2" }));
  assert.equal(await stores.tokens.accessToken("granola", "internal:alice"), null);
  assert.equal((await stores.tokens.status("granola", "internal:alice")).needsReconnect, true);
});

test("delete returns the removed tokens and server-wide deletion clears every user", async () => {
  const s = setup(() => ok("unused"));
  const stores = s.make();
  await stores.clients.put(registration());
  await stores.tokens.set("granola", "internal:alice", { accessToken: "a1", refreshToken: "r1" }, "client-1");
  await stores.tokens.set("granola", "internal:bob", { accessToken: "b1" }, "client-1");
  await stores.tokens.set("other", "internal:bob", { accessToken: "o1" }, "client-9");
  assert.deepEqual(await stores.tokens.delete("granola", "internal:alice"), { accessToken: "a1", refreshToken: "r1" });
  assert.equal(await stores.tokens.delete("granola", "internal:alice"), null);
  await stores.tokens.deleteAllForServer("granola");
  assert.equal((await s.maps.tokens.entries()).length, 1);
  await stores.tokens.markNeedsReconnect("other", "internal:bob", "rejected");
  assert.equal((await stores.tokens.status("other", "internal:bob")).connected, false);
});
