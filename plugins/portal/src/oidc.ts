import type { EmailAdmission } from "../../chassis/src/external-members.ts";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from "jose";

type FetchLike = typeof fetch;

export interface OidcConfig {
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  issuer: string;
  jwksUri: string;
  expectedTeamId?: string;
  prompt?: string;
  hostedDomain?: string;
}

const GOOGLE_ISSUER = "https://accounts.google.com";

export function hostedDomainHint(issuer: string, allowedEmailDomain: string | undefined): string | undefined {
  return issuer === GOOGLE_ISSUER && allowedEmailDomain ? allowedEmailDomain : undefined;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(cfg: OidcConfig, args: { state: string; nonce: string; challenge: string }): string {
  const u = new URL(cfg.authEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", args.state);
  u.searchParams.set("nonce", args.nonce);
  u.searchParams.set("code_challenge", args.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (cfg.prompt) u.searchParams.set("prompt", cfg.prompt);
  if (cfg.hostedDomain) u.searchParams.set("hd", cfg.hostedDomain);
  return u.toString();
}

export interface TokenResponse {
  accessToken: string;
  idToken: string | null;
}

export async function exchangeCode(
  cfg: OidcConfig,
  args: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: cfg.redirectUri,
    code_verifier: args.codeVerifier,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await fetchImpl(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
      accept: "application/json",
    },
    body: body.toString(),
  });
  const json = await readJson(r, "token endpoint");
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status}`);
  if (json.ok === false) throw new Error(`token exchange failed: ${String(json.error ?? "ok:false")}`);
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("token response missing access_token");
  return { accessToken, idToken: typeof json.id_token === "string" ? json.id_token : null };
}

export async function fetchUserinfo(
  cfg: OidcConfig,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  const r = await fetchImpl(cfg.userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  const json = await readJson(r, "userinfo");
  if (!r.ok) throw new Error(`userinfo failed: HTTP ${r.status}`);
  if (json.ok === false) throw new Error(`userinfo failed: ${String(json.error ?? "ok:false")}`);
  return json;
}

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(jwksUri: string, fetchImpl: FetchLike): ReturnType<typeof createRemoteJWKSet> {
  if (fetchImpl !== fetch) return createRemoteJWKSet(new URL(jwksUri), { [customFetch]: fetchImpl });
  const cached = remoteKeySets.get(jwksUri);
  if (cached) return cached;
  const created = createRemoteJWKSet(new URL(jwksUri));
  remoteKeySets.set(jwksUri, created);
  return created;
}

export async function verifyIdToken(
  cfg: OidcConfig,
  idToken: string | null,
  nonce: string,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  if (!idToken) throw new Error("token response missing id_token");
  const { payload } = await jwtVerify(idToken, keySetFor(cfg.jwksUri, fetchImpl), {
    issuer: cfg.issuer,
    audience: cfg.clientId,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
  });
  if (payload.nonce !== nonce) throw new Error("nonce mismatch");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    (audiences.length > 1 && typeof payload.azp !== "string") ||
    (payload.azp !== undefined && payload.azp !== cfg.clientId)
  ) {
    throw new Error("authorized party mismatch");
  }
  return payload as JWTPayload & Record<string, unknown>;
}

export interface IalabsConfig {
  baseUrl: string;
  issuer: string;
  audience: string;
  clientId: string;
  redirectUri: string;
  timeoutMs?: number;
}

interface IalabsTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAtMs: number;
}

interface IalabsIdentity {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  claims: Record<string, unknown>;
}

export class IalabsRejectedError extends Error {}

export class IalabsUnavailableError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export class IalabsInvalidTokenError extends Error {}

export const IALABS_TIMEOUT_MS = 25_000;
const IALABS_RETRY_AFTER_MS = 60_000;
const UNSENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const INVALID_TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWSSignatureVerificationFailed,
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
];

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (header?.trim() && Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 1000), 900_000);
  const date = header ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 1000), 900_000) : IALABS_RETRY_AFTER_MS;
}

export function buildIalabsAuthorizeUrl(cfg: IalabsConfig, args: { state: string; challenge: string }): string {
  const u = new URL(`${cfg.baseUrl}/api/auth/authorize`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("code_challenge", args.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", args.state);
  return u.toString();
}

async function postIalabs(
  cfg: IalabsConfig,
  path: string,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<Response> {
  let r: Response;
  try {
    r = await fetchImpl(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? IALABS_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    if (typeof code === "string" && UNSENT_CODES.has(code))
      throw new IalabsUnavailableError(`ialabs auth unreachable: ${code}`, IALABS_RETRY_AFTER_MS);
    throw error;
  }
  if (r.status === 401 || r.status === 403) {
    const json = await readJson(r, "ialabs auth").catch(() => ({}) as Record<string, unknown>);
    throw new IalabsRejectedError(`ialabs auth refused: ${String(json.code ?? `HTTP ${r.status}`)}`);
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => undefined);
    throw new IalabsUnavailableError(
      `ialabs auth unavailable: HTTP ${r.status}`,
      retryAfterMs(r.headers.get("retry-after")),
    );
  }
  return r;
}

async function ialabsTokens(r: Response): Promise<IalabsTokens> {
  const json = await readJson(r, "ialabs token endpoint");
  const refreshExpiresAtMs = Date.parse(String(json.refresh_token_expires_at));
  if (
    typeof json.access_token !== "string" ||
    !json.access_token ||
    typeof json.refresh_token !== "string" ||
    !json.refresh_token ||
    !Number.isFinite(refreshExpiresAtMs)
  )
    throw new Error("ialabs token response is incomplete");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, refreshExpiresAtMs };
}

export async function exchangeIalabsCode(
  cfg: IalabsConfig,
  args: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<IalabsTokens> {
  const body = { code: args.code, code_verifier: args.codeVerifier, redirect_uri: cfg.redirectUri };
  return ialabsTokens(await postIalabs(cfg, "/api/tokens", body, fetchImpl));
}

export async function refreshIalabsTokens(
  cfg: IalabsConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<IalabsTokens> {
  return ialabsTokens(await postIalabs(cfg, "/api/tokens/refresh", { refresh_token: refreshToken }, fetchImpl));
}

export async function revokeIalabsToken(
  cfg: IalabsConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await postIalabs(cfg, "/api/tokens/revoke", { refresh_token: refreshToken }, fetchImpl);
}

export async function verifyIalabsAccessToken(
  cfg: IalabsConfig,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<IalabsIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(accessToken, keySetFor(`${cfg.baseUrl}/.well-known/jwks.json`, fetchImpl), {
      issuer: cfg.issuer,
      audience: cfg.audience,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp"],
      clockTolerance: 5,
    }));
  } catch (error) {
    if (INVALID_TOKEN_ERRORS.some((kind) => error instanceof kind))
      throw new IalabsInvalidTokenError((error as Error).message);
    throw error;
  }
  if (payload.pty !== "user") throw new IalabsInvalidTokenError("the token was not issued to a person");
  if (payload.client_id !== cfg.clientId) throw new IalabsInvalidTokenError("the token was issued to another app");
  if (typeof payload.email !== "string" || !payload.email.includes("@"))
    throw new IalabsInvalidTokenError("identity provider returned no email");
  return {
    sub: payload.sub!,
    email: payload.email.trim().toLowerCase(),
    name: typeof payload.name === "string" ? payload.name.trim().slice(0, 200) : "",
    roles: Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === "string") : [],
    claims: payload as JWTPayload & Record<string, unknown>,
  };
}

export interface PrincipalRule {
  claim: "sub" | "email";
  allowedEmailDomain?: string;
  allowedEmails?: readonly string[];
  requireCoreAdmission?: boolean;
}

type PrincipalArgs = { sub: string; claims: Record<string, unknown>; userinfo: Record<string, unknown> };

function envRefusal(rule: PrincipalRule, email: string, args: PrincipalArgs): string | null {
  if (
    rule.allowedEmails?.length &&
    !rule.allowedEmails.map((allowed) => allowed.trim().toLowerCase()).includes(email)
  ) {
    return "account is not on the permitted email list";
  }
  if (rule.allowedEmailDomain) {
    const domain = rule.allowedEmailDomain.toLowerCase();
    if (!email.endsWith(`@${domain}`)) return "account is outside the permitted domain";
    const hd = args.userinfo.hd ?? args.claims.hd;
    if (typeof hd === "string" && hd.toLowerCase() !== domain) return "account is outside the permitted domain";
  }
  return null;
}

export async function resolvePrincipal(
  rule: PrincipalRule,
  args: PrincipalArgs,
  invited: (email: string) => Promise<EmailAdmission> = async () => ({ allowed: false }),
): Promise<{ sub: string; appOnly?: true }> {
  if (rule.claim === "sub" && !rule.requireCoreAdmission) return { sub: args.sub };
  const rawEmail = args.userinfo.email;
  if (typeof rawEmail !== "string" || !rawEmail.includes("@")) throw new Error("identity provider returned no email");
  const verified = args.userinfo.email_verified;
  if (verified !== true && verified !== "true") throw new Error("email is not verified by the identity provider");
  const email = rawEmail.trim().toLowerCase();
  const refusal = envRefusal(rule, email, args);
  if (refusal || rule.requireCoreAdmission) {
    const admission = await invited(email);
    if (!admission.allowed) throw new Error(refusal ?? "account is not permitted");
    return {
      sub: admission.appOnly || rule.claim === "email" ? email : args.sub,
      ...(admission.appOnly ? { appOnly: true } : {}),
    };
  }
  return { sub: email };
}

async function readJson(r: Response, what: string): Promise<Record<string, unknown>> {
  const text = await r.text();
  try {
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${what} returned non-JSON (HTTP ${r.status})`);
  }
}
