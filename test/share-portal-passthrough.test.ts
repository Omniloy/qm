import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { withinRateLimit, type ClaimStore } from "../plugins/chassis/src/claims.ts";
import { deriveKey, seal } from "../plugins/portal/src/session.ts";
import {
  anonymousShareRequest,
  bestEffortClientIp,
  matchShareAsset,
  matchSharePassthrough,
  isPublicShareCorePath,
  shareBestEffortAccepted,
  shareRateLimitArgs,
  shareRateLimitConfig,
  shareRateLimitProblems,
  shareRateLimitTopologyProblem,
  sharePassthroughEnabled,
  shareRateLimitUsable,
  FORWARD_SHARE_HEADERS,
  SHARE_RESPONSE_HEADERS,
  SHARE_RATE_LIMIT_MAX,
  DEFAULT_SHARE_RATE_LIMIT,
  type SharePassthroughMatch,
} from "../plugins/portal/src/share-passthrough.ts";

/** The real id shape: `${randomUUID()}${randomUUID().replace(/-/g, "")}` — 68 chars. */
const shareId = (): string => `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
const ID = shareId();

const must = (method: string, pathname: string): SharePassthroughMatch => {
  const m = matchSharePassthrough(method, pathname);
  assert.ok(m, `expected ${method} ${pathname} to match the share passthrough`);
  return m;
};

test("the three public share shapes match, and carry the share id without any session identifier", () => {
  assert.equal(ID.length, 68);

  const html = must("GET", `/share/${ID}`);
  assert.equal(html.kind, "html");
  assert.equal(html.shareId, ID);
  assert.equal(html.upstream, "web-ui");
  assert.equal(html.path, `/share/${ID}`, "the path is forwarded verbatim — web-ui serves this exact path");
  assert.equal(html.rateLimitKind, "share-page");

  const json = must("GET", `/api/public/shares/${ID}`);
  assert.equal(json.kind, "json");
  assert.equal(json.rateLimitKind, "share-page");

  const file = must("GET", `/api/public/shares/${ID}/files/art_9a-b.c:1`);
  assert.equal(file.kind, "file");
  assert.equal(file.artifactId, "art_9a-b.c:1");
  assert.equal(file.rateLimitKind, "share-file", "downloads get their own bucket, so they cannot starve readers");
});

test("GET only — the passthrough sits above the session gate, where the same-origin CSRF check has not run yet", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "get"]) {
    assert.equal(matchSharePassthrough(method, `/share/${ID}`), null, `${method} /share must not pass through`);
    assert.equal(matchSharePassthrough(method, `/api/public/shares/${ID}`), null);
    assert.equal(matchSharePassthrough(method, `/api/public/shares/${ID}/files/a1`), null);
  }
});

test("the patterns are anchored: no prefix match ever hands an authenticated web-ui API to an anonymous caller", () => {
  const nonMatches = [
    "/api/sessions",
    "/api/public",
    "/api/public/shares",
    "/api/public/shares/",
    `/api/public/shares/${ID}/`,
    `/api/public/shares/${ID}/entries`,
    `/api/public/shares/${ID}/files`,
    `/api/public/shares/${ID}/files/`,
    `/api/public/shares/${ID}/files/a/b`,
    `/api/public/sharesX/${ID}`,
    `/api/public/shares${ID}`,
    `/x/api/public/shares/${ID}`,
    `/share/${ID}/edit`,
    `/shares/${ID}`,
    `/shared/${ID}`,
    "/share/short",
    `/share/${ID.slice(0, 31)}`,
    `/share/${"a".repeat(81)}`,
    `/share/${ID}?x=1`, // the matcher sees url.pathname, so a literal "?" is not an id character
    `/share/${encodeURIComponent(ID)}%2f..`,
    `/api/public/shares/${ID}%2f..%2fsessions`,
    `/api/public/shares/${ID}/../sessions`,
    `/API/public/shares/${ID}`,
    "/v1/shares/" + ID,
  ];
  for (const p of nonMatches) {
    assert.equal(matchSharePassthrough("GET", p), null, `${p} must not match`);
  }
});

test("a `..` artifact id is refused even though the illegal-path guard would normally have eaten it first", () => {
  assert.equal(matchSharePassthrough("GET", `/api/public/shares/${ID}/files/..`), null);
  assert.equal(matchSharePassthrough("GET", `/api/public/shares/${ID}/files/a..b`), null);
  assert.ok(matchSharePassthrough("GET", `/api/public/shares/${ID}/files/a.b`));
});

test("the share namespace is closed to the x-agent-capability passthrough", () => {
  // The predicate as it will read in handle(): `startsWith("/v1/") && hasAgentCapability(req)`
  // with the new `&& !isPublicShareCorePath(pathname)` guard.
  const reaches = (pathname: string): boolean => pathname.startsWith("/v1/") && !isPublicShareCorePath(pathname);

  assert.equal(reaches(`/v1/shares/${ID}`), false, "an unvalidated capability header must not reach the public route");
  assert.equal(reaches(`/v1/shares/${ID}/files/a1`), false);
  assert.equal(isPublicShareCorePath("/v1/shares"), true);

  assert.equal(reaches("/v1/sessions"), true, "the agent API is untouched");
  assert.equal(reaches("/v1/sharespool"), true, "only the exact namespace is closed");
  assert.equal(isPublicShareCorePath("/v1/sharespool"), false);
  assert.equal(isPublicShareCorePath("/api/public/shares/x"), false);
});

test("forwarded request headers carry no credentials — an anonymous reader stays anonymous end to end", () => {
  for (const banned of ["cookie", "authorization", "x-agent-capability", "x-portal-identity", "x-as-principal"]) {
    assert.ok(!FORWARD_SHARE_HEADERS.includes(banned), `${banned} must never be forwarded on a share request`);
  }
  assert.deepEqual([...FORWARD_SHARE_HEADERS], ["accept", "accept-language", "user-agent"]);
});

test("share responses are unstoreable and vary by identity — a cached 200 would outlive Unshare", () => {
  assert.match(SHARE_RESPONSE_HEADERS["cache-control"] ?? "", /no-store/);
  assert.match(SHARE_RESPONSE_HEADERS["vary"] ?? "", /x-portal-identity/);
  assert.match(SHARE_RESPONSE_HEADERS["vary"] ?? "", /cookie/);
  assert.match(SHARE_RESPONSE_HEADERS["x-robots-tag"] ?? "", /noindex/);
});

test("rate-limit arguments follow the playground precedent and split page views from downloads", () => {
  const cfg = DEFAULT_SHARE_RATE_LIMIT;
  const page = shareRateLimitArgs(must("GET", `/share/${ID}`), "203.0.113.7", cfg, "s3cret", 1_000);
  assert.deepEqual(page, {
    secret: "s3cret",
    kind: "share-page",
    value: "203.0.113.7",
    limit: cfg.pageLimit,
    windowS: cfg.windowS,
    nowMs: 1_000,
  });

  const file = shareRateLimitArgs(
    must("GET", `/api/public/shares/${ID}/files/a1`),
    "2001:db8::/64",
    cfg,
    "s3cret",
    1_000,
  );
  assert.equal(file.kind, "share-file");
  assert.equal(file.limit, cfg.fileLimit);
  assert.equal(file.value, "2001:db8::/64", "the bucketed IP is the key, so a /64 cannot buy fresh buckets");
});

test("config parsing and the 64-slot ceiling core actually enforces", () => {
  assert.deepEqual(shareRateLimitConfig({}), DEFAULT_SHARE_RATE_LIMIT);
  assert.deepEqual(
    shareRateLimitConfig({
      PORTAL_SHARE_VIEWS_PER_IP: "10",
      PORTAL_SHARE_FILES_PER_IP: "5",
      PORTAL_SHARE_ASSETS_PER_IP: "40",
      PORTAL_SHARE_RATE_WINDOW_S: "30",
    }),
    { pageLimit: 10, fileLimit: 5, assetLimit: 40, windowS: 30 },
  );

  assert.deepEqual(shareRateLimitProblems(DEFAULT_SHARE_RATE_LIMIT), []);
  assert.equal(shareRateLimitProblems({ ...DEFAULT_SHARE_RATE_LIMIT, pageLimit: 0 }).length, 1);
  assert.equal(
    shareRateLimitProblems({ ...DEFAULT_SHARE_RATE_LIMIT, pageLimit: SHARE_RATE_LIMIT_MAX + 1 }).length,
    1,
    "a limit above the claim-slot ceiling would silently become no limit at all",
  );
  assert.equal(shareRateLimitProblems({ pageLimit: 60, fileLimit: 30, assetLimit: 64, windowS: 5 }).length, 1);
  assert.equal(shareRateLimitProblems(shareRateLimitConfig({ PORTAL_SHARE_VIEWS_PER_IP: "sixty" })).length, 1);
});

test("the limit really throttles: N pass, N+1 is refused, and buckets are independent per IP and per kind", async () => {
  const claimed = new Set<string>();
  const store: ClaimStore = {
    claimFirst: async (ids) => {
      for (const id of ids) {
        if (!claimed.has(id)) {
          claimed.add(id);
          return id;
        }
      }
      return null;
    },
  };
  const cfg = { pageLimit: 4, fileLimit: 2, assetLimit: 3, windowS: 60 };
  const secret = "portal-share-rate-secret";
  const at = (nowMs: number, pathname: string, ip: string): Promise<boolean> =>
    withinRateLimit(store, shareRateLimitArgs(must("GET", pathname), ip, cfg, secret, nowMs));

  const page = `/share/${ID}`;
  const files = `/api/public/shares/${ID}/files/a1`;
  const t0 = 60_000;

  for (let i = 0; i < cfg.pageLimit; i++) {
    assert.equal(await at(t0, page, "198.51.100.4"), true, `request ${i + 1} within the limit`);
  }
  assert.equal(await at(t0, page, "198.51.100.4"), false, "one over the limit is refused");

  assert.equal(await at(t0, files, "198.51.100.4"), true, "downloads are a separate bucket");
  assert.equal(await at(t0, page, "198.51.100.9"), true, "a different IP is unaffected");
  assert.equal(await at(t0 + cfg.windowS * 1000, page, "198.51.100.4"), true, "the next window is fresh");
});

test("the passthrough is on unless explicitly switched off", () => {
  assert.equal(sharePassthroughEnabled(undefined), true);
  assert.equal(sharePassthroughEnabled("1"), true);
  assert.equal(sharePassthroughEnabled("0"), false);
  assert.equal(sharePassthroughEnabled(" OFF "), false);
  assert.equal(sharePassthroughEnabled("false"), false);
  assert.equal(sharePassthroughEnabled("no"), false);
});

// ---------------------------------------------------------------------------
// Identity. The single decision that makes member and outsider reachable.
// ---------------------------------------------------------------------------

test("a signed-in visitor never takes the anonymous branch — that fall-through is what mints their identity", () => {
  const page = `/share/${ID}`;

  assert.ok(anonymousShareRequest(true, false, "GET", page), "a stranger with a link is served here");
  assert.equal(
    anonymousShareRequest(true, true, "GET", page),
    null,
    "a portal session must fall through to proxyToSurface, which is the only thing that mints x-portal-identity",
  );
  assert.equal(anonymousShareRequest(true, true, "GET", `/api/public/shares/${ID}`), null);
  assert.equal(anonymousShareRequest(true, true, "GET", `/api/public/shares/${ID}/files/a1`), null);

  assert.equal(anonymousShareRequest(false, false, "GET", page), null, "the kill switch closes the branch");
  assert.equal(anonymousShareRequest(true, false, "POST", page), null, "still GET-only");
  assert.equal(anonymousShareRequest(true, false, "GET", "/api/sessions"), null);
});

test("shareRateLimitUsable says whether the bucket key is TRUSTED, not whether a limit runs", () => {
  // Behind Traefik/Dokploy with no trusted-hop config, clientIpOf returns the
  // proxy for everybody. That is a reason to key differently, not a reason to
  // stop limiting: an earlier revision turned the limit off in exactly this
  // topology, which is the only topology this deploys to.
  assert.equal(shareRateLimitUsable({ onFly: false, xffTrustedHops: 0 }), false);
  assert.equal(shareRateLimitUsable({ onFly: false, xffTrustedHops: 1 }), true);
  assert.equal(shareRateLimitUsable({ onFly: true, xffTrustedHops: 0 }), true);
});

test("the best-effort key still gives each reader a bucket when the trusted one is unavailable", () => {
  // Traefik appends the peer, so the rightmost hop is the visitor.
  assert.equal(bestEffortClientIp("10.0.0.1", "203.0.113.9"), "203.0.113.9");
  assert.equal(bestEffortClientIp("10.0.0.1", "198.51.100.2, 203.0.113.9"), "203.0.113.9");
  assert.equal(bestEffortClientIp("10.0.0.1", ["198.51.100.2", "203.0.113.9"]), "203.0.113.9");
  assert.equal(bestEffortClientIp("10.0.0.1", "  "), "10.0.0.1", "no header: the socket IS the client");
  assert.equal(bestEffortClientIp("10.0.0.1", undefined), "10.0.0.1");
  assert.equal(bestEffortClientIp(undefined, undefined), "unknown");
});

test("production refuses to boot on an untrusted client key unless an operator says so out loud", () => {
  const problem = shareRateLimitTopologyProblem({ isProd: true, keyed: false, bestEffortAccepted: false });
  assert.ok(problem, "a console.warn nobody reads is not an abuse control");
  assert.match(problem, /PORTAL_XFF_TRUSTED_HOPS/);
  assert.match(problem, /PORTAL_SHARE_RATE_LIMIT_BEST_EFFORT/);

  assert.equal(shareRateLimitTopologyProblem({ isProd: true, keyed: true, bestEffortAccepted: false }), null);
  assert.equal(shareRateLimitTopologyProblem({ isProd: true, keyed: false, bestEffortAccepted: true }), null);
  assert.equal(
    shareRateLimitTopologyProblem({ isProd: false, keyed: false, bestEffortAccepted: false }),
    null,
    "with no proxy in front the socket address IS the client — only production has to decide",
  );

  assert.equal(shareBestEffortAccepted(undefined), false, "an accepted-risk flag is never the default");
  assert.equal(shareBestEffortAccepted("0"), false);
  assert.equal(shareBestEffortAccepted("1"), true);
  assert.equal(shareBestEffortAccepted(" YES "), true);
});

// ---------------------------------------------------------------------------
// The bundle. Without it the share page is HTML with nothing behind it.
// ---------------------------------------------------------------------------

test("the built SPA bundle is anonymous, one directory deep, and its own rate-limit bucket", () => {
  const asset = matchShareAsset("GET", "/assets/index-D4tR9x0a.js", { devAssets: false });
  assert.ok(asset, "no anonymous asset path means /share/<id> renders a white page");
  assert.equal(asset.kind, "asset");
  assert.equal(asset.shareId, "", "a bundle request carries no share id");
  assert.equal(asset.upstream, "web-ui");
  assert.equal(asset.path, "/assets/index-D4tR9x0a.js");
  assert.equal(asset.rateLimitKind, "share-asset");

  assert.ok(matchShareAsset("GET", "/assets/index-9f2c.css", { devAssets: false }));
  assert.ok(matchShareAsset("GET", "/assets/KaTeX_Main-Regular-CQyj7A.woff2", { devAssets: false }));

  for (const p of [
    "/assets/",
    "/assets/../server/index.ts",
    "/assets/nested/app.js",
    "/assetsx/app.js",
    "/x/assets/app.js",
    "/dist-web/index.html",
    "/index.html",
    "/api/sessions",
  ]) {
    assert.equal(matchShareAsset("GET", p, { devAssets: false }), null, `${p} must not be anonymous`);
  }
  assert.equal(matchShareAsset("POST", "/assets/index-abc.js", { devAssets: false }), null, "GET only, like the rest");
});

test("vite's module graph is anonymous in development only — /@fs would otherwise publish the repo", () => {
  const devOnly = ["/src/main.ts", "/@vite/client", "/@id/vite/preload-helper", "/node_modules/.vite/deps/katex.js"];
  for (const p of devOnly) {
    assert.ok(matchShareAsset("GET", p, { devAssets: true }), `${p} is how the dev shell loads`);
    assert.equal(matchShareAsset("GET", p, { devAssets: false }), null, `${p} must never be anonymous in production`);
  }
  assert.ok(matchShareAsset("GET", "/@fs/Users/x/qm/plugins/web-ui/src/main.ts", { devAssets: true }));
  assert.equal(matchShareAsset("GET", "/@fs/Users/x/qm/.env", { devAssets: false }), null);
  assert.equal(
    matchShareAsset("GET", "/src/../../.env", { devAssets: true }),
    null,
    "no dot pair reaches a filesystem",
  );
});

test("the asset bucket is separate and generous: a page load must not spend the reader's poll budget", () => {
  const cfg = DEFAULT_SHARE_RATE_LIMIT;
  const asset = matchShareAsset("GET", "/assets/index-abc.js", { devAssets: false })!;
  const args = shareRateLimitArgs(asset, "203.0.113.7", cfg, "s3cret", 1_000);
  assert.equal(args.kind, "share-asset");
  assert.equal(args.limit, cfg.assetLimit);
  assert.ok(cfg.assetLimit > cfg.pageLimit / 2, "one cold page load is ~10 subresources");
  assert.ok(cfg.assetLimit <= SHARE_RATE_LIMIT_MAX, "core grants at most 64 claim slots per request");
});

test("anonymousShareRequest serves the bundle to strangers and to nobody with a session", () => {
  assert.ok(anonymousShareRequest(true, false, "GET", "/assets/index-abc.js"));
  assert.equal(anonymousShareRequest(true, true, "GET", "/assets/index-abc.js"), null, "signed-in: normal proxy");
  assert.equal(anonymousShareRequest(false, false, "GET", "/assets/index-abc.js"), null, "the kill switch closes it");
  assert.equal(anonymousShareRequest(true, false, "GET", "/src/main.ts"), null, "dev paths are opt-in");
  assert.ok(anonymousShareRequest(true, false, "GET", "/src/main.ts", { devAssets: true }));
});

// ---------------------------------------------------------------------------
// The wiring itself. Every helper above passed its unit tests in the previous
// round while having zero call sites, so these read the portal source.
// ---------------------------------------------------------------------------

const PORTAL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "portal", "src", "index.ts"),
  "utf8",
);

test("the portal calls the share branch, below the illegal-path guard and above the session gate", () => {
  const guardAt = PORTAL.indexOf('message: "illegal path"');
  const branchAt = PORTAL.indexOf("const share = anonymousShareRequest(");
  const sessionGateAt = PORTAL.indexOf('if (!session) {\n    if (method === "GET" && wantsHtml(req))');
  const csrfAt = PORTAL.indexOf('message: "cross-origin request refused" });\n  }\n\n  if (isDeployment)');

  assert.ok(branchAt > 0, "the share branch has no call site — /share/<id> would bounce to /auth/login");
  assert.ok(guardAt > 0 && guardAt < branchAt, "the branch must run below the illegal-path guard");
  assert.ok(sessionGateAt > 0 && branchAt < sessionGateAt, "the branch must run above the session gate");
  assert.ok(csrfAt === -1 || branchAt < csrfAt);
  assert.ok(PORTAL.includes("FORWARD_SHARE_HEADERS"), "the header allowlist is not applied");
  assert.ok(PORTAL.includes("SHARE_RESPONSE_HEADERS"), "the response header floor is not applied");
});

test("the per-client rate limit is wired into the branch with the portal's own client IP", () => {
  const branch = PORTAL.slice(
    PORTAL.indexOf("const share = anonymousShareRequest("),
    PORTAL.indexOf("const consentBounce = "),
  );
  assert.ok(branch.includes("withinRateLimit("), "no rate limit — core never sees a client IP on this path");
  assert.ok(branch.includes("mintBucketOf(shareClientIpOf(req))"), "the bucket must be the /64-collapsed client IP");
  assert.ok(
    !PORTAL.includes("if (shareClaims)"),
    "the claim store must be unconditional — a limit that is skipped on the deployed topology is no limit",
  );
  assert.ok(branch.includes("shareRateLimitArgs("));
  assert.ok(branch.includes('error: "rate_limited"'));
  assert.ok(branch.includes("proxyToUpstream("));
  // The anonymous branch must not hand core a credential of any kind.
  for (const banned of ["PORTAL_IDENTITY_HEADER", "mintPortalIdentity", "x-as-principal", "cookie"]) {
    assert.ok(!branch.includes(banned), `${banned} must not appear in the anonymous share branch`);
  }
});

test("the x-agent-capability passthrough excludes the share namespace", () => {
  assert.ok(
    PORTAL.includes('pathname.startsWith("/v1/") && !isPublicShareCorePath(pathname) && hasAgentCapability(req)'),
    "an unvalidated x-agent-capability header still reaches /v1/shares/<id> directly, skipping the rate limit",
  );
});

test("bootChecks validates the configured limits and refuses an unkeyed production limiter", () => {
  assert.ok(PORTAL.includes("shareRateLimitProblems(SHARE_RATE_LIMIT)"));
  assert.ok(
    PORTAL.includes("shareRateLimitTopologyProblem({"),
    "the untrusted-proxy case must be a boot problem, not a console.warn",
  );
  assert.ok(
    PORTAL.includes("const SHARE_DEV_ASSETS = !IS_PROD;"),
    "vite's /@fs, /src and /@id must never be anonymous in production",
  );
});

// ---------------------------------------------------------------------------
// A real portal, on a real socket.
//
// Everything above this line reads source text or calls a pure function, and
// that is exactly how the previous round shipped a share page that relayed its
// HTML and then 401'd every script and stylesheet the HTML asked for. These
// tests boot the portal against two stub upstreams and probe it over HTTP.
// ---------------------------------------------------------------------------

const stub = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> => {
  const s = createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        s.closeAllConnections();
        s.close(() => resolve());
      }),
  };
};

test("a booted portal serves the share page AND its bundle anonymously, and still gates everything else", async (t) => {
  // Core stub: grants every claim slot, so the rate limiter lets the request through.
  const core = await stub((req, res) => {
    if (req.method === "POST" && (req.url ?? "").startsWith("/v1/auth/broker/claim")) {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        const ids = (JSON.parse(body || "{}") as { ids?: string[] }).ids ?? [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ claimed: ids[0] ?? null }));
      });
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  // web-ui stub: records what the portal forwarded.
  const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined> }> = [];
  const webui = await stub((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    req.resume();
    const immutable = (req.url ?? "").startsWith("/assets/");
    res.writeHead(200, {
      "content-type": immutable ? "application/javascript" : "text/html; charset=utf-8",
      ...(immutable ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
    });
    res.end(`web-ui:${req.url ?? ""}`);
  });

  const SECRET = "test-portal-session-secret";
  process.env.CORE_API_URL = core.url;
  process.env.WEB_UI_UPSTREAM = webui.url;
  process.env.CORE_ORG_ID = "test-org";
  process.env.CORE_SIGNING_SECRET = "test-core-signing-secret";
  process.env.PORTAL_IDENTITY_SECRET = "test-portal-identity-secret";
  process.env.PORTAL_SESSION_SECRET = SECRET;
  delete process.env.PORTAL_PUBLIC_SHARE_LINKS;
  delete process.env.PORTAL_PLAYGROUND;
  delete process.env.PORTAL_LOCAL_AUTH_BYPASS;

  // The env above is read at module load, so the import has to happen here.
  const portal = (await import("../plugins/portal/src/index.ts")) as { server: Server };
  await new Promise<void>((resolve) => portal.server.listen(0, "127.0.0.1", resolve));
  const { port } = portal.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  t.after(async () => {
    portal.server.closeAllConnections();
    await new Promise<void>((resolve) => portal.server.close(() => resolve()));
    await webui.close();
    await core.close();
  });

  const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${origin}${path}`, { headers, redirect: "manual" });

  // 1. The page itself.
  const page = await get(`/share/${ID}`, { accept: "text/html" });
  assert.equal(page.status, 200, "an anonymous reader must not be bounced to /auth/login");
  assert.equal(await page.text(), `web-ui:/share/${ID}`);
  assert.match(page.headers.get("cache-control") ?? "", /no-store/);
  assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);

  // 2. The subresources that page immediately requests. This is the regression:
  //    a script request fails wantsHtml(), so the session gate answers 401.
  for (const [path, accept] of [
    ["/assets/index-abc123.js", "*/*"],
    ["/assets/index-abc123.css", "text/css"],
    ["/src/main.ts", "*/*"],
  ] as const) {
    const r = await get(path, { accept });
    assert.equal(r.status, 200, `${path} (Accept: ${accept}) 401s — the share page renders blank`);
    assert.equal(await r.text(), `web-ui:${path}`);
  }
  assert.match(
    (await get("/assets/index-abc123.js")).headers.get("cache-control") ?? "",
    /immutable/,
    "the bundle is content-hashed: no-store here would re-download the app on every share view",
  );

  // 3. The transcript and a download.
  assert.equal((await get(`/api/public/shares/${ID}`)).status, 200);
  assert.equal((await get(`/api/public/shares/${ID}/files/a1`)).status, 200);

  // 4. Nothing else moved. These are the paths the anonymous branch must never widen to.
  //    (`/@fs/...` IS anonymous here: this process is not NODE_ENV=production, so the portal
  //    opened vite's dev graph. That switch is `SHARE_DEV_ASSETS = !IS_PROD`, asserted below.)
  for (const path of ["/api/sessions", "/me", "/api/public/shares", "/assets/", "/"]) {
    const r = await get(path, { accept: "*/*" });
    assert.notEqual(r.status, 200, `${path} must not be anonymous`);
  }
  assert.equal((await get(`/share/${ID}`, { accept: "text/html" })).status, 200);
  assert.equal(
    (await fetch(`${origin}/share/${ID}`, { method: "POST", redirect: "manual" })).status,
    401,
    "GET only: the same-origin CSRF check sits below this branch",
  );

  // 5. No credential of any kind was forwarded on the anonymous hops.
  for (const hop of seen) {
    assert.equal(hop.headers.cookie, undefined, `cookie forwarded on ${hop.path}`);
    assert.equal(hop.headers["x-portal-identity"], undefined, `identity forwarded on ${hop.path}`);
    assert.equal(hop.headers.authorization, undefined);
  }

  // 6. A signed-in visitor falls through to the ordinary surface proxy, which is
  //    the ONLY thing that mints x-portal-identity — the header core needs to
  //    answer "member" or "outsider" instead of treating everyone as a stranger.
  seen.length = 0;
  const sealed = seal(
    { k: "session", sub: "U-member", org: "test-org", iat: Math.floor(Date.now() / 1e3), exp: Date.now() / 1e3 + 3600 },
    deriveKey(SECRET, "portal.session.v1"),
  );
  const signedIn = await get(`/share/${ID}`, { accept: "text/html", cookie: `portal_session=${sealed}` });
  assert.equal(signedIn.status, 200);
  const memberHop = seen.at(-1);
  assert.ok(memberHop, "the signed-in request never reached web-ui");
  assert.equal(memberHop.path, `/share/${ID}`);
  assert.ok(
    typeof memberHop.headers["x-portal-identity"] === "string",
    "a signed-in reader arrived at web-ui anonymous — member and outsider are unreachable in production",
  );
});
