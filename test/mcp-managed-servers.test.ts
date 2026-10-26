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
import { loadConfig } from "../src/config.ts";
import { testConfig } from "./support/test-config.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { managedMcpServers } from "../src/mcp/managed-mcp-servers.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const SIDECAR = "http://ms365-mcp:3000/mcp";

const manual: McpServer = {
  id: "microsoft-365",
  name: "M365 (manual)",
  url: "http://old-sidecar:3000/mcp",
  auth: "none",
  credentialScope: "per-user",
  credentialHost: "graph.microsoft.com",
  readOnly: true,
  enabled: true,
  updatedAt: 1,
  updatedBy: "admin-alice@default-org",
};

function managedStore(ms365McpUrl: string | undefined, configured: { microsoft: boolean }) {
  const providers: string[] = [];
  const store = createMcpServerStore(
    createMemoryMap<McpServer>(),
    managedMcpServers({
      ms365McpUrl,
      providerConfigured: async (provider) => {
        providers.push(provider);
        return provider === "microsoft" && configured.microsoft;
      },
    }),
  );
  return { store, providers };
}

test("no sidecar URL means no managed server, and a stored microsoft-365 row stays an ordinary server", async () => {
  const { store, providers } = managedStore(undefined, { microsoft: true });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get("microsoft-365"), null);
  assert.equal(store.isManaged("microsoft-365"), false);
  await store.put(manual);
  assert.deepEqual(await store.get("microsoft-365"), manual);
  assert.deepEqual(providers, [], "nothing is resolved without a sidecar");
});

test("a sidecar URL without a Microsoft OAuth app yields no server", async () => {
  const { store } = managedStore(SIDECAR, { microsoft: false });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get("microsoft-365"), null);
  assert.equal(store.isManaged("microsoft-365"), true, "the id stays reserved");
});

test("sidecar plus Microsoft OAuth app yields the server with exact settings, and removing the app removes it", async () => {
  const configured = { microsoft: true };
  const { store } = managedStore(SIDECAR, configured);
  const expected: McpServer = {
    id: "microsoft-365",
    name: "Microsoft 365",
    url: SIDECAR,
    auth: "none",
    credentialScope: "per-user",
    credentialHost: "graph.microsoft.com",
    credentialAccountType: "default",
    toolMode: "discovery",
    readOnly: false,
    enabled: true,
    managed: true,
    updatedAt: 0,
    updatedBy: "deployment",
  };
  assert.deepEqual(await store.list(), [expected]);
  assert.deepEqual(await store.get("microsoft-365"), expected);
  configured.microsoft = false;
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get("microsoft-365"), null);
});

test("the store refuses writes to a managed id, whether or not the server is currently present", async () => {
  const configured = { microsoft: true };
  const backing = createMemoryMap<McpServer>();
  await backing.put(manual.id, manual);
  const store = createMcpServerStore(
    backing,
    managedMcpServers({ ms365McpUrl: SIDECAR, providerConfigured: async () => configured.microsoft }),
  );
  for (const present of [true, false]) {
    configured.microsoft = present;
    await assert.rejects(store.put({ ...manual, url: "https://evil.example.com/mcp" }), /managed by the deployment/);
    await assert.rejects(
      store.updateIf("microsoft-365", (current) => ({ ...current, url: "https://evil.example.com/mcp" })),
      /managed by the deployment/,
    );
    await assert.rejects(store.delete("microsoft-365"), /managed by the deployment/);
  }
  assert.deepEqual(await backing.get("microsoft-365"), manual, "the stored row is untouched");
  await store.put({ ...manual, id: "crm", url: "https://crm.example.com/mcp" });
  await store.delete("crm");
  assert.equal(await store.get("crm"), null, "other ids stay writable");
});

test("with a sidecar URL a hand-registered microsoft-365 row is never served, and other servers are untouched", async () => {
  const configured = { microsoft: true };
  const backing = createMemoryMap<McpServer>();
  await backing.put(manual.id, manual);
  const providers: string[] = [];
  const store = createMcpServerStore(
    backing,
    managedMcpServers({
      ms365McpUrl: SIDECAR,
      providerConfigured: async (provider) => {
        providers.push(provider);
        return configured.microsoft;
      },
    }),
  );
  await store.put({ ...manual, id: "crm", name: "CRM", url: "https://crm.example.com/mcp" });
  providers.length = 0;
  assert.equal((await store.get("crm"))?.url, "https://crm.example.com/mcp");
  assert.deepEqual(providers, [], "looking up another server does not resolve the OAuth app");
  assert.deepEqual(
    (await store.list()).map((s) => [s.id, s.url, s.managed ?? false]),
    [
      ["crm", "https://crm.example.com/mcp", false],
      ["microsoft-365", SIDECAR, true],
    ],
  );
  configured.microsoft = false;
  assert.equal(await store.get("microsoft-365"), null, "removing the app does not bring the old row back");
  assert.deepEqual(
    (await store.list()).map((s) => s.id),
    ["crm"],
  );
});

test("a failed OAuth app lookup fails the read instead of dropping or swapping the server", async () => {
  const backing = createMemoryMap<McpServer>();
  await backing.put(manual.id, manual);
  const store = createMcpServerStore(
    backing,
    managedMcpServers({
      ms365McpUrl: SIDECAR,
      providerConfigured: async () => {
        throw new Error("database unavailable");
      },
    }),
  );
  await assert.rejects(store.list(), /database unavailable/);
  await assert.rejects(store.get("microsoft-365"), /database unavailable/);
});

test("MS365_MCP_URL must be a plain http(s) URL", () => {
  assert.equal(loadConfig({ MS365_MCP_URL: " http://ms365-mcp:3000/mcp " }).ms365McpUrl, SIDECAR);
  assert.equal(loadConfig({}).ms365McpUrl, undefined);
  assert.throws(() => loadConfig({ MS365_MCP_URL: "ms365-mcp:3000" }), /MS365_MCP_URL/);
  assert.throws(() => loadConfig({ MS365_MCP_URL: "http://u:p@ms365-mcp:3000/mcp" }), /MS365_MCP_URL/);
});

test("saving the Microsoft OAuth app sets up the managed tools server, which admins cannot edit or remove", async (t) => {
  const sidecar = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result:
          rpc.method === "tools/list"
            ? { tools: [{ name: "list-chats", inputSchema: { type: "object" } }] }
            : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } },
      }),
    );
  });
  sidecar.listen(0, "127.0.0.1");
  await once(sidecar, "listening");
  const sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}/mcp`;
  const envBefore = { id: process.env.MICROSOFT_OAUTH_CLIENT_ID, secret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET };
  delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
  delete process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
  const dir = await mkdtemp(join(tmpdir(), "mcp-managed-"));
  const built = buildApp(testConfig({ dataDir: dir, ms365McpUrl: sidecarUrl }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    config: built.config,
    resolveClient: built.resolveClient,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    built.mcpToolService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => sidecar.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    if (envBefore.id !== undefined) process.env.MICROSOFT_OAUTH_CLIENT_ID = envBefore.id;
    if (envBefore.secret !== undefined) process.env.MICROSOFT_OAUTH_CLIENT_SECRET = envBefore.secret;
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin`;
  const servers = async () =>
    ((await (await fetch(`${base}/mcp-servers`, { headers: ADMIN })).json()) as { servers: McpServer[] }).servers;
  const connector = (body: object) =>
    fetch(`${base}/scopes/org:default-org/connectors`, { method: "PUT", headers: ADMIN, body: JSON.stringify(body) });

  assert.deepEqual(await servers(), []);
  assert.equal((await connector({ provider: "microsoft", clientId: "ms-cid", clientSecret: "ms-secret" })).status, 200);
  const [ms365] = await servers();
  assert.equal(ms365?.id, "microsoft-365");
  assert.equal(ms365?.url, sidecarUrl);
  assert.equal(ms365?.managed, true);
  assert.equal(ms365?.toolMode, "discovery");
  assert.deepEqual(
    built.mcpToolService.toolDefs().map((d) => [d.serverId, d.remoteName, d.toolMode, d.credentialHost]),
    [["microsoft-365", "list-chats", "discovery", "graph.microsoft.com"]],
    "the save answers once the tool service has picked the server up, without a restart",
  );

  const edit = await fetch(`${base}/mcp-servers/microsoft-365`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify({ url: "https://evil.example.com/mcp", validate: false, toolMode: "full" }),
  });
  assert.equal(edit.status, 409);
  assert.equal((await fetch(`${base}/mcp-servers/microsoft-365`, { method: "DELETE", headers: ADMIN })).status, 409);
  assert.equal((await servers())[0]?.url, sidecarUrl);

  const microsoft = { provider: "microsoft", clientId: "ms-cid", clientSecret: "ms-secret" };
  assert.equal((await connector({ ...microsoft, enabled: false })).status, 200);
  assert.deepEqual(await servers(), [], "disabling the OAuth app turns the server off");
  assert.equal((await connector(microsoft)).status, 200);
  assert.equal((await servers())[0]?.id, "microsoft-365");

  assert.equal((await connector({ provider: "microsoft", delete: true })).status, 200);
  assert.deepEqual(await servers(), []);
  assert.deepEqual(built.mcpToolService.toolDefs(), [], "removing the OAuth app removes its tools");
  const register = await fetch(`${base}/mcp-servers/microsoft-365`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify({ url: "https://graph-proxy.example.com/mcp", validate: false }),
  });
  assert.equal(register.status, 409, "the reserved id can't be registered by hand while the sidecar is configured");
});
