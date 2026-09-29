import { bareHostname, publicAddresses, type HostLookup } from "../util/network.ts";
import { MCP_PROTOCOL_VERSION } from "./mcp-client.ts";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ERROR_CHARS = 300;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const AUTH_METHOD_PREFERENCE = ["client_secret_basic", "client_secret_post", "none"] as const;

type McpTokenEndpointAuthMethod = (typeof AUTH_METHOD_PREFERENCE)[number];

export interface McpOAuthNet {
  fetchImpl?: typeof fetch;
  lookup?: HostLookup;
  allowLoopbackHttp?: boolean;
  now?: () => number;
}

export interface McpAuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  tokenEndpointAuthMethods?: string[];
  issParameterSupported: boolean;
}

export interface McpOAuthDiscovery {
  resource: string;
  scopes?: string[];
  authServer: McpAuthServerMetadata;
}

export interface McpClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientSecretExpiresAt?: number;
  tokenEndpointAuthMethod: McpTokenEndpointAuthMethod;
  registrationAccessToken?: string;
  registrationClientUri?: string;
}

export interface McpOAuthRegistration extends McpClientRegistration {
  serverId: string;
  serverUrl: string;
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopes?: string[];
  issParameterSupported: boolean;
  redirectUri: string;
  source: "dcr" | "manual";
  registeredAt: number;
  registeredBy: string;
}

export interface McpTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export class McpOAuthError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 3)}...` : message);
    this.name = "McpOAuthError";
    this.status = opts.status;
    this.code = opts.code;
  }
}

const PERMANENT_OAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

export function isPermanentOAuthFailure(e: unknown): boolean {
  return e instanceof McpOAuthError && e.code !== undefined && PERMANENT_OAUTH_ERRORS.has(e.code);
}

interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
}

function isLoopbackAllowed(url: URL, net: McpOAuthNet): boolean {
  return net.allowLoopbackHttp === true && LOOPBACK_HOSTS.has(bareHostname(url));
}

function assertSafeUrl(raw: string, net: McpOAuthNet, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpOAuthError(`${label} is not a valid URL`);
  }
  if (url.username || url.password) throw new McpOAuthError(`${label} must not carry credentials`);
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackAllowed(url, net))) return url;
  throw new McpOAuthError(`${label} must use https`);
}

async function assertPublicHost(url: URL, net: McpOAuthNet): Promise<void> {
  if (isLoopbackAllowed(url, net)) return;
  const addresses = await publicAddresses(bareHostname(url), net.lookup);
  if (addresses === "unresolvable") throw new McpOAuthError(`${url.host} could not be resolved`);
  if (addresses === "private") throw new McpOAuthError(`${url.host} must resolve to a public network address`);
}

async function readCapped(res: Response, truncateAt: number | undefined): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const limit = truncateAt ?? MAX_BODY_BYTES;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      if (truncateAt === undefined) throw new McpOAuthError("response body is too large");
      chunks.push(value.subarray(0, value.byteLength - (size - limit)));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function safeFetch(
  raw: string,
  init: { method: string; headers: Record<string, string>; body?: string; truncateAt?: number },
  net: McpOAuthNet,
  label: string,
): Promise<SafeResponse> {
  const { truncateAt, ...request } = init;
  const url = assertSafeUrl(raw, net, label);
  await assertPublicHost(url, net);
  let res: Response;
  try {
    res = await (net.fetchImpl ?? fetch)(url.toString(), {
      ...request,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new McpOAuthError(`${label} request to ${url.host} failed`);
  }
  if (res.status >= 300 && res.status < 400) throw new McpOAuthError(`${label} redirected, which is not allowed`);
  return { status: res.status, ok: res.ok, headers: res.headers, body: await readCapped(res, truncateAt) };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function getJson(url: string, net: McpOAuthNet, label: string): Promise<Record<string, unknown> | null> {
  const res = await safeFetch(url, { method: "GET", headers: { accept: "application/json" } }, net, label);
  if (!res.ok) return null;
  return parseJsonObject(res.body);
}

const stringOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const stringsOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s) : undefined;
const trimSlash = (s: string): string => s.replace(/\/+$/, "");

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function resourceCovers(resource: URL, server: URL): boolean {
  const scope = pathSegments(resource);
  const target = pathSegments(server);
  return resource.origin === server.origin && scope.length <= target.length && scope.every((s, i) => s === target[i]);
}

export function parseBearerChallenge(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header || !/^\s*bearer\b/i.test(header)) return {};
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return {
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
  };
}

async function probeChallenge(
  serverUrl: string,
  net: McpOAuthNet,
): Promise<{ resourceMetadata?: string; scope?: string }> {
  const res = await safeFetch(
    serverUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "qm", version: "1" } },
      }),
    },
    net,
    "MCP server",
  );
  return res.status === 401 ? parseBearerChallenge(res.headers.get("www-authenticate")) : {};
}

function wellKnownCandidates(base: URL, name: string): string[] {
  const path = trimSlash(base.pathname);
  return path
    ? [`${base.origin}/.well-known/${name}${path}`, `${base.origin}/.well-known/${name}`]
    : [`${base.origin}/.well-known/${name}`];
}

async function firstJson(urls: string[], net: McpOAuthNet, label: string): Promise<Record<string, unknown> | null> {
  for (const url of urls) {
    const json = await getJson(url, net, label);
    if (json) return json;
  }
  return null;
}

async function authServerMetadata(issuerUrl: string, net: McpOAuthNet): Promise<McpAuthServerMetadata> {
  const issuer = assertSafeUrl(issuerUrl, net, "authorization server");
  const path = trimSlash(issuer.pathname);
  const candidates = path
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  const meta = await firstJson(candidates, net, "authorization server metadata");
  if (!meta) throw new McpOAuthError(`${issuer.host} does not publish authorization server metadata`);
  const advertised = stringOf(meta.issuer);
  if (advertised !== issuerUrl) {
    throw new McpOAuthError("authorization server metadata issuer does not match the authorization server URL");
  }
  if (!stringsOf(meta.code_challenge_methods_supported)?.includes("S256")) {
    throw new McpOAuthError("authorization server does not support PKCE S256");
  }
  const endpoint = (key: string, required: boolean): string | undefined => {
    const value = stringOf(meta[key]);
    if (!value) {
      if (required) throw new McpOAuthError(`authorization server metadata is missing ${key}`);
      return undefined;
    }
    return assertSafeUrl(value, net, key).toString();
  };
  const registrationEndpoint = endpoint("registration_endpoint", false);
  const revocationEndpoint = endpoint("revocation_endpoint", false);
  const scopesSupported = stringsOf(meta.scopes_supported);
  const tokenEndpointAuthMethods = stringsOf(meta.token_endpoint_auth_methods_supported);
  return {
    issuer: advertised,
    authorizationEndpoint: endpoint("authorization_endpoint", true)!,
    tokenEndpoint: endpoint("token_endpoint", true)!,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    ...(scopesSupported ? { scopesSupported } : {}),
    ...(tokenEndpointAuthMethods ? { tokenEndpointAuthMethods } : {}),
    issParameterSupported: meta.authorization_response_iss_parameter_supported === true,
  };
}

function chooseScopes(
  challengeScope: string | undefined,
  resourceScopes: string[] | undefined,
  authServer: McpAuthServerMetadata,
): string[] | undefined {
  const base = challengeScope ? challengeScope.split(/\s+/).filter(Boolean) : resourceScopes;
  if (!base?.length) return undefined;
  const wantsOffline = authServer.scopesSupported?.includes("offline_access") && !base.includes("offline_access");
  return wantsOffline ? [...base, "offline_access"] : base;
}

export async function discover(serverUrl: string, net: McpOAuthNet): Promise<McpOAuthDiscovery> {
  const server = assertSafeUrl(serverUrl, net, "MCP server URL");
  const challenge = await probeChallenge(serverUrl, net);
  const prm = await firstJson(
    challenge.resourceMetadata ? [challenge.resourceMetadata] : wellKnownCandidates(server, "oauth-protected-resource"),
    net,
    "protected resource metadata",
  );
  if (!prm) throw new McpOAuthError(`${server.host} does not advertise OAuth protected resource metadata`);
  const resource = stringOf(prm.resource);
  if (!resource) throw new McpOAuthError("protected resource metadata is missing resource");
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(resource);
  } catch {
    throw new McpOAuthError("protected resource metadata resource is not a valid URL");
  }
  if (!resourceCovers(resourceUrl, server)) {
    throw new McpOAuthError("protected resource metadata resource does not match the MCP server URL");
  }
  const issuer = stringsOf(prm.authorization_servers)?.[0];
  if (!issuer) throw new McpOAuthError("protected resource metadata lists no authorization server");
  const authServer = await authServerMetadata(issuer, net);
  const scopes = chooseScopes(challenge.scope, stringsOf(prm.scopes_supported), authServer);
  return { resource, ...(scopes ? { scopes } : {}), authServer };
}

function chooseAuthMethod(supported: string[] | undefined): McpTokenEndpointAuthMethod {
  if (!supported?.length) return "client_secret_basic";
  const match = AUTH_METHOD_PREFERENCE.find((m) => supported.includes(m));
  if (!match) throw new McpOAuthError("authorization server supports no usable token endpoint auth method");
  return match;
}

function asAuthMethod(value: unknown): McpTokenEndpointAuthMethod | undefined {
  return AUTH_METHOD_PREFERENCE.find((m) => m === value);
}

function oauthErrorFrom(json: Record<string, unknown> | null, status: number, label: string): McpOAuthError {
  const code = stringOf(json?.error);
  const description = stringOf(json?.error_description);
  const detail = code ? `${code}${description ? `: ${description}` : ""}` : `HTTP ${status}`;
  return new McpOAuthError(`${label} failed (${detail.replace(/\s+/g, " ")})`, {
    status,
    ...(code ? { code } : {}),
  });
}

export async function registerClient(
  authServer: McpAuthServerMetadata,
  redirectUri: string,
  clientName: string,
  net: McpOAuthNet,
): Promise<McpClientRegistration> {
  if (!authServer.registrationEndpoint) {
    throw new McpOAuthError("authorization server does not support dynamic client registration");
  }
  const requested = chooseAuthMethod(authServer.tokenEndpointAuthMethods);
  const res = await safeFetch(
    authServer.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: requested,
      }),
    },
    net,
    "client registration",
  );
  const json = parseJsonObject(res.body);
  if (!res.ok || !json) throw oauthErrorFrom(json, res.status, "client registration");
  const clientId = stringOf(json.client_id);
  if (!clientId) throw new McpOAuthError("client registration returned no client_id");
  const tokenEndpointAuthMethod =
    json.token_endpoint_auth_method === undefined ? requested : asAuthMethod(json.token_endpoint_auth_method);
  if (!tokenEndpointAuthMethod) throw new McpOAuthError("client registration returned an unsupported auth method");
  const clientSecret = stringOf(json.client_secret);
  if (tokenEndpointAuthMethod !== "none" && !clientSecret) {
    throw new McpOAuthError("client registration returned no client_secret for a confidential client");
  }
  const expiresAt = typeof json.client_secret_expires_at === "number" ? json.client_secret_expires_at : 0;
  const registrationAccessToken = stringOf(json.registration_access_token);
  const registrationClientUri = stringOf(json.registration_client_uri);
  return {
    clientId,
    tokenEndpointAuthMethod,
    ...(clientSecret ? { clientSecret } : {}),
    ...(expiresAt > 0 ? { clientSecretExpiresAt: expiresAt * 1000 } : {}),
    ...(registrationAccessToken ? { registrationAccessToken } : {}),
    ...(registrationClientUri ? { registrationClientUri } : {}),
  };
}

export function manualRegistration(
  authServer: McpAuthServerMetadata,
  clientId: string,
  clientSecret?: string,
): McpClientRegistration {
  if (!clientSecret) return { clientId, tokenEndpointAuthMethod: "none" };
  const supported = authServer.tokenEndpointAuthMethods?.filter((m) => m !== "none");
  return { clientId, clientSecret, tokenEndpointAuthMethod: chooseAuthMethod(supported) };
}

export function authorizeUrl(
  client: McpOAuthRegistration,
  params: { state: string; codeChallenge: string; scopes?: string[]; switchAccount?: boolean },
): string {
  const url = new URL(client.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  const scopes = params.scopes ?? client.scopes;
  if (scopes?.length) url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("resource", client.resource);
  if (params.switchAccount) url.searchParams.set("prompt", "login");
  return url.toString();
}

function clientAuth(client: McpOAuthRegistration, body: URLSearchParams, headers: Record<string, string>): void {
  if (client.tokenEndpointAuthMethod === "client_secret_basic") {
    const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret ?? "")}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    return;
  }
  body.set("client_id", client.clientId);
  if (client.tokenEndpointAuthMethod === "client_secret_post") body.set("client_secret", client.clientSecret ?? "");
}

async function tokenRequest(
  client: McpOAuthRegistration,
  params: Record<string, string>,
  net: McpOAuthNet,
): Promise<McpTokenSet> {
  const body = new URLSearchParams(params);
  body.set("resource", client.resource);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  clientAuth(client, body, headers);
  const res = await safeFetch(
    client.tokenEndpoint,
    { method: "POST", headers, body: body.toString() },
    net,
    "token endpoint",
  );
  const json = parseJsonObject(res.body);
  if (!res.ok || !json || json.error !== undefined) throw oauthErrorFrom(json, res.status, "token request");
  const accessToken = stringOf(json.access_token);
  if (!accessToken) throw new McpOAuthError("token response has no access_token", { status: res.status });
  if (typeof json.token_type !== "string" || json.token_type.toLowerCase() !== "bearer") {
    throw new McpOAuthError("token response is not a bearer token", { status: res.status });
  }
  const refreshToken = stringOf(json.refresh_token);
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 0;
  const scope = stringOf(json.scope);
  const now = (net.now ?? Date.now)();
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(scope ? { scope } : {}),
  };
}

export function exchangeCode(
  client: McpOAuthRegistration,
  params: { code: string; codeVerifier: string },
  net: McpOAuthNet,
): Promise<McpTokenSet> {
  return tokenRequest(
    client,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: client.redirectUri,
      code_verifier: params.codeVerifier,
    },
    net,
  );
}

export function refreshAccessToken(
  client: McpOAuthRegistration,
  refreshToken: string,
  net: McpOAuthNet,
): Promise<McpTokenSet> {
  return tokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken }, net);
}

export async function revokeToken(
  client: McpOAuthRegistration,
  token: string,
  hint: "access_token" | "refresh_token",
  net: McpOAuthNet,
): Promise<void> {
  if (!client.revocationEndpoint) return;
  const body = new URLSearchParams({ token, token_type_hint: hint });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  clientAuth(client, body, headers);
  await safeFetch(
    client.revocationEndpoint,
    { method: "POST", headers, body: body.toString() },
    net,
    "token revocation",
  );
}
