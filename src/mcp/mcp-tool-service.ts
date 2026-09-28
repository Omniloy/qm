// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import { LRUCache } from "lru-cache";
import type { ConnectorTokenStore } from "../credentials/keychain.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { withTimeout } from "../util/async.ts";
import { hashId } from "../util/crypto.ts";
import { errMessage, swallow } from "../util/errors.ts";
import {
  createMcpClient,
  McpHttpError,
  mcpResultText,
  type McpAuth,
  type McpClient,
  type McpFetch,
} from "./mcp-client.ts";
import type { McpCatalogStore, McpCatalogTool, McpUserTokenStore } from "./mcp-oauth-store.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const CATALOG_SYNC_INTERVAL_MS = 60_000;
const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
const CATALOG_CAPTURE_TIMEOUT_MS = 10_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_RESULT_CHARS = 60_000;

class McpConnectRequiredError extends Error {
  constructor(server: Pick<McpServer, "name">, connectUrl?: string) {
    super(
      `${server.name} isn't connected for you. Ask the user to connect it at ${connectUrl ?? "Keychain in the web app"}, then retry.`,
    );
    this.name = "McpConnectRequiredError";
  }
}

export interface McpToolDescriptor {
  /** Namespaced tool name exposed to the model, e.g. "salesforce_query". */
  name: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpToolService {
  /** Current snapshot of injectable tools across enabled servers. */
  toolDefs(): McpToolDescriptor[];
  /** Call a namespaced tool. Returns the tool's text output (clamped). */
  call(name: string, args: Record<string, unknown>, principalId?: string): Promise<string>;
  /** Force a registry re-read + tools/list refresh (admin save path, tests). */
  refresh(): Promise<void>;
  /** Probe a server config without persisting it. Returns its tool names. */
  probe(server: McpServer): Promise<string[]>;
  captureCatalog(serverId: string, principalId: string): Promise<number>;
  close(): void;
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials")
    return { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: server.clientSecret ?? "" };
  return { mode: "none" };
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  userTokens?: Pick<ConnectorTokenStore, "connectorAccessToken">;
  oauth?: {
    tokens: Pick<McpUserTokenStore, "accessToken" | "forceRefresh" | "markNeedsReconnect">;
    catalogs: McpCatalogStore;
  };
  connectUrl?: (serverId: string) => string;
  fetchImpl?: McpFetch;
  now?: () => number;
  refreshIntervalMs?: number;
  catalogSyncIntervalMs?: number;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; server: McpServer }>();
  const oauthClients = new LRUCache<string, McpClient>({ max: 500 });
  const catalogFetchedAt = new Map<string, number>();
  let byServer = new Map<string, McpToolDescriptor[]>();
  let snapshot: McpToolDescriptor[] = [];
  let closed = false;

  function record(action: string, resource: string, status: string, principalId?: string): void {
    opts.audit?.record({
      at: now(),
      principalId: principalId || "system",
      action: `mcp.${action}`,
      resource,
      scopeLabel: "mcp-connectors",
      status,
    });
  }

  function clientFor(server: McpServer): McpClient {
    const cached = clients.get(server.id);
    if (cached && JSON.stringify(cached.server) === JSON.stringify(server)) return cached.client;
    const client = createMcpClient({
      url: server.url,
      auth: authOf(server),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
    });
    clients.set(server.id, { client, server });
    return client;
  }

  async function callerClient(server: McpServer, principalId?: string): Promise<McpClient> {
    if ((server.credentialScope ?? "shared") === "shared") return clientFor(server);
    if (server.credentialScope !== "per-user") throw new Error("invalid MCP credential scope");
    if (!principalId || !server.credentialHost || !opts.userTokens) {
      throw new Error(`MCP server ${server.id} requires a connected user account`);
    }
    const token = await opts.userTokens.connectorAccessToken(
      server.credentialHost,
      principalId,
      server.credentialAccountType,
    );
    if (!token) throw new Error(`Connect your account for MCP server ${server.id} before using this tool`);
    return createMcpClient({
      url: server.url,
      auth: { mode: "bearer", token },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
    });
  }

  function describe(server: McpServer, tools: McpCatalogTool[]): McpToolDescriptor[] {
    return tools.slice(0, MAX_TOOLS_PER_SERVER).map((tool) => ({
      name: `${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
      serverId: server.id,
      remoteName: tool.name,
      description: tool.description || `${tool.name} on ${server.name}`,
      inputSchema: tool.inputSchema,
      readOnly: server.readOnly,
    }));
  }

  function publish(servers: McpServer[]): void {
    const seen = new Set<string>();
    snapshot = servers
      .flatMap((server) => byServer.get(server.id) ?? [])
      .filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  }

  async function catalogTools(server: McpServer): Promise<McpCatalogTool[]> {
    const catalog = await opts.oauth?.catalogs.get(server.id);
    if (catalog) catalogFetchedAt.set(server.id, catalog.fetchedAt);
    else catalogFetchedAt.delete(server.id);
    return catalog?.tools ?? [];
  }

  async function enabledServers(): Promise<McpServer[]> {
    return (await opts.servers.list()).filter((s) => s.enabled);
  }

  async function refresh(): Promise<void> {
    const servers = await enabledServers();
    const next = new Map<string, McpToolDescriptor[]>();
    for (const server of servers) {
      try {
        const tools = describe(
          server,
          server.auth === "oauth" ? await catalogTools(server) : await clientFor(server).listTools(),
        );
        next.set(server.id, tools);
        record("list", server.id, `ok tools=${tools.length}`);
      } catch (e) {
        record("list", server.id, `error: ${errMessage(e)}`);
      }
    }
    byServer = next;
    publish(servers);
  }

  async function syncCatalogs(): Promise<void> {
    const servers = await enabledServers();
    for (const server of servers.filter((s) => s.auth === "oauth")) {
      byServer.set(server.id, describe(server, await catalogTools(server)));
    }
    publish(servers);
  }

  function oauthClient(server: McpServer, token: string): McpClient {
    const key = `${server.id}\0${server.url}\0${hashId([token])}`;
    let client = oauthClients.get(key);
    if (!client) {
      client = createMcpClient({
        url: server.url,
        auth: { mode: "bearer", token },
        session: true,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
      });
      oauthClients.set(key, client);
    }
    return client;
  }

  async function storeCatalog(server: McpServer, client: McpClient, principalId: string): Promise<number> {
    const tools = (await withTimeout(() => client.listTools(), CATALOG_CAPTURE_TIMEOUT_MS, "mcp tools/list")).slice(
      0,
      MAX_TOOLS_PER_SERVER,
    );
    const fetchedAt = now();
    await opts.oauth!.catalogs.put({ serverId: server.id, tools, fetchedAt, fetchedBy: principalId });
    catalogFetchedAt.set(server.id, fetchedAt);
    byServer.set(server.id, describe(server, tools));
    publish(await enabledServers());
    record("list", server.id, `ok tools=${tools.length}`, principalId);
    return tools.length;
  }

  async function callOAuth(server: McpServer, remoteName: string, args: Record<string, unknown>, principalId?: string) {
    const oauth = opts.oauth;
    if (!oauth) throw new Error(`MCP server ${server.id} needs sign-in, which is not configured on this deployment`);
    const connectRequired = () => new McpConnectRequiredError(server, opts.connectUrl?.(server.id));
    if (!principalId) throw connectRequired();
    const token = await oauth.tokens.accessToken(server.id, principalId);
    if (!token) throw connectRequired();
    const unauthorized = (e: unknown) => e instanceof McpHttpError && e.status === 401;
    let client = oauthClient(server, token);
    let result;
    try {
      result = await client.callTool(remoteName, args);
    } catch (e) {
      if (!unauthorized(e)) throw e;
      const fresh = await oauth.tokens.forceRefresh(server.id, principalId);
      try {
        if (!fresh) throw e;
        client = oauthClient(server, fresh);
        result = await client.callTool(remoteName, args);
      } catch (retryError) {
        if (!unauthorized(retryError)) throw retryError;
        await oauth.tokens.markNeedsReconnect(server.id, principalId, "the MCP server rejected the access token");
        throw connectRequired();
      }
    }
    if (now() - (catalogFetchedAt.get(server.id) ?? 0) > CATALOG_MAX_AGE_MS) {
      catalogFetchedAt.set(server.id, now());
      void storeCatalog(server, client, principalId).catch((e: unknown) =>
        swallow(`mcp catalog refresh ${server.id}`, e),
      );
    }
    return result;
  }

  const unsubscribe = opts.servers.onChange(() => {
    void refresh();
  });
  const timer = setInterval(() => {
    if (!closed) void refresh();
  }, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  const catalogTimer = opts.oauth
    ? setInterval(() => {
        if (!closed) void syncCatalogs().catch((e: unknown) => swallow("mcp catalog sync", e));
      }, opts.catalogSyncIntervalMs ?? CATALOG_SYNC_INTERVAL_MS)
    : undefined;
  catalogTimer?.unref?.();
  void refresh();

  return {
    toolDefs: () => snapshot,
    async call(name, args, principalId) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
      try {
        const result =
          server.auth === "oauth"
            ? await callOAuth(server, def.remoteName, args, principalId)
            : await (await callerClient(server, principalId)).callTool(def.remoteName, args);
        record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
        const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
      } catch (e) {
        record("call", `${def.serverId}/${def.remoteName}`, `error: ${errMessage(e)}`, principalId);
        throw e;
      }
    },
    refresh,
    async probe(server) {
      if (server.auth === "oauth") throw new Error("OAuth MCP servers list tools with a signed-in user's token");
      const client = createMcpClient({
        url: server.url,
        auth: authOf(server),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
      });
      const tools = await client.listTools();
      return tools.map((t) => t.name);
    },
    async captureCatalog(serverId, principalId) {
      const server = await opts.servers.get(serverId);
      if (!server || server.auth !== "oauth" || !opts.oauth)
        throw new Error(`MCP server ${serverId} does not use sign-in`);
      const token = await opts.oauth.tokens.accessToken(serverId, principalId);
      if (!token) throw new McpConnectRequiredError(server, opts.connectUrl?.(serverId));
      return storeCatalog(server, oauthClient(server, token), principalId);
    },
    close() {
      closed = true;
      clearInterval(timer);
      clearInterval(catalogTimer);
      unsubscribe();
    },
  };
}
