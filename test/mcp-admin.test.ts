import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  createMcpOAuthStores,
  type McpCatalog,
  type McpOAuthClient,
  type McpUserToken,
} from "../src/mcp/mcp-oauth-store.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("MCP admin validates and preserves credential scope, without returning secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers/crm`;
  const put = (body: object, headers = ADMIN) =>
    fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ url: "https://tools.example.com/mcp", validate: false, ...body }),
    });
  assert.equal((await put({ credentialScope: "other" })).status, 400);
  assert.equal((await put({ credentialScope: "per-user" })).status, 400);
  assert.equal(
    (await put({ credentialScope: "per-user", credentialHost: "accounts.example.com", credentialAccountType: "other" }))
      .status,
    400,
  );
  for (const credentialHost of ["", " accounts.example.com", "accounts.example.com/path", "host@evil", 1]) {
    assert.equal((await put({ credentialScope: "per-user", credentialHost })).status, 400);
  }
  assert.equal(
    (
      await put({
        credentialScope: "per-user",
        credentialHost: "accounts.example.com",
        url: "http://tools.example.com/mcp",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await put(
        { credentialScope: "per-user", credentialHost: "accounts.example.com" },
        { ...ADMIN, "x-admin-actor": "nobody@default-org" },
      )
    ).status,
    403,
  );
  const saved = await put({
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    auth: "bearer",
    bearerToken: "catalog-secret",
    credentialAccountType: "personal",
  });
  assert.equal(saved.status, 200);
  const body = await saved.text();
  assert.doesNotMatch(body, /catalog-secret/);
  assert.equal(JSON.parse(body).server.credentialScope, "per-user");
  assert.equal((await put({ auth: "bearer" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "per-user");
  assert.equal((await store.get("crm"))?.credentialHost, "accounts.example.com");
  assert.equal((await store.get("crm"))?.credentialAccountType, "personal");
  assert.equal((await store.get("crm"))?.bearerToken, "catalog-secret");
  assert.equal((await put({ credentialScope: "shared" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "shared");
  assert.equal((await store.get("crm"))?.credentialHost, undefined);
  assert.equal((await store.get("crm"))?.credentialAccountType, undefined);
});

test("MCP admin stores an optional https icon, otherwise resolves the site icon once, and keeps names on one line", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-icon-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const homepages: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const href = String(input);
    if (!href.endsWith(".example.com/")) return new Response("", { status: 404 });
    homepages.push(href);
    return new Response(`<head><link rel="icon" href="/brand-${homepages.length}.svg"></head>`);
  }) as typeof fetch;
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
    mcpOAuth: oauthStores({ fetchImpl, lookup: async () => ["34.1.2.3"] }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers`;
  const put = (body: object) =>
    fetch(`${base}/crm`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ url: "https://mcp.tools.example.com/mcp", validate: false, ...body }),
    });
  for (const iconUrl of [
    "http://tools.example.com/logo.png",
    "javascript:alert(1)",
    'https://tools.example.com/a"b.png',
    "https://tools.example.com/a b.png",
    "https://user:pw@tools.example.com/logo.png",
    `https://tools.example.com/${"a".repeat(2050)}`,
    42,
  ]) {
    assert.equal((await put({ iconUrl })).status, 400, String(iconUrl));
  }
  const saved = await put({ iconUrl: " https://cdn.example.com/crm.png ", name: "CRM\n- forged: line\u0000" });
  assert.equal(saved.status, 200);
  const body = (await saved.json()) as { server: { icon: string; iconUrl: string; name: string } };
  assert.equal(body.server.iconUrl, "https://cdn.example.com/crm.png");
  assert.equal(body.server.icon, "https://cdn.example.com/crm.png");
  assert.equal(body.server.name, "CRM - forged: line");
  assert.deepEqual(homepages, []);
  assert.equal((await put({ name: "CRM" })).status, 200);
  assert.equal((await store.get("crm"))?.iconUrl, "https://cdn.example.com/crm.png");
  assert.equal((await put({ iconUrl: "" })).status, 200);
  assert.equal((await store.get("crm"))?.iconUrl, undefined);
  assert.equal((await store.get("crm"))?.resolvedIconUrl, "https://tools.example.com/brand-1.svg");
  assert.equal((await put({ name: "CRM 2" })).status, 200);
  assert.deepEqual(homepages, ["https://tools.example.com/"]);
  const listed = (await (await fetch(base, { headers: ADMIN })).json()) as {
    servers: Array<{ icon?: string; resolvedIconUrl?: string }>;
  };
  assert.equal(listed.servers[0]?.icon, "https://tools.example.com/brand-1.svg");
  assert.equal(listed.servers[0]?.resolvedIconUrl, "https://tools.example.com/brand-1.svg");
  assert.equal((await put({ url: "https://mcp.other.example.com/mcp" })).status, 200);
  assert.equal((await store.get("crm"))?.resolvedIconUrl, "https://other.example.com/brand-2.svg");
  assert.equal(
    (await put({ url: "https://mcp.other.example.com/mcp", iconUrl: "https://cdn.example.com/x.png" })).status,
    200,
  );
  assert.equal((await store.get("crm"))?.resolvedIconUrl, undefined);
  assert.equal(homepages.length, 2);
});

test("production wiring never uses operator fallback tokens for per-user MCP calls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-wiring-"));
  const previous = process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
  process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = "operator-token";
  const built = buildApp(testConfig({ dataDir: dir, egressServiceHosts: ["accounts.example.com"] }));
  let calls = 0;
  const remote = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === "tools/call") calls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: rpc.id,
        result:
          rpc.method === "tools/list"
            ? { tools: [{ name: "identity", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: req.headers.authorization }] },
      }),
    );
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  t.after(async () => {
    built.mcpToolService.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    if (previous === undefined) delete process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
    else process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await built.mcpServers.put({
    id: "crm",
    name: "CRM",
    url: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`,
    auth: "none",
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    readOnly: true,
    enabled: true,
    updatedAt: Date.now(),
    updatedBy: "internal:admin",
  });
  await built.mcpToolService.refresh();
  assert.equal(
    await built.connectorTokens.connectorAccessToken("accounts.example.com", "internal:alice"),
    "operator-token",
  );
  await assert.rejects(built.mcpToolService.call("crm_identity", {}, "internal:alice"), /Connect your account/);
  assert.equal(calls, 0);
  await built.connectorTokens.setConnectorToken("accounts.example.com", "internal:alice", {
    accessToken: "alice-only",
  });
  assert.equal(await built.mcpToolService.call("crm_identity", {}, "internal:alice"), "Bearer alice-only");
  assert.equal(calls, 1);
});

const GRANOLA_AS = "https://mcp-auth.granola.ai";

function granolaNet() {
  const registrations: Array<Record<string, unknown>> = [];
  const homepageFetches: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (init.method === "POST" && url.origin === "https://mcp.granola.ai") {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"`,
        },
      });
    }
    if (String(input) === "https://granola.ai/") return new Response("", { status: 308 });
    if (String(input) === "https://www.granola.ai/") {
      homepageFetches.push(String(input));
      return new Response(
        '<head><link rel="icon" href="/favicon/favicon.ico" sizes="any"/><link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml"/></head>',
      );
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
      const resource = `${url.origin}${url.pathname.slice("/.well-known/oauth-protected-resource".length)}`;
      return json({ resource, authorization_servers: [GRANOLA_AS], scopes_supported: ["mcp"] });
    }
    if (String(input) === `${GRANOLA_AS}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: GRANOLA_AS,
        authorization_endpoint: `${GRANOLA_AS}/oauth2/authorize`,
        token_endpoint: `${GRANOLA_AS}/oauth2/token`,
        registration_endpoint: `${GRANOLA_AS}/oauth2/register`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      });
    }
    if (String(input) === `${GRANOLA_AS}/oauth2/register`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      registrations.push(body);
      return json(
        {
          client_id: `dcr-client-${registrations.length}`,
          client_secret: "dcr-secret",
          token_endpoint_auth_method: "client_secret_basic",
        },
        201,
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { net: { fetchImpl, lookup: async () => ["34.1.2.3"] }, registrations, homepageFetches };
}

async function serveAdmin(t: { after: (fn: () => Promise<void>) => void }, deps: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-oauth-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const server = createInsecureTestServer(built.app, { admin: built.admin, auditLog: built.auditLog, ...deps });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers`;
  const put = (id: string, body: object) =>
    fetch(`${base}/${id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) });
  return { base, put };
}

function oauthStores(net: ReturnType<typeof granolaNet>["net"]) {
  return createMcpOAuthStores({
    clients: createMemoryMap<McpOAuthClient>(),
    tokens: createMemoryMap<McpUserToken>(),
    catalogs: createMemoryMap<McpCatalog>(),
    key: deriveConnectorKey("mcp-admin-oauth"),
    lock: createMemoryAdvisoryLock(),
    net,
  });
}

test("OAuth MCP servers register via discovery and DCR, reuse the registration, and never return secrets", async (t) => {
  const { net, registrations, homepageFetches } = granolaNet();
  const oauth = oauthStores(net);
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { base, put } = await serveAdmin(t, {
    mcpServers: store,
    mcpOAuth: oauth,
    publicUrl: "https://mo.example.com",
  });
  const granola = { name: "Granola", url: "https://mcp.granola.ai/mcp", auth: "oauth", readOnly: true };

  assert.equal((await put("granola", { ...granola, oauthScopes: 'bad"scope' })).status, 400);
  const saved = await put("granola", { ...granola, credentialScope: "shared", credentialHost: "x.example.com" });
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.doesNotMatch(text, /dcr-secret/);
  const body = JSON.parse(text) as {
    signInRequired: boolean;
    oauth: { clientId: string; redirectUri: string; issuer: string; source: string; scopes: string[] };
    server: { credentialScope: string; credentialHost?: string; hasCatalog: boolean; icon?: string };
  };
  assert.equal(body.server.icon, "https://www.granola.ai/favicon/favicon.svg");
  assert.equal(body.signInRequired, true);
  assert.equal(body.oauth.clientId, "dcr-client-1");
  assert.equal(body.oauth.issuer, GRANOLA_AS);
  assert.equal(body.oauth.source, "dcr");
  assert.deepEqual(body.oauth.scopes, ["mcp"]);
  assert.equal(body.oauth.redirectUri, "https://mo.example.com/v1/connectors/oauth/mcp-granola/callback");
  assert.equal(body.server.credentialScope, "per-user");
  assert.equal(body.server.credentialHost, undefined);
  assert.equal(body.server.hasCatalog, false);
  assert.deepEqual(registrations[0]?.redirect_uris, [body.oauth.redirectUri]);
  assert.equal(registrations[0]?.client_name, "QM (mo.example.com)");
  const stored = await store.get("granola");
  assert.equal(stored?.auth, "oauth");
  assert.equal(stored?.bearerToken, undefined);

  await oauth.tokens.set("granola", "internal:alice", { accessToken: "alice" }, "dcr-client-1");
  await oauth.catalogs.put({ serverId: "granola", tools: [], fetchedAt: 1, fetchedBy: "internal:alice" });
  assert.equal((await put("granola", { ...granola, oauthScopes: "mcp offline_access" })).status, 200);
  assert.equal(registrations.length, 1);
  assert.deepEqual((await store.get("granola"))?.oauthScopes, ["mcp", "offline_access"]);
  assert.equal(await oauth.tokens.accessToken("granola", "internal:alice"), "alice");

  const listed = await fetch(base, { headers: ADMIN });
  const listText = await listed.text();
  assert.doesNotMatch(listText, /dcr-secret|clientSecretEnc/);
  const row = (
    JSON.parse(listText) as { servers: Array<{ id: string; hasCatalog: boolean; oauth?: { clientId: string } }> }
  ).servers.find((s) => s.id === "granola");
  assert.equal(row?.hasCatalog, true);
  assert.equal(row?.oauth?.clientId, "dcr-client-1");

  assert.equal(homepageFetches.length, 1);
  assert.equal((await put("granola", { ...granola, reregister: true })).status, 200);
  assert.equal(registrations.length, 2);
  assert.equal(homepageFetches.length, 2);
  assert.equal(await oauth.tokens.accessToken("granola", "internal:alice"), null);
  assert.equal(await oauth.catalogs.get("granola"), null);

  await oauth.tokens.set("granola", "internal:alice", { accessToken: "alice" }, "dcr-client-2");
  assert.equal((await put("granola", { ...granola, url: "https://mcp.granola.ai/v2/mcp" })).status, 200);
  assert.equal(registrations.length, 3);
  assert.equal(await oauth.tokens.accessToken("granola", "internal:alice"), null);
  assert.equal((await oauth.clients.get("granola"))?.resource, "https://mcp.granola.ai/v2/mcp");

  await oauth.tokens.set("granola", "internal:alice", { accessToken: "alice" }, "dcr-client-3");
  assert.equal((await fetch(`${base}/granola`, { method: "DELETE", headers: ADMIN })).status, 200);
  assert.equal(await oauth.clients.get("granola"), null);
  assert.equal(await oauth.tokens.accessToken("granola", "internal:alice"), null);

  assert.equal((await put("notes", { ...granola })).status, 200);
  assert.equal((await put("notes", { ...granola, auth: "none", validate: false })).status, 200);
  assert.equal(await oauth.clients.get("notes"), null);
});

test("OAuth MCP setup reports missing configuration and discovery failures without storing anything", async (t) => {
  const { net } = granolaNet();
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const noPublic = await serveAdmin(t, { mcpServers: store, mcpOAuth: oauthStores(net) });
  const granola = { url: "https://mcp.granola.ai/mcp", auth: "oauth" };
  const missingUrl = await noPublic.put("granola", granola);
  assert.equal(missingUrl.status, 400);
  assert.match(((await missingUrl.json()) as { message: string }).message, /PUBLIC_WEB_URL/);
  const noKey = await serveAdmin(t, { mcpServers: store, publicUrl: "https://mo.example.com" });
  const missingKey = await noKey.put("granola", granola);
  assert.equal(missingKey.status, 501);
  assert.match(((await missingKey.json()) as { message: string }).message, /CONNECTOR_SECRET_KEY/);
  const broken = await serveAdmin(t, {
    mcpServers: store,
    mcpOAuth: oauthStores({ ...net, lookup: async () => ["10.0.0.1"] }),
    publicUrl: "https://mo.example.com",
  });
  const failed = await broken.put("granola", granola);
  assert.equal(failed.status, 400);
  assert.match(((await failed.json()) as { message: string }).message, /public network address/);
  assert.equal(await store.get("granola"), null);
});
