import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../src/auth/portal-identity.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createOAuthFlowStore } from "../src/connectors/oauth-flow-store.ts";
import type { OAuthState } from "../src/connectors/oauth.ts";
import type { McpFetch } from "../src/mcp/mcp-client.ts";
import type { McpOAuthRegistration } from "../src/mcp/mcp-oauth.ts";
import {
  createMcpOAuthStores,
  type McpCatalog,
  type McpOAuthClient,
  type McpUserToken,
} from "../src/mcp/mcp-oauth-store.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "mcp-oauth-route-test-secret".repeat(3);
const PORTAL_SECRET = "mcp-oauth-portal-identity-secret".repeat(2);
const CAPABILITY_SECRET = "mcp-oauth-capability-secret".repeat(2);
const PUBLIC = "https://mo.example.com";
const MCP_URL = "https://mcp.example.com/mcp";
const TOKEN_URL = "https://auth.example.com/token";
const REVOKE_URL = "https://auth.example.com/revoke";
const REDIRECT = `${PUBLIC}/v1/connectors/oauth/mcp-granola/callback`;

function sign(method: string, pathWithQuery: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

const identity = async (p: string) => ({
  [PORTAL_IDENTITY_HEADER]: await mintPortalIdentity({ p, exp: Date.now() + 60_000 }, PORTAL_SECRET),
});

function registration(partial: Partial<McpOAuthRegistration> = {}): McpOAuthRegistration {
  return {
    serverId: "granola",
    serverUrl: MCP_URL,
    resource: MCP_URL,
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: TOKEN_URL,
    revocationEndpoint: REVOKE_URL,
    scopes: ["mcp"],
    issParameterSupported: false,
    clientId: "client-1",
    clientSecret: "client-secret",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUri: REDIRECT,
    source: "dcr",
    registeredAt: 1,
    registeredBy: "internal:admin",
    ...partial,
  };
}

function mcpServer(id: string, partial: Partial<McpServer> = {}): McpServer {
  return {
    id,
    name: id === "granola" ? "Granola" : id,
    url: MCP_URL,
    auth: "oauth",
    credentialScope: "per-user",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

const mcpFetch: McpFetch = async (_url, init) => {
  const msg = JSON.parse(init.body) as { id?: number; method: string };
  const headers = { get: (n: string) => (n === "content-type" ? "application/json" : null) };
  const body =
    msg.method === "tools/list"
      ? { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "list_meetings", inputSchema: { type: "object" } }] } }
      : { jsonrpc: "2.0", id: msg.id, result: {} };
  return { ok: true, status: 200, text: async () => JSON.stringify(body), headers };
};

async function start(opts: { strict?: boolean } = {}) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "mcp-oauth-routes-")) }));
  let clock = Date.now();
  const tokenBodies: URLSearchParams[] = [];
  const revoked: URLSearchParams[] = [];
  const oauth = createMcpOAuthStores({
    clients: createMemoryMap<McpOAuthClient>(),
    tokens: createMemoryMap<McpUserToken>(),
    catalogs: createMemoryMap<McpCatalog>(),
    key: deriveConnectorKey("mcp-oauth-routes"),
    lock: createMemoryAdvisoryLock(),
    net: {
      lookup: async () => ["34.1.2.3"],
      fetchImpl: (async (url: string | URL | Request, init: RequestInit = {}) => {
        const body = new URLSearchParams(String(init.body ?? ""));
        if (String(url) === REVOKE_URL) {
          revoked.push(body);
          return new Response("", { status: 200 });
        }
        tokenBodies.push(body);
        return new Response(
          JSON.stringify({
            access_token: "granola-at",
            refresh_token: "granola-rt",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    },
  });
  const servers = createMcpServerStore(createMemoryMap<McpServer>());
  await servers.put(mcpServer("granola"));
  await servers.put(mcpServer("other"));
  await oauth.clients.put(registration());
  await oauth.clients.put(
    registration({ serverId: "other", redirectUri: `${PUBLIC}/v1/connectors/oauth/mcp-other/callback` }),
  );
  const flows = createOAuthFlowStore(createMemoryMap<OAuthState>(), { now: () => clock });
  const toolService = createMcpToolService({ servers, oauth, fetchImpl: mcpFetch, refreshIntervalMs: 3600_000 });
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    oauthFlows: flows,
    auditLog: built.auditLog,
    mcpServers: servers,
    mcpOAuth: oauth,
    mcpToolService: toolService,
    publicUrl: PUBLIC,
    portalIdentitySecret: PORTAL_SECRET,
    capabilitySecret: CAPABILITY_SECRET,
    ...(opts.strict ? { requireSignedPortalIdentity: true } : {}),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  async function startFlow(
    principalId = "internal:alice",
    redirectUri = REDIRECT,
    provider = "mcp-granola",
    returnTo = "/keychain",
  ) {
    const path = `/v1/connectors/oauth/${provider}/start?principalId=${encodeURIComponent(principalId)}&redirectUri=${encodeURIComponent(redirectUri)}&returnTo=${encodeURIComponent(returnTo)}`;
    return fetch(`${base}${path}`, {
      headers: { ...sign("GET", path), ...(opts.strict ? await identity(principalId) : {}) },
    });
  }
  async function stateFor(
    principalId = "internal:alice",
    provider = "mcp-granola",
    returnTo?: string,
  ): Promise<string> {
    const res = await startFlow(
      principalId,
      provider === "mcp-granola" ? REDIRECT : `${PUBLIC}/v1/connectors/oauth/${provider}/callback`,
      provider,
      returnTo,
    );
    assert.equal(res.status, 200);
    const url = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    return url.searchParams.get("state")!;
  }
  const callback = (query: string, headers: Record<string, string> = {}, provider = "mcp-granola") =>
    fetch(`${base}/v1/connectors/oauth/${provider}/callback?${query}`, { headers, redirect: "manual" });

  return {
    base,
    built,
    oauth,
    servers,
    toolService,
    tokenBodies,
    revoked,
    startFlow,
    stateFor,
    callback,
    advance: (ms: number) => {
      clock += ms;
    },
    close: async () => {
      toolService.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("start returns a PKCE authorize URL with resource, bound to the registered redirect URI", async () => {
  const srv = await start();
  try {
    const res = await srv.startFlow();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authorizeUrl: string; provider: string; hosts: string[] };
    assert.equal(body.provider, "mcp-granola");
    assert.deepEqual(body.hosts, ["mcp.example.com"]);
    const url = new URL(body.authorizeUrl);
    assert.equal(url.searchParams.get("client_id"), "client-1");
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.equal(url.searchParams.get("resource"), MCP_URL);
    assert.equal(url.searchParams.get("state")?.length, 43);
    assert.doesNotMatch(body.authorizeUrl, /client-secret|code_verifier/);

    const foreign = await srv.startFlow(
      "internal:alice",
      "https://evil.example/v1/connectors/oauth/mcp-granola/callback",
    );
    assert.equal(foreign.status, 400);
    assert.equal(((await foreign.json()) as { error: string }).error, "redirect_not_allowed");
  } finally {
    await srv.close();
  }
});

test("start requires the portal identity to match the principal when identity is enforced", async () => {
  const srv = await start({ strict: true });
  try {
    assert.equal((await srv.startFlow()).status, 200);
    const path = `/v1/connectors/oauth/mcp-granola/start?principalId=internal%3Aalice&redirectUri=${encodeURIComponent(REDIRECT)}`;
    const mismatch = await fetch(`${srv.base}${path}`, {
      headers: { ...sign("GET", path), ...(await identity("internal:bob")) },
    });
    assert.equal(mismatch.status, 403);
    const missing = await fetch(`${srv.base}${path}`, { headers: sign("GET", path) });
    assert.equal(missing.status, 401);
  } finally {
    await srv.close();
  }
});

test("a successful callback stores the caller's token, captures the catalog, and redirects", async () => {
  const srv = await start();
  try {
    const state = await srv.stateFor();
    const res = await srv.callback(`code=auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/keychain?connector=mcp-granola&status=connected");
    const exchange = srv.tokenBodies[0]!;
    assert.equal(exchange.get("code"), "auth-code");
    assert.equal(exchange.get("redirect_uri"), REDIRECT);
    assert.equal(exchange.get("resource"), MCP_URL);
    assert.ok((exchange.get("code_verifier") ?? "").length >= 43);
    assert.equal(await srv.oauth.tokens.accessToken("granola", "internal:alice"), "granola-at");
    assert.equal(await srv.oauth.tokens.accessToken("granola", "internal:bob"), null);
    const catalog = await srv.oauth.catalogs.get("granola");
    assert.deepEqual(
      catalog?.tools.map((t) => t.name),
      ["list_meetings"],
    );
    assert.deepEqual(
      srv.toolService.toolDefs().map((d) => d.name),
      ["granola_list_meetings"],
    );

    const replay = await srv.callback(`code=auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);

    const statusPath = "/v1/connectors/oauth/status?principalId=internal%3Aalice";
    const status = await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) });
    const text = await status.text();
    assert.doesNotMatch(text, /granola-at|granola-rt|client-secret/);
    const providers = (JSON.parse(text) as { providers: Record<string, Record<string, unknown>> }).providers;
    assert.equal(providers["mcp-granola"]?.kind, "mcp");
    assert.equal(providers["mcp-granola"]?.name, "Granola");
    assert.equal(providers["mcp-granola"]?.connected, true);
    assert.equal(providers["mcp-granola"]?.available, true);
    assert.equal(providers["mcp-other"]?.connected, false);
    assert.ok(providers.google, "built-in providers are still listed");

    const revokeBody = JSON.stringify({ principalId: "internal:alice", provider: "mcp-granola" });
    const revoke = await fetch(`${srv.base}/v1/connectors/oauth/revoke`, {
      method: "POST",
      headers: sign("POST", "/v1/connectors/oauth/revoke", revokeBody),
      body: revokeBody,
    });
    assert.equal(revoke.status, 200);
    assert.equal(await srv.oauth.tokens.accessToken("granola", "internal:alice"), null);
    assert.deepEqual(
      srv.revoked.map((b) => [b.get("token"), b.get("token_type_hint")]),
      [
        ["granola-rt", "refresh_token"],
        ["granola-at", "access_token"],
      ],
    );
  } finally {
    await srv.close();
  }
});

test("callback rejects forged, expired, and cross-provider state with a JSON 400", async () => {
  const srv = await start();
  try {
    assert.equal((await srv.callback("code=c&state=forged")).status, 400);
    assert.equal((await srv.callback("code=c")).status, 400);
    const expired = await srv.stateFor();
    srv.advance(11 * 60_000);
    assert.equal((await srv.callback(`code=c&state=${encodeURIComponent(expired)}`)).status, 400);
    const crossed = await srv.stateFor();
    assert.equal((await srv.callback(`code=c&state=${encodeURIComponent(crossed)}`, {}, "mcp-other")).status, 400);
    assert.equal(srv.tokenBodies.length, 0);
  } finally {
    await srv.close();
  }
});

test("once state is valid, issuer mix-up, a re-registered client, or a denial redirect with an error", async () => {
  const srv = await start();
  try {
    const iss = await srv.stateFor();
    const mixUp = await srv.callback(
      `code=c&state=${encodeURIComponent(iss)}&iss=${encodeURIComponent("https://evil.example")}`,
    );
    assert.equal(mixUp.headers.get("location"), "/keychain?connector=mcp-granola&status=error");

    const slashed = await srv.stateFor();
    const nearMiss = await srv.callback(
      `code=c&state=${encodeURIComponent(slashed)}&iss=${encodeURIComponent("https://auth.example.com/")}`,
    );
    assert.equal(nearMiss.headers.get("location"), "/keychain?connector=mcp-granola&status=error");

    const matching = await srv.stateFor();
    const fine = await srv.callback(
      `code=c&state=${encodeURIComponent(matching)}&iss=${encodeURIComponent("https://auth.example.com")}`,
    );
    assert.equal(fine.headers.get("location"), "/keychain?connector=mcp-granola&status=connected");

    await srv.oauth.clients.put(registration({ issParameterSupported: true }));
    const missingIss = await srv.stateFor();
    assert.equal(
      (await srv.callback(`code=c&state=${encodeURIComponent(missingIss)}`)).headers.get("location"),
      "/keychain?connector=mcp-granola&status=error",
    );

    await srv.oauth.clients.put(registration());
    const stale = await srv.stateFor();
    await srv.oauth.clients.put(registration({ clientId: "client-2" }));
    assert.equal(
      (await srv.callback(`code=c&state=${encodeURIComponent(stale)}`)).headers.get("location"),
      "/keychain?connector=mcp-granola&status=error",
    );

    const denied = await srv.stateFor();
    assert.equal(
      (await srv.callback(`error=access_denied&state=${encodeURIComponent(denied)}`)).headers.get("location"),
      "/keychain?connector=mcp-granola&status=error",
    );
    assert.equal(srv.tokenBodies.length, 1);
  } finally {
    await srv.close();
  }
});

test("with identity enforced, the callback must come from the starting person's browser", async () => {
  const srv = await start({ strict: true });
  try {
    const noBrowser = await srv.stateFor();
    assert.equal(
      (await srv.callback(`code=c&state=${encodeURIComponent(noBrowser)}`)).headers.get("location"),
      "/keychain?connector=mcp-granola&status=error",
    );
    const victim = await srv.stateFor("internal:attacker");
    assert.equal(
      (await srv.callback(`code=c&state=${encodeURIComponent(victim)}`, await identity("internal:victim"))).headers.get(
        "location",
      ),
      "/keychain?connector=mcp-granola&status=error",
    );
    assert.equal(srv.tokenBodies.length, 0);
    const own = await srv.stateFor();
    const ok = await srv.callback(`code=c&state=${encodeURIComponent(own)}`, await identity("internal:alice"));
    assert.equal(ok.headers.get("location"), "/keychain?connector=mcp-granola&status=connected");
    assert.equal(await srv.oauth.tokens.accessToken("granola", "internal:alice"), "granola-at");
  } finally {
    await srv.close();
  }
});

test("mcp- providers that are not OAuth MCP servers fall through to the built-in provider table", async () => {
  const srv = await start();
  try {
    await srv.servers.put(mcpServer("plain", { auth: "none", credentialScope: "shared" }));
    const res = await srv.startFlow("internal:alice", REDIRECT, "mcp-plain");
    assert.equal(res.status, 404);
    assert.equal((await srv.startFlow("internal:alice", REDIRECT, "mcp-missing")).status, 404);
  } finally {
    await srv.close();
  }
});

test("a returnTo that normalizes to another origin is dropped instead of becoming an open redirect", async () => {
  const srv = await start();
  try {
    for (const returnTo of ["/.//evil.com", "/a/..//evil.com", "/\\evil.com", "//evil.com"]) {
      const state = await srv.stateFor("internal:alice", "mcp-granola", returnTo);
      const res = await srv.callback(`code=c&state=${encodeURIComponent(state)}`);
      assert.equal(res.status, 200, returnTo);
      assert.equal(res.headers.get("location"), null, returnTo);
    }
    const state = await srv.stateFor("internal:alice", "mcp-granola", "/a/../keychain?tab=x");
    const res = await srv.callback(`code=c&state=${encodeURIComponent(state)}`);
    assert.equal(res.headers.get("location"), "/keychain?tab=x&connector=mcp-granola&status=connected");
  } finally {
    await srv.close();
  }
});

test("sign-in can neither start nor finish under an impersonated identity", async () => {
  const srv = await start({ strict: true });
  try {
    const impersonated = {
      [PORTAL_IDENTITY_HEADER]: await mintPortalIdentity(
        { p: "internal:alice", imp: "internal:admin", exp: Date.now() + 60_000 },
        PORTAL_SECRET,
      ),
    };
    const path = `/v1/connectors/oauth/mcp-granola/start?principalId=internal%3Aalice&redirectUri=${encodeURIComponent(REDIRECT)}`;
    const refused = await fetch(`${srv.base}${path}`, { headers: { ...sign("GET", path), ...impersonated } });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: string }).error, "browser_identity_required");

    const state = await srv.stateFor();
    const finished = await srv.callback(`code=c&state=${encodeURIComponent(state)}`, impersonated);
    assert.equal(finished.headers.get("location"), "/keychain?connector=mcp-granola&status=error");
    assert.equal(srv.tokenBodies.length, 0);
    assert.equal(await srv.oauth.tokens.accessToken("granola", "internal:alice"), null);
  } finally {
    await srv.close();
  }
});

test("a callback for a server disabled after the flow started stores no token", async () => {
  const srv = await start();
  try {
    const state = await srv.stateFor();
    await srv.servers.put(mcpServer("granola", { enabled: false }));
    const res = await srv.callback(`code=c&state=${encodeURIComponent(state)}`);
    assert.equal(res.headers.get("location"), "/keychain?connector=mcp-granola&status=error");
    assert.equal(srv.tokenBodies.length, 0);
    assert.equal(await srv.oauth.tokens.accessToken("granola", "internal:alice"), null);
  } finally {
    await srv.close();
  }
});

test("a connected person's status read retries a catalog capture that failed at sign-in", async () => {
  const srv = await start();
  try {
    await srv.oauth.tokens.set("granola", "internal:alice", { accessToken: "granola-at" }, "client-1");
    assert.equal(await srv.oauth.catalogs.get("granola"), null);
    const statusPath = "/v1/connectors/oauth/status?principalId=internal%3Aalice";
    const status = await fetch(`${srv.base}${statusPath}`, { headers: sign("GET", statusPath) });
    assert.equal(status.status, 200);
    for (let i = 0; i < 50 && !(await srv.oauth.catalogs.get("granola")); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(
      (await srv.oauth.catalogs.get("granola"))?.tools.map((t) => t.name),
      ["list_meetings"],
    );
    assert.deepEqual(
      srv.toolService.toolDefs().map((d) => d.name),
      ["granola_list_meetings"],
    );
  } finally {
    await srv.close();
  }
});
