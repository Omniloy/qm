import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, McpHttpError, mcpResultText, type McpFetch } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import {
  createMcpOAuthStores,
  type McpCatalog,
  type McpOAuthClient,
  type McpUserToken,
} from "../src/mcp/mcp-oauth-store.ts";

function jsonResponse(body: unknown, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
  };
}

const TOOLS = [
  { name: "query", description: "Run a query", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "update", description: "Write a record", inputSchema: { type: "object", properties: {} } },
];

function fakeServerFetch(opts?: { requireBearer?: string; sse?: boolean }): { fetch: McpFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    if (opts?.requireBearer && init.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const req = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    const result =
      req.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: `ran ${req.params.name}` }] };
    const envelope = { jsonrpc: "2.0", id: req.id, result };
    if (opts?.sse) {
      return jsonResponse(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, 200, "text/event-stream");
    }
    return jsonResponse(envelope);
  };
  return { fetch, calls };
}

function server(partial?: Partial<McpServer>): McpServer {
  return {
    id: "crm",
    name: "CRM",
    url: "https://mcp.example.com/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("mcp client lists tools and calls one over plain JSON", async () => {
  const { fetch } = fakeServerFetch();
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["query", "update"],
  );
  const result = await client.callTool("query", { q: "hi" });
  assert.equal(mcpResultText(result), "ran query");
});

test("mcp client parses SSE-framed responses", async () => {
  const { fetch } = fakeServerFetch({ sse: true });
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
});

test("mcp client sends bearer auth", async () => {
  const { fetch } = fakeServerFetch({ requireBearer: "sekret" });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "sekret" },
    fetchImpl: fetch,
  });
  assert.equal((await client.listTools()).length, 2);
  const bad = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => bad.listTools(), /HTTP 401/);
});

test("server id validation", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});

test("tool service exposes namespaced tools and calls through", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const defs = service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["crm_query", "crm_update"]);
  assert.ok(defs.every((d) => d.readOnly));
  const out = await service.call("crm_query", { q: "hello" }, "internal:U1");
  assert.equal(out, "ran query");
  service.close();
});

test("disabled server's tools disappear and calls fail", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

function tokenStore() {
  return createKeychain({
    creds: createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("mcp-test-encryption-key"),
  });
}

test("per-user calls resolve only the caller's fresh token while discovery uses catalog auth", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "alice-token" });
  await users.setConnectorToken(host, "internal:bob", { accessToken: "bob-token" });
  const catalogAuth: string[] = [];
  const callAuth: string[] = [];
  const service = createMcpToolService({
    servers: store,
    userTokens: users,
    fetchImpl: async (_url, init) => {
      const rpc = JSON.parse(init.body);
      if (rpc.method === "tools/list") {
        catalogAuth.push(init.headers.authorization!);
        return jsonResponse({ result: { tools: TOOLS } });
      }
      callAuth.push(init.headers.authorization!);
      return jsonResponse({ result: { content: [{ type: "text", text: rpc.params.arguments.q }] } });
    },
  });
  t.after(() => service.close());
  await store.put(
    server({ auth: "bearer", bearerToken: "catalog-only", credentialScope: "per-user", credentialHost: host }),
  );
  await service.refresh();
  assert.deepEqual(await service.probe((await store.get("crm"))!), ["query", "update"]);
  assert.ok(catalogAuth.length > 0);
  assert.ok(catalogAuth.every((auth) => auth === "Bearer catalog-only"));
  assert.deepEqual(
    await Promise.all([
      service.call("crm_query", { q: "alice" }, "internal:alice"),
      service.call("crm_query", { q: "bob" }, "internal:bob"),
    ]),
    ["alice", "bob"],
  );
  assert.deepEqual(callAuth.sort(), ["Bearer alice-token", "Bearer bob-token"]);
  await users.setConnectorToken(host, "internal:alice", { accessToken: "rotated-alice" });
  await service.call("crm_query", { q: "rotated" }, "internal:alice");
  assert.equal(callAuth.at(-1), "Bearer rotated-alice");
  await users.deleteConnectorToken(host, "internal:alice");
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /Connect your account/);
  await assert.rejects(service.call("crm_query", {}), /requires a connected user/);
  await assert.rejects(
    service.call("crm_query", { principalId: "internal:bob" }, "internal:mallory"),
    /Connect your account/,
  );
  await users.setConnectorToken(host, "internal:bob", { accessToken: "expired", expiresAt: 1 });
  await assert.rejects(service.call("crm_query", {}, "internal:bob"), /Connect your account/);
  assert.equal(callAuth.length, 3);
});

test("per-user mode fails closed without a keychain and shared mode preserves existing behavior", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch, calls } = fakeServerFetch({ requireBearer: "shared-token" });
  const service = createMcpToolService({ servers: store, fetchImpl: fetch });
  t.after(() => service.close());
  await store.put(
    server({
      auth: "bearer",
      bearerToken: "shared-token",
      credentialScope: "per-user",
      credentialHost: "accounts.example.com",
    }),
  );
  await service.refresh();
  const count = calls.length;
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /requires a connected user/);
  assert.equal(calls.length, count);
  await store.put(server({ auth: "bearer", bearerToken: "shared-token", credentialScope: "shared" }));
  await service.refresh();
  assert.equal(await service.call("crm_query", {}), "ran query");
});

test("MCP HTTP transport refuses redirects before sending a user token to another endpoint", async (t) => {
  let targetRequests = 0;
  const target = createServer((_req, res) => {
    targetRequests++;
    res.end("{}");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const redirected = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/mcp` });
    res.end();
  });
  redirected.listen(0, "127.0.0.1");
  await once(redirected, "listening");
  t.after(() => {
    target.close();
    redirected.close();
  });
  const client = createMcpClient({
    url: `http://127.0.0.1:${(redirected.address() as AddressInfo).port}`,
    auth: { mode: "bearer", token: "private-user-token" },
  });
  await assert.rejects(client.callTool("query", {}));
  assert.equal(targetRequests, 0);
});

test("per-user connectors select an explicit account slot without falling back to another slot", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "default-token" });
  await users.setConnectorToken(host, "internal:alice", { accessToken: "company-token" }, "company");
  const { fetch } = fakeServerFetch({ requireBearer: "company-token" });
  const service = createMcpToolService({ servers: store, userTokens: users, fetchImpl: fetch });
  t.after(() => service.close());
  await store.put(
    server({
      auth: "bearer",
      bearerToken: "company-token",
      credentialScope: "per-user",
      credentialHost: host,
      credentialAccountType: "company",
    }),
  );
  await service.refresh();
  assert.equal(await service.call("crm_query", {}, "internal:alice"), "ran query");
  await users.deleteConnectorToken(host, "internal:alice", "company");
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /Connect your account/);
});

function rpcResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const all: Record<string, string> = { "content-type": "application/json", ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => all[n.toLowerCase()] ?? null },
  };
}

function sessionServer(opts: { accept?: string[]; sse?: boolean } = {}) {
  const log: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let sessions = 0;
  let live = "";
  const fetch: McpFetch = async (url, init) => {
    const msg = JSON.parse(init.body) as { id?: number; method: string; params?: { name?: string } };
    log.push({ url, method: msg.method, headers: init.headers });
    if (opts.accept && !opts.accept.includes(init.headers.authorization ?? "")) {
      return rpcResponse({ error: "invalid_token" }, 401, { "www-authenticate": 'Bearer error="invalid_token"' });
    }
    if (msg.method === "initialize") {
      live = `session-${++sessions}`;
      const envelope = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {} } };
      return opts.sse
        ? rpcResponse(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, 200, {
            "content-type": "text/event-stream",
            "mcp-session-id": live,
          })
        : rpcResponse(envelope, 200, { "mcp-session-id": live });
    }
    if (init.headers["mcp-session-id"] !== live) return rpcResponse({ error: "unknown session" }, 404);
    if (msg.method === "notifications/initialized") return rpcResponse("", 202);
    const result =
      msg.method === "tools/list"
        ? { tools: TOOLS }
        : { content: [{ type: "text", text: `ran ${msg.params?.name} as ${init.headers.authorization}` }] };
    return rpcResponse({ jsonrpc: "2.0", id: msg.id, result });
  };
  return {
    fetch,
    log,
    expire: () => {
      live = "expired";
    },
  };
}

test("session mode runs the streamable-HTTP handshake once and reuses the session", async () => {
  for (const sse of [false, true]) {
    const srv = sessionServer({ sse });
    const client = createMcpClient({
      url: "https://mcp.example.com/v2/endpoint",
      auth: { mode: "bearer", token: "tok" },
      session: true,
      fetchImpl: srv.fetch,
    });
    assert.equal((await client.listTools()).length, 2);
    assert.equal(mcpResultText(await client.callTool("query", {})), "ran query as Bearer tok");
    assert.deepEqual(
      srv.log.map((e) => e.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    assert.ok(srv.log.every((e) => e.url === "https://mcp.example.com/v2/endpoint"));
    assert.equal(srv.log[0]!.headers["mcp-session-id"], undefined);
    assert.equal(srv.log[0]!.headers["mcp-protocol-version"], undefined);
    for (const entry of srv.log.slice(1)) {
      assert.equal(entry.headers["mcp-session-id"], "session-1");
      assert.equal(entry.headers["mcp-protocol-version"], "2025-03-26");
    }
  }
});

test("session mode re-initializes once when the server forgets the session", async () => {
  const srv = sessionServer();
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    session: true,
    fetchImpl: srv.fetch,
  });
  await client.listTools();
  srv.expire();
  assert.equal((await client.listTools()).length, 2);
  assert.deepEqual(
    srv.log.map((e) => e.method),
    [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ],
  );
});

test("legacy mode keeps the single-POST transport and non-OK responses carry status and challenge", async () => {
  const srv = sessionServer({ accept: ["Bearer good"] });
  const legacy = fakeServerFetch();
  const client = createMcpClient({ url: "https://mcp.example.com", auth: { mode: "none" }, fetchImpl: legacy.fetch });
  await client.listTools();
  assert.deepEqual(legacy.calls, ["https://mcp.example.com/mcp"]);
  const denied = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "bad" },
    session: true,
    fetchImpl: srv.fetch,
  });
  const error = await denied.listTools().catch((e: unknown) => e);
  assert.ok(error instanceof McpHttpError);
  assert.equal(error.status, 401);
  assert.match(error.wwwAuthenticate ?? "", /invalid_token/);
  assert.match(error.message, /HTTP 401/);
});

const OAUTH_TOKEN_URL = "https://auth.example.com/token";

async function oauthHarness(opts: { accept?: string[]; refreshTo?: string } = {}) {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  let tokenRequests = 0;
  const oauth = createMcpOAuthStores({
    clients: createMemoryMap<McpOAuthClient>(),
    tokens: createMemoryMap<McpUserToken>(),
    catalogs: createMemoryMap<McpCatalog>(),
    key: deriveConnectorKey("mcp-tool-service-oauth"),
    lock: createMemoryAdvisoryLock(),
    net: {
      lookup: async () => ["34.1.2.3"],
      fetchImpl: (async () => {
        tokenRequests++;
        return new Response(JSON.stringify({ access_token: opts.refreshTo ?? "refreshed", token_type: "Bearer" }), {
          status: 200,
        });
      }) as typeof fetch,
    },
  });
  await oauth.clients.put({
    serverId: "granola",
    serverUrl: "https://mcp.example.com/mcp",
    resource: "https://mcp.example.com/mcp",
    issuer: "https://auth.example.com",
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: OAUTH_TOKEN_URL,
    issParameterSupported: false,
    clientId: "client-1",
    tokenEndpointAuthMethod: "none",
    redirectUri: "https://mo.example.com/v1/connectors/oauth/mcp-granola/callback",
    source: "dcr",
    registeredAt: 1,
    registeredBy: "internal:admin",
  });
  const srv = sessionServer(opts.accept ? { accept: opts.accept } : {});
  const service = createMcpToolService({
    servers: store,
    oauth,
    connectUrl: (id) => `https://mo.example.com/keychain?connect=mcp-${id}`,
    fetchImpl: srv.fetch,
    refreshIntervalMs: 3600_000,
  });
  await store.put(server({ id: "granola", name: "Granola", auth: "oauth", credentialScope: "per-user" }));
  return { store, oauth, srv, service, tokenRequests: () => tokenRequests };
}

test("OAuth servers expose the durable catalog without contacting the server", async (t) => {
  const h = await oauthHarness();
  t.after(() => h.service.close());
  await h.service.refresh();
  assert.deepEqual(h.service.toolDefs(), []);
  await h.oauth.catalogs.put({ serverId: "granola", tools: TOOLS, fetchedAt: Date.now(), fetchedBy: "internal:alice" });
  await h.service.refresh();
  assert.deepEqual(
    h.service
      .toolDefs()
      .map((d) => d.name)
      .sort(),
    ["granola_query", "granola_update"],
  );
  assert.equal(h.srv.log.length, 0);
  await assert.rejects(h.service.probe((await h.store.get("granola"))!), /signed-in user/);
});

test("OAuth calls use only the caller's token and send unconnected callers the connect link", async (t) => {
  const h = await oauthHarness();
  t.after(() => h.service.close());
  await h.oauth.catalogs.put({ serverId: "granola", tools: TOOLS, fetchedAt: Date.now(), fetchedBy: "internal:alice" });
  await h.service.refresh();
  await h.oauth.tokens.set("granola", "internal:alice", { accessToken: "alice-at" }, "client-1");
  assert.equal(await h.service.call("granola_query", {}, "internal:alice"), "ran query as Bearer alice-at");
  await assert.rejects(
    h.service.call("granola_query", {}, "internal:bob"),
    /Granola isn't connected for you\. Ask the user to connect it at https:\/\/mo\.example\.com\/keychain\?connect=mcp-granola, then retry\./,
  );
  await assert.rejects(h.service.call("granola_query", {}), /isn't connected for you/);
  assert.ok(h.srv.log.every((e) => e.headers.authorization === "Bearer alice-at"));
});

test("a 401 from an OAuth server refreshes once and retries, then asks to reconnect", async (t) => {
  const h = await oauthHarness({ accept: ["Bearer alice-new"], refreshTo: "alice-new" });
  t.after(() => h.service.close());
  await h.oauth.catalogs.put({ serverId: "granola", tools: TOOLS, fetchedAt: Date.now(), fetchedBy: "internal:alice" });
  await h.service.refresh();
  await h.oauth.tokens.set("granola", "internal:alice", { accessToken: "alice-old", refreshToken: "rt" }, "client-1");
  assert.equal(await h.service.call("granola_query", {}, "internal:alice"), "ran query as Bearer alice-new");
  assert.equal(h.tokenRequests(), 1);

  const stuck = await oauthHarness({ accept: ["Bearer never"], refreshTo: "still-wrong" });
  t.after(() => stuck.service.close());
  await stuck.oauth.catalogs.put({ serverId: "granola", tools: TOOLS, fetchedAt: Date.now(), fetchedBy: "x" });
  await stuck.service.refresh();
  await stuck.oauth.tokens.set("granola", "internal:alice", { accessToken: "a", refreshToken: "rt" }, "client-1");
  await assert.rejects(stuck.service.call("granola_query", {}, "internal:alice"), /isn't connected for you/);
  assert.equal(stuck.tokenRequests(), 1);
  assert.equal((await stuck.oauth.tokens.status("granola", "internal:alice")).needsReconnect, true);
});

test("capturing a catalog lists with the connecting user's token and publishes it", async (t) => {
  const h = await oauthHarness();
  t.after(() => h.service.close());
  await assert.rejects(h.service.captureCatalog("granola", "internal:alice"), /isn't connected/);
  await h.oauth.tokens.set("granola", "internal:alice", { accessToken: "alice-at" }, "client-1");
  assert.equal(await h.service.captureCatalog("granola", "internal:alice"), 2);
  const catalog = await h.oauth.catalogs.get("granola");
  assert.equal(catalog?.fetchedBy, "internal:alice");
  assert.deepEqual(
    catalog?.tools.map((tool) => tool.name),
    ["query", "update"],
  );
  assert.deepEqual(
    h.service
      .toolDefs()
      .map((d) => d.name)
      .sort(),
    ["granola_query", "granola_update"],
  );
  assert.doesNotMatch(JSON.stringify(catalog), /alice-at/);
});

test("a stale catalog is re-listed in the background with the caller's token", async (t) => {
  const h = await oauthHarness();
  t.after(() => h.service.close());
  await h.oauth.catalogs.put({
    serverId: "granola",
    tools: TOOLS.slice(0, 1),
    fetchedAt: 1,
    fetchedBy: "internal:old",
  });
  await h.service.refresh();
  await h.oauth.tokens.set("granola", "internal:alice", { accessToken: "alice-at" }, "client-1");
  await h.service.call("granola_query", {}, "internal:alice");
  for (let i = 0; i < 20 && (await h.oauth.catalogs.get("granola"))?.fetchedBy !== "internal:alice"; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal((await h.oauth.catalogs.get("granola"))?.tools.length, 2);
});
