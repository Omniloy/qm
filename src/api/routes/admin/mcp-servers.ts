// Admin CRUD for registered MCP servers.
//
// Registration is deliberately admin-only: a registered server is an outbound
// HTTP destination every scope's agents can call, so it is governed like a
// model-provider credential, not like a personal connector.

import { resolveMcpSiteIcon } from "../../../mcp/mcp-icon.ts";
import type { McpOAuthRegistration } from "../../../mcp/mcp-oauth.ts";
import {
  isValidMcpServerId,
  mcpServerIcon,
  parseMcpIconUrl,
  singleLineName,
  type McpServer,
  type McpServerAuthMode,
} from "../../../mcp/mcp-server-store.ts";
import { swallow } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { mcpOAuthView, purgeMcpOAuth, registerMcpOAuthClient } from "../mcp-oauth.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials", "oauth"];
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const MAX_SCOPES = 20;
const ICON_RECHECK_MS = 24 * 60 * 60 * 1000;

function parseScopes(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const list = typeof value === "string" ? value.split(/[\s,]+/) : value;
  if (!Array.isArray(list)) return null;
  const scopes = [...new Set(list.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean))];
  if (scopes.length > MAX_SCOPES || scopes.some((s) => !SCOPE_TOKEN.test(s))) return null;
  return scopes.length ? scopes : undefined;
}

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

function redact(server: McpServer, registration?: McpOAuthRegistration | null, hasCatalog?: boolean) {
  const { bearerToken, clientSecret, ...rest } = server;
  return {
    ...rest,
    icon: mcpServerIcon(server),
    hasBearerToken: !!bearerToken,
    hasClientSecret: !!clientSecret,
    ...(server.auth === "oauth"
      ? {
          ...(registration && registration.serverUrl === server.url ? { oauth: mcpOAuthView(registration) } : {}),
          hasCatalog: !!hasCatalog,
        }
      : {}),
  };
}

async function redactWithOAuth(ctx: ApiCtx, server: McpServer) {
  if (server.auth !== "oauth" || !ctx.deps.mcpOAuth) return redact(server);
  const [registration, catalog] = await Promise.all([
    ctx.deps.mcpOAuth.clients.get(server.id),
    ctx.deps.mcpOAuth.catalogs.get(server.id),
  ]);
  return redact(server, registration, !!catalog);
}

function siteIconDue(server: McpServer, existing: McpServer | null, reregister: boolean): boolean {
  if (server.iconUrl) return false;
  const checkedAt = existing?.url === server.url ? existing.resolvedIconCheckedAt : undefined;
  return reregister || checkedAt === undefined || server.updatedAt - checkedAt >= ICON_RECHECK_MS;
}

async function refreshSiteIcon(ctx: ApiCtx, saved: McpServer): Promise<void> {
  const net = ctx.deps.mcpOAuth?.net;
  const store = ctx.deps.mcpServers;
  if (!net || !store) return;
  const resolvedIconUrl = (await resolveMcpSiteIcon(saved.url, net)) ?? saved.resolvedIconUrl;
  await store.updateIf(saved.id, (current) =>
    current.url !== saved.url || current.iconUrl || current.updatedAt !== saved.updatedAt
      ? null
      : { ...current, ...(resolvedIconUrl ? { resolvedIconUrl } : {}), resolvedIconCheckedAt: Date.now() },
  );
}

function refreshSiteIconIfDue(ctx: ApiCtx, server: McpServer, existing: McpServer | null, reregister: boolean) {
  if (!siteIconDue(server, existing, reregister)) return;
  void refreshSiteIcon(ctx, server).catch((e: unknown) => swallow(`mcp site icon for ${server.id}`, e));
}

export async function getMcpServers(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.read",
    resource: "mcp-servers",
    scopeLabel: orgScope(ctx.deps),
  });
  const servers = await ctx.deps.mcpServers.list();
  return sendJson(ctx.res, 200, {
    servers: await Promise.all(servers.map((server) => redactWithOAuth(ctx, server))),
    tools: ctx.deps.mcpToolService?.toolDefs().map(({ name, serverId, description, readOnly }) => ({
      name,
      serverId,
      description,
      readOnly,
    })),
  });
}

export async function putMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  if (!isValidMcpServerId(id)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "id must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter",
    });
  }
  const b = ctx.body as Partial<Omit<McpServer, "oauthScopes" | "iconUrl">> & {
    iconUrl?: unknown;
    validate?: boolean;
    reregister?: unknown;
    oauthScopes?: unknown;
    oauthClientId?: unknown;
    oauthClientSecret?: unknown;
  };
  const url = typeof b.url === "string" ? b.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must be a valid URL" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must be http(s)" });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "url must not carry credentials, query, or fragment",
    });
  }
  const auth = (b.auth ?? "none") as McpServerAuthMode;
  if (!AUTH_MODES.includes(auth)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `auth must be one of ${AUTH_MODES.join(", ")}` });
  }
  const existing = await ctx.deps.mcpServers.get(id);
  const oauth = auth === "oauth";
  const inheritedScope = existing?.auth === "oauth" ? undefined : existing?.credentialScope;
  const credentialScope = oauth ? "per-user" : (b.credentialScope ?? inheritedScope ?? "shared");
  if (credentialScope !== "shared" && credentialScope !== "per-user") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "credentialScope must be shared or per-user" });
  }
  const credentialHost = b.credentialHost ?? existing?.credentialHost;
  const credentialAccountType = b.credentialAccountType ?? existing?.credentialAccountType ?? "default";
  if (!["default", "personal", "company"].includes(credentialAccountType)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "credentialAccountType must be default, personal, or company",
    });
  }
  if (
    credentialScope === "per-user" &&
    !oauth &&
    (typeof credentialHost !== "string" ||
      !credentialHost ||
      credentialHost !== credentialHost.trim() ||
      credentialHost.length > 253 ||
      /[\s/\\?#@]/.test(credentialHost))
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "per-user credentials require a credentialHost" });
  }
  if (
    credentialScope === "per-user" &&
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "per-user credentials require HTTPS (except loopback)",
    });
  }
  const iconUrl = b.iconUrl === undefined ? existing?.iconUrl : parseMcpIconUrl(b.iconUrl);
  if (iconUrl === null) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "iconUrl must be an https image URL of at most 2048 characters without spaces or quotes",
    });
  }
  let oauthScopes: string[] | undefined | null;
  if (oauth) oauthScopes = b.oauthScopes === undefined ? existing?.oauthScopes : parseScopes(b.oauthScopes);
  if (oauthScopes === null) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "oauthScopes must be up to 20 OAuth scope tokens" });
  }
  const manualClientId =
    typeof b.oauthClientId === "string" && b.oauthClientId.trim() ? b.oauthClientId.trim() : undefined;
  const manualClientSecret =
    typeof b.oauthClientSecret === "string" && b.oauthClientSecret ? b.oauthClientSecret : undefined;
  const server: McpServer = {
    id,
    name: (typeof b.name === "string" && singleLineName(b.name)) || id,
    url,
    ...(iconUrl ? { iconUrl } : {}),
    ...(!iconUrl && existing?.url === url
      ? { resolvedIconUrl: existing.resolvedIconUrl, resolvedIconCheckedAt: existing.resolvedIconCheckedAt }
      : {}),
    auth,
    credentialScope,
    ...(credentialScope === "per-user" && !oauth ? { credentialHost, credentialAccountType } : {}),
    ...(oauthScopes ? { oauthScopes } : {}),
    ...(auth === "bearer"
      ? { bearerToken: typeof b.bearerToken === "string" && b.bearerToken ? b.bearerToken : existing?.bearerToken }
      : {}),
    ...(auth === "client-credentials"
      ? {
          clientId: typeof b.clientId === "string" && b.clientId ? b.clientId : existing?.clientId,
          clientSecret: typeof b.clientSecret === "string" && b.clientSecret ? b.clientSecret : existing?.clientSecret,
        }
      : {}),
    readOnly: b.readOnly !== false,
    enabled: b.enabled !== false,
    updatedAt: Date.now(),
    updatedBy: authorized.id,
  };
  if (auth === "bearer" && !server.bearerToken) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "bearer auth requires bearerToken" });
  }
  if (auth === "client-credentials" && (!server.clientId || !server.clientSecret)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "client-credentials auth requires clientId and clientSecret",
    });
  }
  if (oauth) {
    const result = await registerMcpOAuthClient(ctx.deps, {
      server,
      reregister: b.reregister === true,
      ...(manualClientId ? { manualClientId } : {}),
      ...(manualClientSecret ? { manualClientSecret } : {}),
      actorId: authorized.id,
    });
    if (!result.ok) return sendJson(ctx.res, result.status, { error: "oauth_setup_failed", message: result.message });
    if (result.registered || (existing && existing.url !== url)) await purgeMcpOAuth(ctx.deps, id);
    await ctx.deps.mcpOAuth!.clients.put(result.registration);
    await ctx.deps.mcpServers.put(server);
    refreshSiteIconIfDue(ctx, server, existing, b.reregister === true);
    audit(ctx.deps, {
      principalId: authorized.id,
      action: "mcp-servers.update",
      resource: id,
      scopeLabel: orgScope(ctx.deps),
    });
    if (result.registered) {
      audit(ctx.deps, {
        principalId: authorized.id,
        action: "mcp.oauth.register",
        resource: id,
        scopeLabel: orgScope(ctx.deps),
        detail: `${result.registration.source} client at ${result.registration.issuer}`,
      });
    }
    return sendJson(ctx.res, 200, {
      ok: true,
      server: redact(server, result.registration, !result.registered && !!(await ctx.deps.mcpOAuth!.catalogs.get(id))),
      oauth: mcpOAuthView(result.registration),
      signInRequired: true,
    });
  }
  let toolNames: string[] | undefined;
  if (b.validate !== false && ctx.deps.mcpToolService) {
    try {
      toolNames = await ctx.deps.mcpToolService.probe(server);
    } catch (e) {
      return sendJson(ctx.res, 400, {
        error: "unreachable",
        message: `tools/list against ${parsed.host} failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  if (existing?.auth === "oauth") await purgeMcpOAuth(ctx.deps, id);
  await ctx.deps.mcpServers.put(server);
  refreshSiteIconIfDue(ctx, server, existing, b.reregister === true);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, server: redact(server), ...(toolNames ? { tools: toolNames } : {}) });
}

export async function deleteMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  if (!(await ctx.deps.mcpServers.get(id))) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.mcpServers.delete(id);
  await purgeMcpOAuth(ctx.deps, id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
