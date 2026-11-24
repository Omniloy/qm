import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { deriveKey, open, readCookie, seal } from "../src/session.ts";
import { createIalabsSessions } from "../src/ialabs-session.ts";

const secret = "ialabs-login-portal-session-secret";
const origin = "http://portal.test";
const issuer = "https://auth.ialabs.test";
const sessionKey = deriveKey(secret, "portal.session.v1");
const tmpKey = deriveKey(secret, "portal.tmp.v1");
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "ialabs-key", alg: "RS256", use: "sig" };
const sessionCapMs = Date.now() + 7 * 86400_000;

interface Record_ {
  principal: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshAfterMs: number;
  checkedAtMs: number;
  retryAtMs?: number;
  lease?: string;
  leaseUntilMs?: number;
}

const records = new Map<string, Record_>();
let claims: Record<string, unknown> = {};
let accessTtl: string | number = "15m";
let refreshStatus = 200;
let refreshDelayMs = 0;
let settleFailures = 0;
let retryAfter = "";
let tokenKid = "ialabs-key";
let exchangeStatus = 200;
const refreshesSent: string[] = [];
const revoked: string[] = [];
const exchanges: unknown[] = [];

async function accessToken(): Promise<string> {
  return new SignJWT({
    pty: "user",
    client_id: "qm",
    email: "Ana.Garcia@laberit.com",
    name: "Ana García",
    roles: ["member"],
    oid: "entra-oid",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: tokenKid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience((claims.aud as string[] | undefined) ?? ["qm"])
    .setSubject("user:7")
    .setIssuedAt()
    .setExpirationTime(accessTtl)
    .sign(privateKey);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function claim(body: Record<string, unknown>) {
  const record = records.get(String(body.sessionId));
  const now = Date.now();
  if (!record || record.expiresAtMs <= now) return { state: "missing" };
  const view = { principal: record.principal, expiresAtMs: record.expiresAtMs };
  if (record.checkedAtMs > now - record.refreshAfterMs || (record.retryAtMs ?? 0) > now)
    return { state: "current", ...view };
  if (record.leaseUntilMs !== undefined && record.leaseUntilMs > now) return { state: "busy", ...view };
  record.lease = randomBytes(8).toString("hex");
  record.leaseUntilMs = now + Number(body.leaseMs);
  return { state: "claimed", ...view, lease: record.lease, refreshToken: record.refreshToken };
}

function settle(body: Record<string, unknown>) {
  const record = records.get(String(body.sessionId));
  if (!record || record.lease !== body.lease) return { settled: false };
  delete record.lease;
  delete record.leaseUntilMs;
  if (body.outcome === "revoked") records.delete(String(body.sessionId));
  if (body.outcome === "unavailable") record.retryAtMs = Date.now() + Number(body.retryAfterMs);
  if (body.outcome === "rotated") {
    delete record.retryAtMs;
    record.refreshToken = String(body.refreshToken);
    record.expiresAtMs = Number(body.expiresAtMs);
    record.checkedAtMs = Date.now();
  }
  return { settled: true };
}

const upstream = createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url!, origin).pathname;
    res.setHeader("content-type", "application/json");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (path === "/auth/.well-known/jwks.json") return send(200, { keys: [jwk] });
    if (path === "/auth/api/tokens") {
      exchanges.push(await readBody(req));
      if (exchangeStatus !== 200) return send(exchangeStatus, { code: "invalid_grant", detail: "unknown code" });
      return send(200, {
        access_token: await accessToken(),
        token_type: "Bearer",
        expires_in: 900,
        access_token_expires_at: new Date(Date.now() + 900_000).toISOString(),
        refresh_token: `rt-${randomBytes(6).toString("hex")}`,
        refresh_token_expires_at: new Date(sessionCapMs).toISOString(),
      });
    }
    if (path === "/auth/api/tokens/refresh") {
      const body = await readBody(req);
      refreshesSent.push(String(body.refresh_token));
      if (refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
      if (refreshStatus !== 200) {
        if (retryAfter) res.setHeader("retry-after", retryAfter);
        return send(refreshStatus, { code: "invalid_refresh_token", detail: "the session has ended" });
      }
      return send(200, {
        access_token: await accessToken(),
        token_type: "Bearer",
        expires_in: 900,
        access_token_expires_at: new Date(Date.now() + 900_000).toISOString(),
        refresh_token: `rt-${randomBytes(6).toString("hex")}`,
        refresh_token_expires_at: new Date(sessionCapMs).toISOString(),
      });
    }
    if (path === "/auth/api/tokens/revoke") {
      revoked.push(String((await readBody(req)).refresh_token));
      return send(204, undefined);
    }
    if (path === "/v1/auth/broker/email-allowed") return send(200, { allowed: false });
    const canonical = /^\/v1\/principals\/([^/]+)\/canonical$/.exec(path);
    if (canonical) return send(200, { canonicalId: decodeURIComponent(canonical[1]!) });
    if (path.startsWith("/v1/auth/portal-sessions")) {
      const body = await readBody(req);
      const action = path.slice("/v1/auth/portal-sessions".length);
      if (action === "") {
        records.set(String(body.sessionId), {
          principal: String(body.principal),
          refreshToken: String(body.refreshToken),
          expiresAtMs: Number(body.expiresAtMs),
          refreshAfterMs: Number(body.refreshAfterMs),
          checkedAtMs: Date.now(),
        });
        return send(200, { ok: true });
      }
      if (action === "/claim") return send(200, claim(body));
      if (action === "/settle") {
        if (body.outcome === "rotated" && settleFailures > 0) {
          settleFailures--;
          return send(503, { error: "unavailable" });
        }
        return send(200, settle(body));
      }
      const record = records.get(String(body.sessionId));
      records.delete(String(body.sessionId));
      return send(200, { refreshToken: record?.refreshToken ?? null });
    }
    if (path.startsWith("/v1/")) return send(404, { error: "not_found" });
    res.setHeader("content-type", "text/plain");
    res.end("surface");
  })().catch(() => {
    res.statusCode = 500;
    res.end();
  });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
Object.assign(process.env, {
  NODE_ENV: "test",
  PORTAL_PUBLIC_URL: origin,
  PORTAL_SESSION_SECRET: secret,
  CORE_ORG_ID: "acme",
  CORE_SIGNING_SECRET: "ialabs-login-core-secret",
  CORE_API_URL: upstreamUrl,
  WEB_UI_UPSTREAM: upstreamUrl,
  ADMIN_UPSTREAM: upstreamUrl,
  AUTH_BROKER_UPSTREAM: "",
  PORTAL_IDP: "ialabs",
  IALABS_AUTH_URL: `${upstreamUrl}/auth`,
  IALABS_AUTH_ISSUER: issuer,
  OIDC_CLIENT_ID: "qm",
  OIDC_CLIENT_SECRET: "",
  OIDC_ALLOWED_EMAILS: "",
  OIDC_ALLOWED_EMAIL_DOMAIN: "laberit.com",
  OIDC_PRINCIPAL_CLAIM: "email",
  PORTAL_EXPECTED_TEAM_ID: "",
  PORTAL_LOCAL_AUTH_BYPASS: "0",
  PORTAL_PLAYGROUND: "0",
});
const { server, bootChecks } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  upstream.close();
});

function cookieValue(response: Response, name: string): string | null {
  const header = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header === undefined ? null : decodeURIComponent(header.split(";")[0]!.slice(name.length + 1));
}

async function signIn(): Promise<Response> {
  const login = await fetch(`${base}/auth/login?returnTo=%2Fchat`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const tmpCookie = `portal_oidc_tmp=${encodeURIComponent(cookieValue(login, "portal_oidc_tmp")!)}`;
  const tmp = open(readCookie(tmpCookie, "portal_oidc_tmp"), tmpKey)!;
  return fetch(`${base}/auth/callback?code=the-code&state=${tmp.state as string}`, {
    headers: { cookie: tmpCookie },
    redirect: "manual",
  });
}

function seeded(record: Partial<Record_> = {}, authAgeS = 6 * 86400): { sid: string; cookie: string } {
  const sid = randomBytes(32).toString("base64url");
  records.set(sid, {
    principal: "ana.garcia@laberit.com",
    refreshToken: `rt-${sid.slice(0, 8)}`,
    expiresAtMs: sessionCapMs,
    refreshAfterMs: 900_000,
    checkedAtMs: Date.now() - 3600_000,
    ...record,
  });
  const now = Math.floor(Date.now() / 1000);
  const value = seal(
    {
      k: "session",
      sub: "ana.garcia@laberit.com",
      org: "acme",
      auth: now - authAgeS,
      iat: now,
      exp: now + 3600,
      sid,
    },
    sessionKey,
  );
  return { sid, cookie: `portal_session=${encodeURIComponent(value)}` };
}

const page = (cookie: string) =>
  fetch(`${base}/chat`, { headers: { cookie, accept: "text/html" }, redirect: "manual" });
const api = (cookie: string) => fetch(`${base}/api/sessions`, { headers: { cookie }, redirect: "manual" });

test("boot checks accept ialabs mode without a client secret or OIDC endpoints", () => {
  assert.doesNotThrow(() => bootChecks());
});

test("sign-in goes to the MS-AUTH authorize endpoint with PKCE and no OIDC parameters", async () => {
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const location = new URL(login.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, `${upstreamUrl}/auth/api/auth/authorize`);
  assert.equal(location.searchParams.get("client_id"), "qm");
  assert.equal(location.searchParams.get("redirect_uri"), `${origin}/auth/callback`);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("code_challenge"));
  assert.ok(location.searchParams.get("state"));
  for (const absent of ["scope", "nonce", "response_type", "prompt"])
    assert.equal(location.searchParams.get(absent), null);
});

test("a verified MS-AUTH token signs in its email and stores the refresh token in core", async () => {
  claims = {};
  const before = records.size;
  const response = await signIn();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/chat");
  const session = open(cookieValue(response, "portal_session"), sessionKey)!;
  assert.equal(session.sub, "ana.garcia@laberit.com");
  assert.equal(session.name, "Ana García");
  assert.equal(typeof session.sid, "string");
  assert.equal(records.size, before + 1);
  const record = records.get(session.sid as string)!;
  assert.equal(record.principal, "ana.garcia@laberit.com");
  assert.equal(record.expiresAtMs, sessionCapMs);
  assert.deepEqual(Object.keys(exchanges.at(-1) as object).sort(), ["code", "code_verifier", "redirect_uri"]);
});

for (const [label, override, ttl] of [
  ["wrong audience", { aud: ["people-api"] }, "15m"],
  ["wrong client_id", { client_id: "people" }, "15m"],
  ["an application token", { pty: "application" }, "15m"],
  ["an expired token", {}, Math.floor(Date.now() / 1000) - 60],
  ["an email outside the domain", { email: "someone@elsewhere.com" }, "15m"],
] as const) {
  test(`sign-in refuses ${label} and revokes the MS-AUTH session`, async () => {
    claims = override;
    accessTtl = ttl;
    const revokedBefore = revoked.length;
    const response = await signIn();
    claims = {};
    accessTtl = "15m";
    assert.equal(response.status, 400);
    assert.equal(cookieValue(response, "portal_session"), null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(revoked.length, revokedBefore + 1);
  });
}

test("an access_denied callback shows the sign-in error page", async () => {
  const response = await fetch(`${base}/auth/callback?error=access_denied&error_description=no%20access&state=x`, {
    redirect: "manual",
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /access_denied/);
});

test("a stale session refreshes once with MS-AUTH and stores the rotated token", async () => {
  const { sid, cookie } = seeded();
  const old = records.get(sid)!.refreshToken;
  const response = await page(cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(
    refreshesSent.filter((token) => token === old),
    [old],
  );
  assert.notEqual(records.get(sid)!.refreshToken, old);
  assert.ok(records.get(sid)!.checkedAtMs > Date.now() - 5_000);
  assert.equal((await page(cookie)).status, 200);
  assert.equal(refreshesSent.filter((token) => token === old).length, 1);
});

test("a refused refresh ends the session: pages go to sign-in, API calls get 401", async () => {
  refreshStatus = 401;
  try {
    const first = seeded();
    const response = await page(first.cookie);
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location")!, /^\/auth\/login\?returnTo=/);
    assert.equal(cookieValue(response, "portal_session"), "");
    assert.equal(records.has(first.sid), false);
    const second = seeded();
    const apiResponse = await api(second.cookie);
    assert.equal(apiResponse.status, 401);
    assert.deepEqual(await apiResponse.json(), { error: "sign in", loginUrl: "/auth/login" });
    assert.equal((await api(second.cookie)).status, 401);
  } finally {
    refreshStatus = 200;
  }
});

test("an unavailable MS-AUTH keeps the session and backs off before retrying", async () => {
  refreshStatus = 503;
  retryAfter = "120";
  const { sid, cookie } = seeded();
  const old = records.get(sid)!.refreshToken;
  try {
    assert.equal((await api(cookie)).status, 200);
    assert.equal(records.get(sid)!.refreshToken, old);
    assert.equal(records.get(sid)!.lease, undefined);
    const retryAt = records.get(sid)!.retryAtMs!;
    assert.ok(retryAt > Date.now() + 110_000 && retryAt <= Date.now() + 120_000);
    assert.equal((await api(cookie)).status, 200);
    assert.equal(refreshesSent.filter((token) => token === old).length, 1);
  } finally {
    refreshStatus = 200;
    retryAfter = "";
  }
});

test("any refusal other than 401 or 403 keeps the session", async () => {
  refreshStatus = 400;
  const { sid, cookie } = seeded();
  try {
    assert.equal((await api(cookie)).status, 200);
    assert.ok(records.has(sid));
    assert.ok(records.get(sid)!.retryAtMs! > Date.now());
  } finally {
    refreshStatus = 200;
  }
});

test("a refreshed token for another app ends the session and revokes the new MS-AUTH session", async () => {
  const { sid, cookie } = seeded();
  const revokedBefore = revoked.length;
  claims = { client_id: "people" };
  try {
    assert.equal((await api(cookie)).status, 401);
  } finally {
    claims = {};
  }
  assert.equal(records.has(sid), false);
  assert.equal(revoked.length, revokedBefore + 1);
});

test("a session missing from the store is signed out", async () => {
  const { sid, cookie } = seeded();
  records.delete(sid);
  assert.equal((await api(cookie)).status, 401);
});

test("concurrent requests across tabs and instances send the refresh token once", async () => {
  const { sid, cookie } = seeded();
  const old = records.get(sid)!.refreshToken;
  refreshDelayMs = 300;
  try {
    const other = createIalabsSessions({
      core: upstreamUrl,
      signingSecret: "ialabs-login-core-secret",
      ialabs: { baseUrl: `${upstreamUrl}/auth`, issuer, audience: "qm", clientId: "qm", redirectUri: "" },
      refreshAfterMs: 900_000,
      reauthBeforeMs: 86400_000,
      pollMs: 20,
    });
    const results = await Promise.all([
      api(cookie),
      api(cookie),
      page(cookie),
      other.state(sid, "ana.garcia@laberit.com", false, 0),
      other.state(sid, "ana.garcia@laberit.com", false, 0),
    ]);
    assert.deepEqual(
      results.map((result) => (result instanceof Response ? result.status : result)),
      [200, 200, 200, "ok", "ok"],
    );
  } finally {
    refreshDelayMs = 0;
  }
  assert.equal(refreshesSent.filter((token) => token === old).length, 1);
});

function instance(timeoutMs?: number) {
  return createIalabsSessions({
    core: upstreamUrl,
    signingSecret: "ialabs-login-core-secret",
    ialabs: {
      baseUrl: `${upstreamUrl}/auth`,
      issuer,
      audience: "qm",
      clientId: "qm",
      redirectUri: "",
      ...(timeoutMs ? { timeoutMs } : {}),
    },
    refreshAfterMs: 900_000,
    reauthBeforeMs: 86400_000,
    pollMs: 10,
    busyWaitMs: 100,
    settleRetryMs: 10,
  });
}

test("a refresh whose outcome is unknown holds the lease and does not replay the token within it", async () => {
  const { sid } = seeded();
  const old = records.get(sid)!.refreshToken;
  refreshDelayMs = 400;
  try {
    assert.equal(await instance(100).state(sid, "ana.garcia@laberit.com", false, 0), "ok");
    assert.ok(records.get(sid)!.lease, "the lease stays held until it expires");
    assert.equal(records.get(sid)!.refreshToken, old);
    assert.equal(await instance(100).state(sid, "ana.garcia@laberit.com", false, 0), "ok");
    assert.equal(refreshesSent.filter((token) => token === old).length, 1);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 450));
    refreshDelayMs = 0;
  }
});

test("storing the rotated token is retried when core briefly fails", async () => {
  const { sid } = seeded();
  const old = records.get(sid)!.refreshToken;
  settleFailures = 2;
  assert.equal(await instance().state(sid, "ana.garcia@laberit.com", false, 0), "ok");
  assert.equal(settleFailures, 0);
  assert.notEqual(records.get(sid)!.refreshToken, old);
  assert.equal(records.get(sid)!.lease, undefined);
  assert.equal(refreshesSent.filter((token) => token === old).length, 1);
});

test("a fresh session shorter than the reauth window is not sent back to sign-in", async () => {
  const { cookie } = seeded({ expiresAtMs: Date.now() + 3600_000, checkedAtMs: Date.now() }, 0);
  assert.equal((await page(cookie)).status, 200);
});

test("near the MS-AUTH session cap a page load signs in again, an API call does not", async () => {
  const { cookie } = seeded({ expiresAtMs: Date.now() + 3600_000, checkedAtMs: Date.now() });
  const response = await page(cookie);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/auth/login?returnTo=%2Fchat");
  assert.equal((await api(cookie)).status, 200);
});

test("sign-out revokes the MS-AUTH session and deletes the stored token", async () => {
  const { sid, cookie } = seeded({ checkedAtMs: Date.now() });
  const token = records.get(sid)!.refreshToken;
  const response = await fetch(`${base}/auth/logout`, {
    method: "POST",
    headers: { cookie, origin, "sec-fetch-site": "same-origin" },
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  assert.equal(records.has(sid), false);
  assert.ok(revoked.includes(token));
});

test("a 502 from MS-AUTH on refresh is ambiguous and holds the lease", async () => {
  const { sid } = seeded();
  const old = records.get(sid)!.refreshToken;
  refreshStatus = 502;
  try {
    assert.equal(await instance().state(sid, "ana.garcia@laberit.com", false, 0), "ok");
  } finally {
    refreshStatus = 200;
  }
  assert.ok(records.get(sid)!.lease);
  assert.equal(records.get(sid)!.retryAtMs, undefined);
  assert.equal(records.get(sid)!.refreshToken, old);
  assert.equal(await instance().state(sid, "ana.garcia@laberit.com", false, 0), "ok");
  assert.equal(refreshesSent.filter((token) => token === old).length, 1);
});

for (const [label, change] of [
  ["a clock-skewed token", () => (claims = { nbf: Math.floor(Date.now() / 1000) + 300 })],
  ["a token signed with an unknown key", () => (tokenKid = "rotated-key")],
] as const) {
  test(`a refreshed ${label} keeps the session and stores the rotated token`, async () => {
    const { sid, cookie } = seeded();
    const old = records.get(sid)!.refreshToken;
    const revokedBefore = revoked.length;
    change();
    try {
      assert.equal((await api(cookie)).status, 200);
    } finally {
      claims = {};
      tokenKid = "ialabs-key";
    }
    assert.ok(records.has(sid));
    assert.notEqual(records.get(sid)!.refreshToken, old);
    assert.equal(revoked.length, revokedBefore);
  });
}

test("a refused code exchange shows MS-AUTH's error code", async () => {
  exchangeStatus = 400;
  try {
    const response = await signIn();
    assert.equal(response.status, 400);
    assert.match(await response.text(), /invalid_grant/);
  } finally {
    exchangeStatus = 200;
  }
});

test("the session check refreshes a due session and returns to a sanitized address", async () => {
  const { sid, cookie } = seeded();
  const old = records.get(sid)!.refreshToken;
  const check = (returnTo: string, sessionCookie = cookie) =>
    fetch(`${base}/auth/session/check?returnTo=${encodeURIComponent(returnTo)}`, {
      headers: { cookie: sessionCookie, accept: "text/html" },
      redirect: "manual",
    });
  const response = await check("/chat?x=1");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/chat?x=1");
  assert.equal(refreshesSent.filter((token) => token === old).length, 1);
  assert.notEqual(records.get(sid)!.refreshToken, old);
  assert.equal((await check("https://evil.example/steal")).headers.get("location"), "/");
  const gone = seeded();
  records.delete(gone.sid);
  const signedOut = await check("/chat", gone.cookie);
  assert.equal(signedOut.headers.get("location"), "/auth/login?returnTo=%2Fchat");
  assert.equal(cookieValue(signedOut, "portal_session"), "");
  const anonymous = await check("/chat", "");
  assert.equal(anonymous.headers.get("location"), "/auth/login?returnTo=%2Fchat");
});

test("the session check is open to app-only sessions", async () => {
  const sid = randomBytes(32).toString("base64url");
  records.set(sid, {
    principal: "guest@laberit.com",
    refreshToken: "rt-guest",
    expiresAtMs: sessionCapMs,
    refreshAfterMs: 900_000,
    checkedAtMs: Date.now(),
  });
  const now = Math.floor(Date.now() / 1000);
  const value = seal(
    { k: "session", sub: "guest@laberit.com", org: "acme", appOnly: true, auth: now, iat: now, exp: now + 3600, sid },
    sessionKey,
  );
  const response = await fetch(`${base}/auth/session/check?returnTo=%2Fchat`, {
    headers: { cookie: `portal_session=${encodeURIComponent(value)}`, accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/chat");
});
