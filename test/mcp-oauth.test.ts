import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  isPermanentOAuthFailure,
  manualRegistration,
  McpOAuthError,
  parseBearerChallenge,
  refreshAccessToken,
  registerClient,
  type McpOAuthNet,
  type McpOAuthRegistration,
} from "../src/mcp/mcp-oauth.ts";

const SERVER = "https://mcp.granola.ai/mcp";
const PRM_URL = "https://mcp.granola.ai/.well-known/oauth-protected-resource";
const AS = "https://mcp-auth.granola.ai";
const AS_META_URL = `${AS}/.well-known/oauth-authorization-server`;

const PRM = {
  resource: SERVER,
  authorization_servers: [AS],
  bearer_methods_supported: ["header"],
  scopes_supported: ["mcp"],
};
const AS_META = {
  issuer: AS,
  authorization_endpoint: `${AS}/oauth2/authorize`,
  token_endpoint: `${AS}/oauth2/token`,
  registration_endpoint: `${AS}/oauth2/register`,
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["email", "offline_access", "openid", "profile"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic", "private_key_jwt"],
};

type Handler = (init: RequestInit) => Response | Promise<Response>;
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect?: RequestInit["redirect"];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fakeNet(routes: Record<string, Handler>, opts: { addresses?: string[] } = {}) {
  const calls: Call[] = [];
  const net: McpOAuthNet = {
    lookup: async () => opts.addresses ?? ["34.120.10.10"],
    now: () => 1_000_000,
    fetchImpl: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      calls.push({
        url,
        method,
        headers: { ...(init.headers as Record<string, string>) },
        body: typeof init.body === "string" ? init.body : "",
        ...(init.redirect ? { redirect: init.redirect } : {}),
      });
      const handler = routes[`${method} ${url}`];
      return handler ? handler(init) : new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return { net, calls };
}

const challenge = () =>
  new Response("", {
    status: 401,
    headers: { "www-authenticate": `Bearer resource_metadata="${PRM_URL}"` },
  });

const granolaRoutes = (overrides: Record<string, Handler> = {}): Record<string, Handler> => ({
  [`POST ${SERVER}`]: challenge,
  [`GET ${PRM_URL}`]: () => json(PRM),
  [`GET ${AS_META_URL}`]: () => json(AS_META),
  ...overrides,
});

function registration(partial: Partial<McpOAuthRegistration> = {}): McpOAuthRegistration {
  return {
    serverId: "granola",
    serverUrl: SERVER,
    resource: SERVER,
    issuer: AS,
    authorizationEndpoint: `${AS}/oauth2/authorize`,
    tokenEndpoint: `${AS}/oauth2/token`,
    scopes: ["mcp", "offline_access"],
    issParameterSupported: false,
    clientId: "client-1",
    clientSecret: "client-secret-1",
    tokenEndpointAuthMethod: "client_secret_basic",
    redirectUri: "https://mo.example.com/v1/connectors/oauth/mcp-granola/callback",
    source: "dcr",
    registeredAt: 1,
    registeredBy: "internal:admin",
    ...partial,
  };
}

test("parses Bearer challenges with quoted and bare parameters", () => {
  assert.deepEqual(parseBearerChallenge(`Bearer resource_metadata="${PRM_URL}", scope="mcp read"`), {
    resourceMetadata: PRM_URL,
    scope: "mcp read",
  });
  assert.deepEqual(parseBearerChallenge(`Bearer error=invalid_token, resource_metadata=${PRM_URL}`), {
    resourceMetadata: PRM_URL,
  });
  assert.deepEqual(parseBearerChallenge(`Basic realm="x"`), {});
  assert.deepEqual(parseBearerChallenge(null), {});
});

test("discovery follows the 401 challenge to PRM and RFC 8414 metadata (Granola shape)", async () => {
  const { net, calls } = fakeNet(granolaRoutes());
  const found = await discover(SERVER, net);
  assert.equal(found.resource, SERVER);
  assert.deepEqual(found.scopes, ["mcp", "offline_access"]);
  assert.equal(found.authServer.issuer, AS);
  assert.equal(found.authServer.tokenEndpoint, `${AS}/oauth2/token`);
  assert.equal(found.authServer.registrationEndpoint, `${AS}/oauth2/register`);
  assert.equal(found.authServer.issParameterSupported, false);
  const probe = calls[0]!;
  assert.equal(probe.method, "POST");
  assert.equal(JSON.parse(probe.body).method, "initialize");
  assert.equal(probe.headers.authorization, undefined);
  assert.ok(calls.every((c) => c.redirect === "error"));
});

test("a challenge scope wins over PRM scopes_supported", async () => {
  const { net } = fakeNet(
    granolaRoutes({
      [`POST ${SERVER}`]: () =>
        new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${PRM_URL}", scope="meetings:read"` },
        }),
    }),
  );
  assert.deepEqual((await discover(SERVER, net)).scopes, ["meetings:read", "offline_access"]);
});

test("discovery falls back to path-inserted then root well-known PRM when the challenge has no metadata", async () => {
  const pathPrm = "https://mcp.granola.ai/.well-known/oauth-protected-resource/mcp";
  const first = fakeNet(
    granolaRoutes({ [`POST ${SERVER}`]: () => new Response("", { status: 401 }), [`GET ${pathPrm}`]: () => json(PRM) }),
  );
  assert.equal((await discover(SERVER, first.net)).resource, SERVER);
  assert.ok(first.calls.some((c) => c.url === pathPrm));
  assert.ok(!first.calls.some((c) => c.url === PRM_URL));

  const second = fakeNet(granolaRoutes({ [`POST ${SERVER}`]: () => new Response("", { status: 401 }) }));
  assert.equal((await discover(SERVER, second.net)).resource, SERVER);
  assert.deepEqual(
    second.calls
      .filter((c) => c.method === "GET")
      .map((c) => c.url)
      .slice(0, 2),
    [pathPrm, PRM_URL],
  );
});

test("discovery rejects a PRM resource from another origin", async () => {
  const { net } = fakeNet(
    granolaRoutes({ [`GET ${PRM_URL}`]: () => json({ ...PRM, resource: "https://evil.example/mcp" }) }),
  );
  await assert.rejects(discover(SERVER, net), /resource does not match/);
});

test("discovery matches the PRM resource by whole path segments", async () => {
  for (const resource of ["https://mcp.granola.ai/mc", "https://mcp.granola.ai/mcp/v2"]) {
    const { net } = fakeNet(granolaRoutes({ [`GET ${PRM_URL}`]: () => json({ ...PRM, resource }) }));
    await assert.rejects(discover(SERVER, net), /resource does not match/, resource);
  }
  for (const resource of ["https://mcp.granola.ai", "https://mcp.granola.ai/mcp/"]) {
    const { net } = fakeNet(granolaRoutes({ [`GET ${PRM_URL}`]: () => json({ ...PRM, resource }) }));
    assert.equal((await discover(SERVER, net)).resource, resource);
  }
});

test("discovery rejects an issuer mismatch, including a trailing-slash variant", async () => {
  for (const issuer of ["https://other.example", `${AS}/`]) {
    const { net } = fakeNet(granolaRoutes({ [`GET ${AS_META_URL}`]: () => json({ ...AS_META, issuer }) }));
    await assert.rejects(discover(SERVER, net), /issuer does not match/, issuer);
  }
});

test("discovery refuses an authorization server without PKCE S256", async () => {
  const { code_challenge_methods_supported: _omit, ...noPkce } = AS_META;
  for (const meta of [noPkce, { ...AS_META, code_challenge_methods_supported: ["plain"] }]) {
    const { net } = fakeNet(granolaRoutes({ [`GET ${AS_META_URL}`]: () => json(meta) }));
    await assert.rejects(discover(SERVER, net), /S256/);
  }
});

test("discovery rejects plain-http endpoints and private-network hosts", async () => {
  const http = fakeNet(
    granolaRoutes({
      [`GET ${AS_META_URL}`]: () => json({ ...AS_META, token_endpoint: "http://mcp-auth.granola.ai/t" }),
    }),
  );
  await assert.rejects(discover(SERVER, http.net), /must use https/);
  await assert.rejects(discover("http://mcp.granola.ai/mcp", http.net), /must use https/);
  const priv = fakeNet(granolaRoutes(), { addresses: ["10.0.0.7"] });
  await assert.rejects(discover(SERVER, priv.net), /public network address/);
  assert.equal(priv.calls.length, 0);
  const literal = fakeNet({});
  await assert.rejects(discover("https://169.254.169.254/mcp", literal.net), /public network address/);
});

test("loopback http is allowed only when the net opts in", async () => {
  const local = "http://127.0.0.1:9999/mcp";
  const { net } = fakeNet({});
  await assert.rejects(discover(local, net), /must use https/);
  const allowed = fakeNet({ [`POST ${local}`]: () => new Response("", { status: 401 }) });
  await assert.rejects(discover(local, { ...allowed.net, allowLoopbackHttp: true }), /does not advertise/);
});

test("discovery rejects redirects", async () => {
  const { net } = fakeNet(
    granolaRoutes({
      [`GET ${PRM_URL}`]: () => new Response("", { status: 302, headers: { location: "https://evil.example" } }),
    }),
  );
  await assert.rejects(discover(SERVER, net), /redirected/);
});

test("responses over the body cap are rejected", async () => {
  const { net } = fakeNet(granolaRoutes({ [`GET ${PRM_URL}`]: () => new Response("x".repeat(300 * 1024)) }));
  await assert.rejects(discover(SERVER, net), /too large/);
});

test("dynamic client registration sends the RFC 7591 shape and honors the server's answer", async () => {
  const { net, calls } = fakeNet({
    [`POST ${AS}/oauth2/register`]: () =>
      json(
        {
          client_id: "dcr-client",
          client_secret: "dcr-secret",
          client_secret_expires_at: 2_000_000,
          token_endpoint_auth_method: "client_secret_post",
          registration_access_token: "rat",
        },
        201,
      ),
  });
  const found = await discover(SERVER, fakeNet(granolaRoutes()).net);
  const reg = await registerClient(found.authServer, "https://mo.example.com/cb", "QM (mo.example.com)", net);
  const body = JSON.parse(calls[0]!.body);
  assert.deepEqual(body, {
    client_name: "QM (mo.example.com)",
    redirect_uris: ["https://mo.example.com/cb"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_basic",
  });
  assert.deepEqual(reg, {
    clientId: "dcr-client",
    clientSecret: "dcr-secret",
    clientSecretExpiresAt: 2_000_000_000,
    tokenEndpointAuthMethod: "client_secret_post",
    registrationAccessToken: "rat",
  });
});

test("registration rejects a confidential client without a secret and an unsupported method", async () => {
  const meta = (await discover(SERVER, fakeNet(granolaRoutes()).net)).authServer;
  const noSecret = fakeNet({ [`POST ${AS}/oauth2/register`]: () => json({ client_id: "c" }, 201) });
  await assert.rejects(registerClient(meta, "https://x/cb", "QM", noSecret.net), /client_secret/);
  const odd = fakeNet({
    [`POST ${AS}/oauth2/register`]: () => json({ client_id: "c", token_endpoint_auth_method: "private_key_jwt" }, 201),
  });
  await assert.rejects(registerClient(meta, "https://x/cb", "QM", odd.net), /unsupported auth method/);
  const publicClient = fakeNet({
    [`POST ${AS}/oauth2/register`]: () => json({ client_id: "pub", token_endpoint_auth_method: "none" }, 201),
  });
  assert.deepEqual(await registerClient(meta, "https://x/cb", "QM", publicClient.net), {
    clientId: "pub",
    tokenEndpointAuthMethod: "none",
  });
  assert.equal(manualRegistration(meta, "m").tokenEndpointAuthMethod, "none");
  assert.equal(manualRegistration(meta, "m", "s").tokenEndpointAuthMethod, "client_secret_basic");
});

test("the authorize URL carries PKCE S256, state, scope and the RFC 8707 resource", () => {
  const url = new URL(authorizeUrl(registration(), { state: "st", codeChallenge: "cc" }));
  assert.equal(url.origin + url.pathname, `${AS}/oauth2/authorize`);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("redirect_uri"), registration().redirectUri);
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("code_challenge"), "cc");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "mcp offline_access");
  assert.equal(url.searchParams.get("resource"), SERVER);
  const override = new URL(authorizeUrl(registration(), { state: "st", codeChallenge: "cc", scopes: ["a"] }));
  assert.equal(override.searchParams.get("scope"), "a");
});

test("code exchange sends the verifier, resource and client auth per method", async () => {
  const tokenUrl = `${AS}/oauth2/token`;
  const ok = () =>
    json({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 3600, scope: "mcp" });
  const basic = fakeNet({ [`POST ${tokenUrl}`]: ok });
  const tokens = await exchangeCode(registration(), { code: "the-code", codeVerifier: "ver" }, basic.net);
  assert.deepEqual(tokens, { accessToken: "at", refreshToken: "rt", expiresAt: 1_000_000 + 3_600_000, scope: "mcp" });
  const sent = new URLSearchParams(basic.calls[0]!.body);
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "the-code");
  assert.equal(sent.get("code_verifier"), "ver");
  assert.equal(sent.get("redirect_uri"), registration().redirectUri);
  assert.equal(sent.get("resource"), SERVER);
  assert.equal(sent.get("client_secret"), null);
  assert.equal(
    basic.calls[0]!.headers.authorization,
    `Basic ${Buffer.from("client-1:client-secret-1").toString("base64")}`,
  );

  const post = fakeNet({ [`POST ${tokenUrl}`]: ok });
  await exchangeCode(
    registration({ tokenEndpointAuthMethod: "client_secret_post" }),
    { code: "c", codeVerifier: "v" },
    post.net,
  );
  const postBody = new URLSearchParams(post.calls[0]!.body);
  assert.equal(postBody.get("client_id"), "client-1");
  assert.equal(postBody.get("client_secret"), "client-secret-1");
  assert.equal(post.calls[0]!.headers.authorization, undefined);

  const none = fakeNet({ [`POST ${tokenUrl}`]: ok });
  await exchangeCode(
    registration({ tokenEndpointAuthMethod: "none", clientSecret: undefined }),
    { code: "c", codeVerifier: "v" },
    none.net,
  );
  const noneBody = new URLSearchParams(none.calls[0]!.body);
  assert.equal(noneBody.get("client_id"), "client-1");
  assert.equal(noneBody.get("client_secret"), null);

  const refreshed = fakeNet({ [`POST ${tokenUrl}`]: () => json({ access_token: "at2", token_type: "bearer" }) });
  assert.deepEqual(await refreshAccessToken(registration(), "rt", refreshed.net), { accessToken: "at2" });
  const refreshBody = new URLSearchParams(refreshed.calls[0]!.body);
  assert.equal(refreshBody.get("grant_type"), "refresh_token");
  assert.equal(refreshBody.get("refresh_token"), "rt");
  assert.equal(refreshBody.get("resource"), SERVER);
});

test("token failures surface only the OAuth error fields and classify permanence", async () => {
  const tokenUrl = `${AS}/oauth2/token`;
  const denied = fakeNet({
    [`POST ${tokenUrl}`]: () =>
      json({ error: "invalid_grant", error_description: "expired", leaked: "secret-body" }, 400),
  });
  const error = await refreshAccessToken(registration(), "rt", denied.net).catch((e: unknown) => e);
  assert.ok(error instanceof McpOAuthError);
  assert.match(error.message, /invalid_grant: expired/);
  assert.doesNotMatch(error.message, /secret-body/);
  assert.equal(isPermanentOAuthFailure(error), true);

  const down = fakeNet({ [`POST ${tokenUrl}`]: () => new Response("<html>oops secret</html>", { status: 503 }) });
  const transient = await refreshAccessToken(registration(), "rt", down.net).catch((e: unknown) => e);
  assert.match((transient as Error).message, /HTTP 503/);
  assert.doesNotMatch((transient as Error).message, /secret/);
  assert.equal(isPermanentOAuthFailure(transient), false);

  const notBearer = fakeNet({ [`POST ${tokenUrl}`]: () => json({ access_token: "at", token_type: "mac" }) });
  await assert.rejects(exchangeCode(registration(), { code: "c", codeVerifier: "v" }, notBearer.net), /bearer/);
});

test("only grant and client rejections are permanent; throttling, timeouts and bare 4xx are transient", async () => {
  const tokenUrl = `${AS}/oauth2/token`;
  const failure = async (res: () => Response) =>
    refreshAccessToken(registration(), "rt", fakeNet({ [`POST ${tokenUrl}`]: res }).net).catch((e: unknown) => e);
  for (const code of ["invalid_grant", "invalid_client", "unauthorized_client"]) {
    assert.equal(
      isPermanentOAuthFailure(await failure(() => json({ error: code }, code === "invalid_client" ? 401 : 400))),
      true,
      code,
    );
  }
  for (const status of [400, 401, 408, 429]) {
    assert.equal(isPermanentOAuthFailure(await failure(() => new Response("", { status }))), false, String(status));
  }
  assert.equal(isPermanentOAuthFailure(await failure(() => json({ error: "slow_down" }, 429))), false);
  assert.equal(isPermanentOAuthFailure(await failure(() => json({ error: "invalid_scope" }, 400))), false);
});
