/**
 * Public share links: the portal's side of the contract.
 *
 * Everything here is pure. The branch in `handle()` (index.ts) does the I/O — it calls
 * `matchSharePassthrough`, then `withinRateLimit` with `shareRateLimitArgs`, then
 * `proxyToUpstream(... FORWARD_SHARE_HEADERS)`. Keeping the decisions here is what makes
 * them testable without a live portal, a live web-ui and a live core.
 *
 * Four invariants this file exists to hold:
 *
 *  1. GET only. The passthrough sits ABOVE the session gate, and the same-origin CSRF check
 *     sits BELOW it (index.ts:1030). A non-GET branch here would be a state-changing request
 *     with no CSRF check at all. `matchSharePassthrough` returns null for every other method,
 *     including HEAD — a HEAD would be safe but nothing needs it.
 *
 *  2. Anchored patterns, never a `startsWith` prefix. `/api/public/shares/...` is one typo
 *     away from `/api/...`, i.e. from handing the whole authenticated web-ui API to anonymous
 *     callers. Every pattern below is `^...$` over the already-normalized `url.pathname`, and
 *     runs BELOW the illegal-path guard (index.ts:934-937) that rejects `%2f`, `%5c`, `%2e%2e`,
 *     backslash, NUL, `//` and `/..`.
 *
 *  3. The share namespace is closed to the capability passthrough. `hasAgentCapability`
 *     (index.ts:712-714) only checks that `x-agent-capability` is a non-empty string — it never
 *     validates it — and core's gate short-circuits capability verification for public routes.
 *     Without `isPublicShareCorePath`, `curl -H 'x-agent-capability: x' /v1/shares/<id>` reaches
 *     the public core route directly and skips the rate limit, the GET-only guard and the
 *     header allowlist below.
 *
 *  4. This passthrough is the ANONYMOUS path and only the anonymous path. `anonymousShareRequest`
 *     refuses to match when the visitor already has a portal session, so a signed-in reader falls
 *     through to the ordinary `proxyToSurface` at the bottom of `handle()` — which is what mints
 *     `x-portal-identity` for them. That fall-through is the ONLY reason core can answer
 *     "member" or "outsider" on a share URL: `FORWARD_SHARE_HEADERS` deliberately carries no
 *     credential, so if this branch also served signed-in visitors every reader in production
 *     would be anonymous and two of the three access states would be unreachable.
 *
 *  5. The share page needs its bundle. `matchShareAsset` opens `/assets/<file>` (and, in
 *     development only, vite's `/src`, `/@vite`, `/@id`, `/@fs`, `/node_modules/.vite`) to the
 *     same anonymous branch. Without it the shell is relayed, the browser asks for
 *     `/assets/index-<hash>.js` with a wildcard Accept, the session gate answers
 *     `401 {"error":"sign in"}` — because `wantsHtml(req)` is false for a script — and the
 *     audience the feature exists for gets a white page.
 */

/** A share id is `${randomUUID()}${randomUUID().replace(/-/g, "")}` — 68 chars of [0-9a-f-]. */
const SHARE_ID = "[A-Za-z0-9-]{32,80}";

/** Byte-identical to SHARE_ID/ARTIFACT_ID in plugins/web-ui/server/share-routes.ts, deliberately:
 *  a pattern the portal accepts and web-ui rejects turns a clean 404 into a confusing 401. */
const ARTIFACT_ID = "[A-Za-z0-9_.:-]{1,200}";

const SHARE_HTML_RE = new RegExp(`^/share/(${SHARE_ID})$`);
const SHARE_JSON_RE = new RegExp(`^/api/public/shares/(${SHARE_ID})$`);
const SHARE_FILE_RE = new RegExp(`^/api/public/shares/(${SHARE_ID})/files/(${ARTIFACT_ID})$`);

/**
 * The SPA's own bundle, which the share page HTML immediately asks for.
 *
 * Without this the feature is a white page: `/share/<id>` relays fine, the browser parses the
 * shell, requests `/assets/index-<hash>.js` with a wildcard Accept — which matches no share pattern,
 * falls to the session gate, and takes the `return json(res, 401, { error: "sign in" })` branch
 * because `wantsHtml(req)` is false for a script. The HTML arrives and nothing runs.
 *
 * Vite emits a flat `assets/` directory (`assets/[name]-[hash][extname]`), including the lazy
 * chunks and the KaTeX fonts the CSS pulls in, so one anchored pattern covers the whole build.
 * Nested paths are deliberately not matched: `[^/]` keeps this one directory deep.
 *
 * What this publishes is the compiled client bundle — the same bytes any signed-in visitor
 * already downloads. It carries no session, no share data and no secret; the trade is that the
 * app's client-side code is world-readable, which is the price of a page strangers can open.
 */
const SHARE_ASSET_RE = /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The dev-server equivalents. `npm run dev` serves the same shell from vite, which references
 * `/src/main.ts` and `/@vite/client` instead of a built bundle, so without these the share page
 * is unopenable in local development and nobody notices the prod path is broken either.
 *
 * Gated by the caller on `!IS_PROD` (index.ts) — `/@fs/` in particular lets vite read anything
 * under its `fs.allow` root, which is the whole plugins tree, and must never be anonymous in
 * production.
 */
const SHARE_DEV_ASSET_RES: readonly RegExp[] = [
  /^\/src\/[A-Za-z0-9._/-]{1,200}$/,
  /^\/@vite\/[A-Za-z0-9._/-]{1,200}$/,
  /^\/@id\/[A-Za-z0-9._/@:-]{1,300}$/,
  /^\/@fs\/[A-Za-z0-9._/@:-]{1,400}$/,
  /^\/node_modules\/\.vite\/[A-Za-z0-9._/@-]{1,300}$/,
];

/** Not exported: knip flags an exported type nothing imports, and `match.kind` narrows fine. */
type SharePassthroughKind = "html" | "json" | "file" | "asset";

export interface SharePassthroughMatch {
  kind: SharePassthroughKind;
  /** The opaque share id. Never a session id, never a threadRef, never a principal.
   *  Empty on `kind: "asset"`: a bundle request carries no share id at all. */
  shareId: string;
  /** Present only on `kind: "file"`. */
  artifactId?: string;
  /** Upstream surface key in UPSTREAMS. Share traffic never goes straight to core. */
  upstream: "web-ui";
  /** Forwarded verbatim; web-ui serves these exact paths. */
  path: string;
  /** Rate-limit bucket. Page views, file downloads and bundle fetches are separate so a burst
   *  of downloads cannot starve readers out of the transcript itself, and so the ten-odd
   *  subresource requests of a single page load cannot spend the reader's poll budget. */
  rateLimitKind: "share-page" | "share-file" | "share-asset";
}

/** True for a path that must be handled by the share passthrough and by nothing else. */
export function matchSharePassthrough(method: string, pathname: string): SharePassthroughMatch | null {
  if (method !== "GET") return null;

  const html = SHARE_HTML_RE.exec(pathname);
  if (html?.[1]) {
    return { kind: "html", shareId: html[1], upstream: "web-ui", path: pathname, rateLimitKind: "share-page" };
  }

  const json = SHARE_JSON_RE.exec(pathname);
  if (json?.[1]) {
    return { kind: "json", shareId: json[1], upstream: "web-ui", path: pathname, rateLimitKind: "share-page" };
  }

  const file = SHARE_FILE_RE.exec(pathname);
  if (file?.[1] && file[2] && !file[2].includes("..")) {
    return {
      kind: "file",
      shareId: file[1],
      artifactId: file[2],
      upstream: "web-ui",
      path: pathname,
      rateLimitKind: "share-file",
    };
  }

  return null;
}

/**
 * The SPA bundle the share page HTML needs in order to be more than a white rectangle.
 *
 * Separate from `matchSharePassthrough` on purpose: these paths carry no share id, so they are
 * not "a share request" in any meaningful sense — they are the price of serving one. Keeping
 * them in their own function keeps the share matcher honest about what a share path looks like.
 */
export function matchShareAsset(
  method: string,
  pathname: string,
  opts: { devAssets: boolean },
): SharePassthroughMatch | null {
  if (method !== "GET") return null;
  // Belt and braces: the illegal-path guard upstream already rejects `/..`, but the dev
  // charsets admit a dot pair and these paths are the ones that reach a filesystem.
  if (pathname.includes("..")) return null;

  const matched =
    SHARE_ASSET_RE.test(pathname) || (opts.devAssets && SHARE_DEV_ASSET_RES.some((re) => re.test(pathname)));
  if (!matched) return null;

  return { kind: "asset", shareId: "", upstream: "web-ui", path: pathname, rateLimitKind: "share-asset" };
}

/**
 * The whole branch predicate, in one place so it is testable rather than implied by the shape
 * of an `if` in a 1300-line request handler.
 *
 * `hasSession` is the load-bearing half. A signed-in visitor must NOT take this branch: it
 * forwards no credential at all, so serving them here would make every reader anonymous and
 * would leave the member and outsider states unreachable in production. Returning null sends
 * them down the ordinary surface proxy instead, which mints `x-portal-identity` from their
 * portal session (proxy.ts:95-106) — web-ui forwards that header to core on the public share
 * relays, and core alone decides what the identity is allowed to see.
 */
export function anonymousShareRequest(
  enabled: boolean,
  hasSession: boolean,
  method: string,
  pathname: string,
  opts: { devAssets?: boolean } = {},
): SharePassthroughMatch | null {
  if (!enabled || hasSession) return null;
  return (
    matchSharePassthrough(method, pathname) ?? matchShareAsset(method, pathname, { devAssets: opts.devAssets === true })
  );
}

/**
 * The core-side public share namespace, which the portal must NOT expose directly.
 *
 * The capability passthrough at index.ts:999-1001 forwards anything under `/v1/` to core when
 * `x-agent-capability` merely exists. Core treats the share routes as `public`, so it never
 * checks that header either. Excluding this namespace makes the branch fall through to the
 * `/v1/` 404 at index.ts:1002 — the public surface is `/api/public/shares/...` through web-ui,
 * where the rate limit lives, and nothing else.
 */
export function isPublicShareCorePath(pathname: string): boolean {
  return pathname === "/v1/shares" || pathname.startsWith("/v1/shares/");
}

/**
 * Request headers forwarded upstream on a share request. `proxyToUpstream` builds the header
 * set from scratch, so this list is exhaustive: no cookie, no authorization, no
 * x-agent-capability, no x-portal-identity. An anonymous reader stays anonymous end to end.
 */
export const FORWARD_SHARE_HEADERS: readonly string[] = ["accept", "accept-language", "user-agent"];

/**
 * Response headers the portal sets before relaying. `relay()` copies the upstream headers into
 * `writeHead`, and writeHead wins over setHeader on a collision, so these are a floor rather
 * than an override: if web-ui/core send their own `cache-control`/`vary`, theirs stand.
 *
 * `no-store` is load-bearing. There is no expiry on a share — "revoke takes effect on the next
 * request" is the whole containment story, and a shared cache holding a 200 means there is no
 * next request. `vary` is there because the same URL yields anonymous, member and outsider
 * bodies depending on the identity the portal does or does not mint.
 */
export const SHARE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, no-cache, must-revalidate, private",
  vary: "cookie, x-portal-identity",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

export interface ShareRateLimitConfig {
  /** Requests per window per client for the share page and its JSON polls. */
  pageLimit: number;
  /** Requests per window per client for attachment downloads. */
  fileLimit: number;
  /** Requests per window per client for the SPA bundle. One cold page load is ~10 of these,
   *  and every one of them is served from disk with a year-long immutable cache, so this bucket
   *  is deliberately the most generous of the three. */
  assetLimit: number;
  windowS: number;
}

/**
 * The per-IP limit has to live here, not in core: core never sees a client IP on this path.
 * `x-qm-client-ip` is injected at exactly one place (index.ts:881, the auth-broker passthrough)
 * and read at exactly one place (plugins/auth/src/server.ts), and `proxyToUpstream` builds
 * headers from scratch — so on a share request core would bucket every visitor on `undefined`.
 *
 * Ceiling of 64: `withinRateLimit` asks core to claim one of `limit` slots in a single request,
 * and core grants at most 64 claim slots per request (same bound the playground mint is
 * validated against at index.ts:1191-1195).
 */
export const SHARE_RATE_LIMIT_MAX = 64;

export const DEFAULT_SHARE_RATE_LIMIT: ShareRateLimitConfig = {
  pageLimit: 60,
  fileLimit: 30,
  assetLimit: 64,
  windowS: 60,
};

/**
 * Whether the client key the limit buckets on is one the portal can actually trust.
 *
 * `clientIpOf` (index.ts:174-187) returns `req.socket.remoteAddress` unless `FLY_APP_NAME` is
 * set or `PORTAL_XFF_TRUSTED_HOPS > 0`, and the default is 0. Behind a reverse proxy —
 * Traefik/Dokploy, which is how this actually deploys — that address is the proxy for every
 * visitor on earth, so a per-IP bucket keyed on it would be one global bucket: with the share
 * page polling every 10s, about ten concurrent readers before honest visitors start getting
 * 429s, on a feature whose whole point is being readable by many strangers at once.
 *
 * An earlier revision answered that by switching the limit OFF in exactly that topology, which
 * meant it was off on the only deployment that exists — an unauthenticated read-and-download
 * surface with no edge bound, announced by a console.warn nobody reads. So the limit is now
 * always applied; what this predicate decides is only whether the key is TRUSTED (`clientIpOf`)
 * or BEST EFFORT (`bestEffortClientIp`, spoofable by a client that sends its own
 * X-Forwarded-For). A best-effort key still gives every honest reader their own bucket and
 * still stops the naive flood; it does not stop a determined attacker, which is why production
 * refuses to boot on one unless the operator says so out loud.
 */
export function shareRateLimitUsable(opts: { onFly: boolean; xffTrustedHops: number }): boolean {
  return opts.onFly || opts.xffTrustedHops > 0;
}

/**
 * The bucket key when `shareRateLimitUsable` is false.
 *
 * Traefik APPENDS the peer address to X-Forwarded-For, so on the real deployment the rightmost
 * hop is the visitor — the same value `PORTAL_XFF_TRUSTED_HOPS=1` would select, minus the
 * assurance that a hop was actually added. With no proxy in front, a client can send the header
 * itself and rotate it to buy fresh buckets; that is the honest limit of this fallback, and the
 * reason `shareRateLimitTopologyProblem` makes an operator opt into it in production.
 *
 * Falls back to the socket address, which in local development IS the client.
 */
export function bestEffortClientIp(socketIp: string | undefined, forwardedFor: string | string[] | undefined): string {
  const chain = Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "");
  const hops = chain
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? socketIp ?? "unknown";
}

/** The startup warning that goes with `shareRateLimitUsable` returning false. */
export const SHARE_RATE_LIMIT_UNKEYED_WARNING =
  "[portal] public share links: the per-client rate limit is keyed on a BEST-EFFORT client address (the last X-Forwarded-For hop, or the socket) because PORTAL_XFF_TRUSTED_HOPS is unset — a client that forges the header can buy fresh buckets; set PORTAL_XFF_TRUSTED_HOPS to the number of trusted proxies in front of the portal";

/** The environment variable that accepts the best-effort key in production, eyes open. */
export const SHARE_BEST_EFFORT_ENV = "PORTAL_SHARE_RATE_LIMIT_BEST_EFFORT";

/**
 * The startup requirement the previous revision left as a log line.
 *
 * Production only, and deliberately: with no reverse proxy the socket address IS the client, so
 * a local or single-hop deployment is correctly keyed even with `shareRateLimitUsable` false —
 * it is the untrusted-proxy case that needs a decision, and only a production operator can make
 * it. Two ways out: configure the trusted hop count, or set the opt-in and accept a spoofable
 * key.
 */
export function shareRateLimitTopologyProblem(opts: {
  isProd: boolean;
  keyed: boolean;
  bestEffortAccepted: boolean;
}): string | null {
  if (!opts.isProd || opts.keyed || opts.bestEffortAccepted) return null;
  return `public share links are on and PORTAL_XFF_TRUSTED_HOPS is unset — behind a reverse proxy the anonymous share surface would be rate limited on a spoofable client address. Set PORTAL_XFF_TRUSTED_HOPS to the number of trusted proxies (1 for Traefik/Dokploy), or set ${SHARE_BEST_EFFORT_ENV}=1 to accept a best-effort key, or PORTAL_PUBLIC_SHARE_LINKS=0 to close the surface`;
}

/** Off unless explicitly switched on: an accepted-risk flag must never be the default. */
export function shareBestEffortAccepted(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function intEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : NaN;
}

export function shareRateLimitConfig(env: Record<string, string | undefined>): ShareRateLimitConfig {
  return {
    pageLimit: intEnv(env.PORTAL_SHARE_VIEWS_PER_IP, DEFAULT_SHARE_RATE_LIMIT.pageLimit),
    fileLimit: intEnv(env.PORTAL_SHARE_FILES_PER_IP, DEFAULT_SHARE_RATE_LIMIT.fileLimit),
    assetLimit: intEnv(env.PORTAL_SHARE_ASSETS_PER_IP, DEFAULT_SHARE_RATE_LIMIT.assetLimit),
    windowS: intEnv(env.PORTAL_SHARE_RATE_WINDOW_S, DEFAULT_SHARE_RATE_LIMIT.windowS),
  };
}

/** Startup validation, in the shape the portal's existing config check collects. */
export function shareRateLimitProblems(cfg: ShareRateLimitConfig): string[] {
  const problems: string[] = [];
  const bounded = (name: string, value: number): void => {
    if (!Number.isInteger(value) || value < 1 || value > SHARE_RATE_LIMIT_MAX) {
      problems.push(
        `${name} must be an integer between 1 and ${SHARE_RATE_LIMIT_MAX} (core grants at most ${SHARE_RATE_LIMIT_MAX} claim slots per request)`,
      );
    }
  };
  bounded("PORTAL_SHARE_VIEWS_PER_IP", cfg.pageLimit);
  bounded("PORTAL_SHARE_FILES_PER_IP", cfg.fileLimit);
  bounded("PORTAL_SHARE_ASSETS_PER_IP", cfg.assetLimit);
  if (!Number.isInteger(cfg.windowS) || cfg.windowS < 10 || cfg.windowS > 3600) {
    problems.push("PORTAL_SHARE_RATE_WINDOW_S must be an integer between 10 and 3600");
  }
  return problems;
}

export interface ShareRateLimitArgs {
  secret: string;
  kind: string;
  value: string;
  limit: number;
  windowS: number;
  nowMs: number;
}

/**
 * Build the `withinRateLimit` arguments for a matched share request, following the playground
 * mint precedent verbatim (index.ts:790-798). `ipBucket` is `mintBucketOf(...)` of the client
 * address, so an IPv6 client cannot walk its own /64 to buy a fresh bucket per request.
 */
export function shareRateLimitArgs(
  match: SharePassthroughMatch,
  ipBucket: string,
  cfg: ShareRateLimitConfig,
  secret: string,
  nowMs: number,
): ShareRateLimitArgs {
  const limits: Record<SharePassthroughMatch["rateLimitKind"], number> = {
    "share-page": cfg.pageLimit,
    "share-file": cfg.fileLimit,
    "share-asset": cfg.assetLimit,
  };
  return {
    secret,
    kind: match.rateLimitKind,
    value: ipBucket,
    limit: limits[match.rateLimitKind],
    windowS: cfg.windowS,
    nowMs,
  };
}

/**
 * Off only when explicitly switched off. Core owns the real feature flag, `PUBLIC_SHARE_LINKS`,
 * which also defaults ON; with the passthrough on and core's flag off, an anonymous GET relays
 * to web-ui and gets core's 404 — the same answer a stranger gets for a revoked link. Defaulting
 * this one off instead would turn "core enabled, portal not redeployed" into a login bounce
 * that looks like an auth bug rather than a disabled feature.
 */
export function sharePassthroughEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}
