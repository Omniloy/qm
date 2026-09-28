import { orgId as configOrgId } from "../../config.ts";
import { codeChallengeS256, generateCodeVerifier } from "../../connectors/oauth.ts";
import { PORTAL_IDENTITY_HEADER, verifyPortalIdentity } from "../../auth/portal-identity.ts";
import { samePerson } from "../../directory/person.ts";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  manualRegistration,
  McpOAuthError,
  registerClient,
  revokeToken,
  sameIssuer,
  type McpOAuthRegistration,
} from "../../mcp/mcp-oauth.ts";
import { clientRefFor } from "../../mcp/mcp-oauth-store.ts";
import type { McpServer } from "../../mcp/mcp-server-store.ts";
import { errMessage, swallow } from "../../util/errors.ts";
import type { ServerDeps } from "../deps.ts";
import { sendJson, sendRedirect } from "../http.ts";
import type { ApiCtx, BaseCtx } from "./route.ts";
import { audit } from "./shared.ts";

const PROVIDER_PREFIX = "mcp-";
const FLOW_MAX_AGE_MS = 10 * 60_000;

const mcpProviderName = (serverId: string): string => `${PROVIDER_PREFIX}${serverId}`;

function mcpRedirectUri(publicUrl: string, serverId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/v1/connectors/oauth/${mcpProviderName(serverId)}/callback`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function mcpOAuthServer(deps: ServerDeps, provider: string): Promise<McpServer | null> {
  if (!provider.startsWith(PROVIDER_PREFIX) || !deps.mcpServers) return null;
  const server = await deps.mcpServers.get(provider.slice(PROVIDER_PREFIX.length));
  return server?.auth === "oauth" ? server : null;
}

async function currentRegistration(deps: ServerDeps, server: McpServer): Promise<McpOAuthRegistration | null> {
  const registration = await deps.mcpOAuth?.clients.get(server.id);
  return registration && registration.serverUrl === server.url ? registration : null;
}

export async function mcpOAuthStart(ctx: ApiCtx, server: McpServer, returnTo: string | undefined): Promise<void> {
  const { res, deps, url } = ctx;
  const provider = mcpProviderName(server.id);
  const principalId = url.searchParams.get("principalId") ?? "";
  const redirectUri = url.searchParams.get("redirectUri") ?? "";
  if (!principalId || !redirectUri)
    return sendJson(res, 400, { error: "bad_request", message: "principalId and redirectUri required" });
  if (!server.enabled) return sendJson(res, 404, { error: "not_found", message: `${server.name} is disabled` });
  if (!deps.oauthFlows || !deps.mcpOAuth)
    return sendJson(res, 501, { error: "oauth_not_configured", message: "MCP sign-in is not configured" });
  const registration = await currentRegistration(deps, server);
  if (!registration)
    return sendJson(res, 501, {
      error: "oauth_not_configured",
      message: `${server.name} has no sign-in registration; an admin must save it again`,
    });
  if (redirectUri !== registration.redirectUri)
    return sendJson(res, 400, {
      error: "redirect_not_allowed",
      message: "redirectUri is not registered for this client",
    });
  const codeVerifier = generateCodeVerifier();
  const state = await deps.oauthFlows.start({
    provider,
    principalId,
    redirectUri,
    orgId: configOrgId(),
    clientRef: clientRefFor(registration),
    codeVerifier,
    ...(returnTo ? { returnTo } : {}),
  });
  audit(deps, { principalId, action: "mcp.oauth.start", resource: provider, scopeLabel: principalId });
  return sendJson(res, 200, {
    provider,
    principalId,
    hosts: [hostOf(server.url)],
    authorizeUrl: authorizeUrl(registration, {
      state,
      codeChallenge: codeChallengeS256(codeVerifier),
      ...(server.oauthScopes ? { scopes: server.oauthScopes } : {}),
    }),
  });
}

async function browserPrincipal(ctx: BaseCtx): Promise<string | null> {
  const psecret = ctx.deps.portalIdentitySecret ?? ctx.secret;
  const raw = ctx.req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || !psecret) return null;
  return (await verifyPortalIdentity(token, psecret, Date.now()))?.p ?? null;
}

export async function mcpOAuthCallback(ctx: BaseCtx, server: McpServer): Promise<void> {
  const { res, deps, url } = ctx;
  const provider = mcpProviderName(server.id);
  const stateParam = url.searchParams.get("state") ?? "";
  const flow = stateParam && deps.oauthFlows ? await deps.oauthFlows.finish(stateParam) : null;
  if (
    !flow ||
    flow.provider !== provider ||
    (flow.orgId !== undefined && flow.orgId !== configOrgId()) ||
    !deps.replayDedupe ||
    !(await deps.replayDedupe.claim(`oauth:${flow.nonce}`, flow.issuedAt + FLOW_MAX_AGE_MS))
  ) {
    return sendJson(res, 400, {
      error: "oauth_callback_failed",
      message: "invalid, expired, or already used OAuth state",
    });
  }
  const finish = (status: "connected" | "error") => {
    if (!flow.returnTo) {
      return status === "connected"
        ? sendJson(res, 200, { ok: true, provider, principalId: flow.principalId })
        : sendJson(res, 400, { error: "oauth_callback_failed", message: `${server.name} sign-in failed` });
    }
    const dest = new URL(flow.returnTo, "http://localhost");
    dest.searchParams.set("connector", provider);
    dest.searchParams.set("status", status);
    return sendRedirect(res, `${dest.pathname}${dest.search}${dest.hash}`);
  };
  try {
    const browser = await browserPrincipal(ctx);
    if ((browser || deps.requireSignedPortalIdentity || deps.production) && !samePerson(browser, flow.principalId)) {
      throw new McpOAuthError("sign-in must finish in the browser session of the person who started it");
    }
    const denied = url.searchParams.get("error");
    if (denied) throw new McpOAuthError(`authorization was not granted (${denied})`);
    const code = url.searchParams.get("code") ?? "";
    if (!code || !flow.codeVerifier) throw new McpOAuthError("authorization response is missing the code");
    const registration = await currentRegistration(deps, server);
    if (!registration || !deps.mcpOAuth || flow.clientRef !== clientRefFor(registration)) {
      throw new McpOAuthError("the sign-in registration changed; start again");
    }
    const iss = url.searchParams.get("iss");
    if ((registration.issParameterSupported && !iss) || (iss !== null && !sameIssuer(iss, registration.issuer))) {
      throw new McpOAuthError("authorization response came from an unexpected issuer");
    }
    const tokens = await exchangeCode(registration, { code, codeVerifier: flow.codeVerifier }, deps.mcpOAuth.net);
    await deps.mcpOAuth.tokens.set(server.id, flow.principalId, tokens, registration.clientId);
  } catch (e) {
    audit(deps, {
      principalId: flow.principalId,
      action: "mcp.oauth.connected",
      resource: provider,
      scopeLabel: flow.principalId,
      status: "error",
      detail: errMessage(e),
    });
    return finish("error");
  }
  audit(deps, {
    principalId: flow.principalId,
    action: "mcp.oauth.connected",
    resource: provider,
    scopeLabel: flow.principalId,
  });
  await deps.mcpToolService
    ?.captureCatalog(server.id, flow.principalId)
    .catch((e: unknown) => swallow(`mcp catalog capture ${server.id}`, e));
  return finish("connected");
}

export async function mcpConnectorStatus(deps: ServerDeps, principalId: string): Promise<Record<string, unknown>> {
  const oauth = deps.mcpOAuth;
  if (!deps.mcpServers || !oauth) return {};
  const servers = (await deps.mcpServers.list()).filter((s) => s.enabled && s.auth === "oauth");
  const entries = await Promise.all(
    servers.map(async (server) => {
      const [status, registration] = await Promise.all([
        oauth.tokens.status(server.id, principalId),
        currentRegistration(deps, server),
      ]);
      return [
        mcpProviderName(server.id),
        {
          kind: "mcp",
          name: server.name,
          hosts: [{ host: hostOf(server.url), ...status }],
          connected: status.connected,
          ...(status.needsReconnect ? { needsReconnect: true } : {}),
          ...(status.refreshFailedAt !== undefined ? { refreshFailedAt: status.refreshFailedAt } : {}),
          ...(status.refreshError ? { refreshError: status.refreshError } : {}),
          configured: !!registration,
          available: !!registration,
          consentMode: "standard",
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function mcpOAuthRevoke(ctx: ApiCtx, server: McpServer, principalId: string): Promise<void> {
  const { res, deps } = ctx;
  const provider = mcpProviderName(server.id);
  const oauth = deps.mcpOAuth;
  if (!oauth) return sendJson(res, 501, { error: "oauth_not_configured", message: "MCP sign-in is not configured" });
  const removed = await oauth.tokens.delete(server.id, principalId);
  const registration = removed ? await oauth.clients.get(server.id) : null;
  if (removed && registration) {
    const revocations: Array<[string, "access_token" | "refresh_token"]> = [
      ...(removed.refreshToken ? [[removed.refreshToken, "refresh_token"] as [string, "refresh_token"]] : []),
      [removed.accessToken, "access_token"],
    ];
    for (const [token, hint] of revocations) {
      await revokeToken(registration, token, hint, oauth.net).catch((e: unknown) =>
        swallow(`mcp token revoke ${server.id}`, e),
      );
    }
  }
  audit(deps, { principalId, action: "mcp.oauth.revoked", resource: provider, scopeLabel: principalId });
  return sendJson(res, 200, { ok: true, principalId, provider, hosts: [hostOf(server.url)] });
}

export async function purgeMcpOAuth(deps: ServerDeps, serverId: string): Promise<void> {
  if (!deps.mcpOAuth) return;
  await deps.mcpOAuth.tokens.deleteAllForServer(serverId);
  await deps.mcpOAuth.catalogs.delete(serverId);
  await deps.mcpOAuth.clients.delete(serverId);
}

export type McpRegistrationResult =
  | { ok: true; registration: McpOAuthRegistration; registered: boolean }
  | { ok: false; status: number; message: string };

export async function registerMcpOAuthClient(
  deps: ServerDeps,
  input: {
    server: McpServer;
    reregister: boolean;
    manualClientId?: string;
    manualClientSecret?: string;
    actorId: string;
  },
): Promise<McpRegistrationResult> {
  const oauth = deps.mcpOAuth;
  if (!oauth) return { ok: false, status: 501, message: "MCP sign-in needs CONNECTOR_SECRET_KEY to be set" };
  if (!deps.publicUrl) return { ok: false, status: 400, message: "MCP sign-in needs PUBLIC_WEB_URL to be set" };
  const { server } = input;
  const redirectUri = mcpRedirectUri(deps.publicUrl, server.id);
  const existing = await oauth.clients.get(server.id);
  const now = Date.now();
  const stale =
    !existing ||
    input.reregister ||
    existing.serverUrl !== server.url ||
    existing.redirectUri !== redirectUri ||
    (existing.clientSecretExpiresAt !== undefined && existing.clientSecretExpiresAt <= now) ||
    (input.manualClientId !== undefined && input.manualClientId !== existing.clientId);
  if (!stale) return { ok: true, registration: existing, registered: false };
  try {
    const discovery = await discover(server.url, oauth.net);
    const { authServer } = discovery;
    let client;
    if (input.manualClientId) client = manualRegistration(authServer, input.manualClientId, input.manualClientSecret);
    else if (authServer.registrationEndpoint)
      client = await registerClient(authServer, redirectUri, `QM (${hostOf(deps.publicUrl)})`, oauth.net);
    else {
      return {
        ok: false,
        status: 400,
        message: `${hostOf(authServer.issuer)} does not support dynamic client registration; register ${redirectUri} there and supply oauthClientId (and oauthClientSecret)`,
      };
    }
    return {
      ok: true,
      registered: true,
      registration: {
        serverId: server.id,
        serverUrl: server.url,
        resource: discovery.resource,
        issuer: authServer.issuer,
        authorizationEndpoint: authServer.authorizationEndpoint,
        tokenEndpoint: authServer.tokenEndpoint,
        ...(authServer.registrationEndpoint ? { registrationEndpoint: authServer.registrationEndpoint } : {}),
        ...(authServer.revocationEndpoint ? { revocationEndpoint: authServer.revocationEndpoint } : {}),
        ...(discovery.scopes ? { scopes: discovery.scopes } : {}),
        issParameterSupported: authServer.issParameterSupported,
        ...client,
        redirectUri,
        source: input.manualClientId ? "manual" : "dcr",
        registeredAt: now,
        registeredBy: input.actorId,
      },
    };
  } catch (e) {
    return { ok: false, status: 400, message: `sign-in setup for ${hostOf(server.url)} failed: ${errMessage(e)}` };
  }
}

export function mcpOAuthView(registration: McpOAuthRegistration) {
  return {
    issuer: registration.issuer,
    clientId: registration.clientId,
    redirectUri: registration.redirectUri,
    ...(registration.scopes ? { scopes: registration.scopes } : {}),
    registeredAt: registration.registeredAt,
    source: registration.source,
  };
}
