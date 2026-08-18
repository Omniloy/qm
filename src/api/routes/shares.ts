import type { ServerResponse } from "node:http";
import { contentDispositionAttachment, pipeToResponse } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { isObj } from "./shared.ts";
import type { ShareMethods } from "../app-shares.ts";

/**
 * Routes for publicly shareable read-only conversation links.
 *
 * Two public routes and three management routes, and the split between them is
 * the whole security story:
 *
 *   - The public routes are `auth: "public"` and live in `apiRoutes`, NOT in
 *     `rawRoutes`. Raw routes are dispatched before `gate()` (server.ts), and
 *     `gate()` is what parses `x-portal-identity` into `ctx.actor` even on a
 *     public route — the `isPublicRoute` guard suppresses the *requirement*, not
 *     the parse. A raw route would silently lose the actor, and with it core's
 *     ability to tell anonymous from member from outsider. That distinction is
 *     the feature.
 *   - The management routes are `auth: "source"` and each carries a USER_SCOPED
 *     rule naming `principalId`, so in production the gate demands a signed
 *     portal identity whose subject equals the asserted actor and refuses
 *     capability tokens outright. An agent can never publish a conversation.
 *
 * Neither the web-ui server nor the portal decides anything here. They relay.
 */

/**
 * The share methods, which `createApp` mixes into `App`.
 *
 * Named through the interface rather than reached for off `ctx.app` directly so
 * this file states exactly which capability it needs, and so the route table can
 * be read and tested without the whole App surface in scope.
 */
const shares = (ctx: ApiCtx): ApiCtx["app"] & ShareMethods => ctx.app as ApiCtx["app"] & ShareMethods;

/** One body for every refusal on the public path. */
const NOT_FOUND = { error: "not_found" } as const;

/**
 * Headers every public response carries.
 *
 * `no-store` because revocation is the entire containment story — there is no
 * expiry, so "it stops working on the next request" is only true if no shared
 * cache is answering instead of us. `vary` because this exact URL returns a
 * different body to an anonymous reader and to a member (who additionally gets
 * the session id), and a cache that ignored that would hand one to the other.
 */
function publicHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "cache-control": "no-store",
    vary: "x-portal-identity",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive",
    ...extra,
  };
}

function sendPublicJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, publicHeaders({ "content-type": "application/json" }));
  res.end(data);
}

/**
 * Management responses, which are as sensitive as the public ones and for the
 * same reason: the share id IS the secret, and these bodies hand it back inside
 * a ready-to-paste URL. `sendJson` writes a bare content-type, which leaves the
 * response heuristically cacheable — and what a shared cache would be storing is
 * a live capability to read the conversation. Every response on these three
 * routes goes through here, including the refusals.
 */
function sendPrivateJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "x-portal-identity",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(data);
}

/**
 * A per-share request ceiling, in this process.
 *
 * Deliberately a counter rather than a replay-dedupe claim, and deliberately
 * keyed on the share id rather than on a client IP: core never receives a
 * trustworthy client IP on this path — the portal builds forwarded headers from
 * scratch — so an IP bucket here would key every request on `undefined`. Per-IP
 * throttling belongs in the portal, where the IP actually exists.
 */
const SHARE_RATE_WINDOW_MS = 60_000;
/**
 * Generous on purpose. A published conversation is meant to be read by many
 * people at once, and the page polls, so a ceiling tight enough to matter as an
 * abuse control would first be hit by the readers the link was minted for. This
 * is a runaway-client bound; per-IP throttling of strangers belongs in the
 * portal, which is the only tier that sees an IP.
 */
const SHARE_RATE_MAX = 600;
/**
 * Hard cap on distinct keys held.
 *
 * The counter is consulted before any lookup, so a forged id allocates a bucket
 * — which means an unauthenticated caller chooses how many keys exist. Bounded
 * with oldest-first eviction rather than an expired-only sweep: within a single
 * window nothing is expired yet, so a sweep that only drops expired entries
 * frees nothing while scanning everything, which is how the previous version
 * turned a flood of invented ids into quadratic CPU on core's event loop.
 * Eviction can only cost an honest share a reset window, never access.
 */
const SHARE_RATE_KEYS_MAX = 10_000;
const shareHits = new Map<string, { windowStartedAt: number; count: number }>();

/**
 * How many rate-limit keys are held right now.
 *
 * Exists so the bound above is a testable claim rather than a comment. The
 * previous version's unboundedness was invisible to every black-box assertion
 * you could write against the routes, which is exactly why it survived review.
 */
export function shareRateKeysHeld(): number {
  return shareHits.size;
}

function withinShareRate(key: string, now = Date.now()): boolean {
  const bucket = shareHits.get(key);
  if (bucket && now - bucket.windowStartedAt < SHARE_RATE_WINDOW_MS) {
    bucket.count += 1;
    return bucket.count <= SHARE_RATE_MAX;
  }
  // Map iteration is insertion-ordered, so this is O(1) per admission and the
  // key it drops is the least recently started window.
  while (shareHits.size >= SHARE_RATE_KEYS_MAX) {
    const oldest = shareHits.keys().next();
    if (oldest.done) break;
    shareHits.delete(oldest.value);
  }
  // Re-insert rather than mutate, so a renewed window moves to the back of the
  // eviction order instead of ageing out while it is still in use.
  shareHits.delete(key);
  shareHits.set(key, { windowStartedAt: now, count: 1 });
  return true;
}

/**
 * Who is asking, as far as core is concerned.
 *
 * `ctx.capability` is ignored on purpose and is always null here anyway: the
 * gate short-circuits capability verification for a public route, so an agent
 * presenting a capability token gets exactly the anonymous experience. There is
 * no path by which a handler can "upgrade" a token holder.
 */
function viewerOf(ctx: ApiCtx): string | null {
  return ctx.actor?.p ?? null;
}

/**
 * The poll cursor, or null for a cold load.
 *
 * Anything that is not a non-negative integer is treated as absent rather than
 * refused: the cursor only trims the response, so a malformed one costs a full
 * transcript, never a wrong authorization decision.
 */
function sinceIndexOf(ctx: ApiCtx): number | null {
  const raw = ctx.url.searchParams.get("sinceIndex");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function getSharedTranscript(ctx: ApiCtx): Promise<void> {
  const { res } = ctx;
  const shareId = ctx.params.shareId ?? "";
  if (!shareId || !withinShareRate(`t:${shareId}`)) {
    return sendPublicJson(res, shareId ? 429 : 404, shareId ? { error: "rate_limited" } : NOT_FOUND);
  }
  const sinceIndex = sinceIndexOf(ctx);
  const shared = await shares(ctx).resolveSharedTranscript(shareId, viewerOf(ctx), {
    // A cursor means a poll from a page that is already open, so it is not a
    // new view. Counting them made the number the sharer decides on with
    // ("Opened 8,640 times") a measure of how long one tab was left open, and
    // charged a durable-map read-modify-write per viewer per ten seconds.
    countView: sinceIndex === null,
    ...(sinceIndex !== null ? { sinceIndex } : {}),
  });
  // Revoked, forged, never-existed, sharer deactivated, session deleted: one
  // answer, byte for byte, so the endpoint confirms nothing.
  if (!shared) return sendPublicJson(res, 404, NOT_FOUND);
  return sendPublicJson(res, 200, shared);
}

async function getSharedFile(ctx: ApiCtx): Promise<void> {
  const { res } = ctx;
  const shareId = ctx.params.shareId ?? "";
  const artifactId = ctx.params.artifactId ?? "";
  // A separate bucket from the transcript's: a page with twenty attachments
  // spends twenty requests on one load, and that must not be able to 429 the
  // messages for every other reader of the same link.
  if (!shareId || !artifactId || !withinShareRate(`f:${shareId}`)) {
    return sendPublicJson(
      res,
      shareId && artifactId ? 429 : 404,
      shareId && artifactId ? { error: "rate_limited" } : NOT_FOUND,
    );
  }
  const opened = await shares(ctx).resolveSharedFile(shareId, artifactId, viewerOf(ctx));
  if (!opened) return sendPublicJson(res, 404, NOT_FOUND);
  res.writeHead(
    200,
    publicHeaders({
      // Never the stored mimetype. An attachment named `x.js` would otherwise be
      // served as `text/javascript` from the app's own origin, which the SPA's
      // `script-src 'self'` would execute — a shared conversation would become a
      // way to run code in a signed-in reader's browser. With `nosniff` set, a
      // non-script type makes `<script src>` fail outright.
      "content-type": "application/octet-stream",
      "content-length": String(opened.sizeBytes),
      "content-disposition": contentDispositionAttachment(opened.name),
      // Belt and braces for the same attack through a top-level navigation.
      "content-security-policy": "sandbox; default-src 'none'",
    }),
  );
  pipeToResponse(res, opened.stream, "shared file read failed");
  return;
}

/**
 * The asserted actor for a management call.
 *
 * The gate already enforces `principalId === actor.p` for these routes through
 * their USER_SCOPED rules. This repeats the check because a GET that loses its
 * rule — a typo in the pattern, or a rule nobody adds — is not caught by the
 * unclassified-write backstop, which only inspects writes. That failure mode is
 * silent and it fails open, so the handler refuses to trust a bare query
 * parameter wherever signed identity is required at all.
 */
type ActorCheck = { ok: true; principalId: string } | { ok: false; status: 401 | 403; message: string };

function managementActor(ctx: ApiCtx, asserted: string): ActorCheck {
  const { deps, actor } = ctx;
  // A capability token is 403'd on a source route before a handler ever runs;
  // this makes the intent local anyway, so an agent cannot publish a
  // conversation even if the route's auth mode is ever loosened.
  if (ctx.capability) return { ok: false, status: 403, message: "capability token not valid for this route" };
  if (!asserted) return { ok: false, status: 401, message: "principalId is required" };
  const identityRequired = Boolean(deps.requireSignedPortalIdentity || deps.production);
  if (identityRequired && !actor) return { ok: false, status: 401, message: "portal identity required" };
  if (actor && actor.p !== asserted) {
    return { ok: false, status: 403, message: "portal identity does not match the requested actor" };
  }
  return { ok: true, principalId: asserted };
}

function refuse(ctx: ApiCtx, check: Extract<ActorCheck, { ok: false }>): void {
  return sendPrivateJson(ctx.res, check.status, {
    error: check.status === 401 ? "unauthorized" : "forbidden",
    message: check.message,
  });
}

function shareUrl(ctx: ApiCtx, shareId: string): string | undefined {
  const base = (ctx.deps.portalUrl ?? ctx.deps.publicUrl)?.replace(/\/$/, "");
  return base ? `${base}/share/${shareId}` : undefined;
}

async function createShare(ctx: ApiCtx): Promise<void> {
  const { res } = ctx;
  const sessionId = ctx.params.id!;
  const body = isObj(ctx.body) ? ctx.body : {};
  const asserted = typeof body.principalId === "string" ? body.principalId.trim() : "";
  const check = managementActor(ctx, asserted);
  if (!check.ok) return refuse(ctx, check);
  const principalId = check.principalId;

  // Rotating is revoke-then-mint, so the old URL is dead the instant the new one
  // exists rather than both being live.
  if (body.rotate === true) await shares(ctx).revokeSessionShare(sessionId, principalId);

  const minted = await shares(ctx).createSessionShare(sessionId, principalId);
  if (!minted.ok) {
    if (minted.reason === "not_configured") {
      return sendPrivateJson(res, 503, { error: "not_configured", message: "shared links are not enabled here" });
    }
    if (minted.reason === "forbidden") {
      return sendPrivateJson(res, 403, {
        error: "forbidden",
        message: "you are no longer a member of this project, so you cannot share its conversations",
      });
    }
    return sendPrivateJson(res, 404, { error: "not_found" });
  }
  const url = shareUrl(ctx, minted.shareId);
  return sendPrivateJson(res, 200, { shareId: minted.shareId, createdAt: minted.createdAt, ...(url ? { url } : {}) });
}

async function listShares(ctx: ApiCtx): Promise<void> {
  const { res, url } = ctx;
  const sessionId = ctx.params.id!;
  const check = managementActor(ctx, url.searchParams.get("principalId")?.trim() ?? "");
  if (!check.ok) return refuse(ctx, check);
  const links = await shares(ctx).listSessionShares(sessionId, check.principalId);
  if (!links) return sendPrivateJson(res, 404, { error: "not_found" });
  return sendPrivateJson(res, 200, {
    shares: links.map((s) => {
      const link = shareUrl(ctx, s.shareId);
      return { ...s, ...(link ? { url: link } : {}) };
    }),
  });
}

async function revokeShare(ctx: ApiCtx): Promise<void> {
  const { res, url } = ctx;
  const sessionId = ctx.params.id!;
  const check = managementActor(ctx, url.searchParams.get("principalId")?.trim() ?? "");
  if (!check.ok) return refuse(ctx, check);
  const only = url.searchParams.get("shareId")?.trim();
  const turnedOff = await shares(ctx).revokeSessionShare(sessionId, check.principalId, only || undefined);
  if (turnedOff === null) return sendPrivateJson(res, 404, { error: "not_found" });
  return sendPrivateJson(res, 200, { turnedOff });
}

export const shareRoutes: ReadonlyArray<Route<ApiCtx>> = [
  // Public. Anyone with the link, no account, no headers.
  { method: "GET", path: "/v1/shares/:shareId", auth: "public", handle: getSharedTranscript },
  { method: "GET", path: "/v1/shares/:shareId/files/:artifactId", auth: "public", handle: getSharedFile },
  // Management. Source auth plus a signed portal identity that must match.
  { method: "POST", path: "/v1/sessions/:id/share", auth: "source", handle: createShare },
  { method: "GET", path: "/v1/sessions/:id/share", auth: "source", handle: listShares },
  { method: "DELETE", path: "/v1/sessions/:id/share", auth: "source", handle: revokeShare },
];
