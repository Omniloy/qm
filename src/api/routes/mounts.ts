import type { ApiCtx, Route } from "./route.ts";
import { sendJson } from "../http.ts";
import { audit } from "./shared.ts";
import { decideMountMutation, decideMountRead, parseAttachBody } from "../../mounts/attach-policy.ts";
import { MountNameInUseError } from "../../mounts/mount-store.ts";
import { DriveListError } from "../../mounts/drive-listing.ts";
import { errMessage } from "../../util/errors.ts";
import type { ScopeId } from "../../types.ts";

/**
 * Attaching, listing and detaching Drive folders.
 *
 * Every decision of consequence lives in ../../mounts/attach-policy.ts; this
 * file is the plumbing around it. Browsing goes through core with the caller's
 * own token so no Google credential ever reaches the browser.
 */

const callerOf = (ctx: ApiCtx): string | null => ctx.capability?.actorId ?? ctx.actor?.p ?? null;

function refuse(ctx: ApiCtx, d: { status: number; error: string; message: string }): void {
  return sendJson(ctx.res, d.status, { error: d.error, message: d.message });
}

async function listMounts(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const mounts = deps.driveMounts;
  if (!mounts) return sendJson(res, 503, { error: "unavailable", message: "Drive folders are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const scopeId = ctx.url.searchParams.get("scope") as ScopeId | null;
  if (!scopeId) return sendJson(res, 400, { error: "bad_request", message: "scope is required" });

  const decision = await decideMountRead({ principalId, scopeId, canUseContext: mounts.canUseContext });
  if (!decision.ok) return refuse(ctx, decision);

  return sendJson(res, 200, { mounts: await mounts.store.forScope(scopeId) });
}

async function attachMount(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const mounts = deps.driveMounts;
  if (!mounts) return sendJson(res, 503, { error: "unavailable", message: "Drive folders are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  // Shape first: a malformed body should not cost an authorization lookup.
  const parsed = parseAttachBody((ctx.body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return sendJson(res, 400, { error: "bad_request", message: parsed.message });

  const decision = await decideMountMutation({
    triggered: Boolean(ctx.capability?.triggered),
    principalId,
    scopeId: parsed.value.scopeId,
    canUseContext: mounts.canUseContext,
  });
  if (!decision.ok) return refuse(ctx, decision);

  try {
    const mount = await mounts.store.attach({ ...parsed.value, createdBy: principalId }, Date.now());
    // A re-attach can change the folder or the mode, so any cached listing of
    // this mount is now describing something else.
    mounts.cache.invalidateMount(mount.id);
    audit(deps, {
      principalId,
      action: "drive.mount.attached",
      resource: `${mount.name} (${mount.externalId})`,
      scopeLabel: mount.scopeId,
    });
    return sendJson(res, 200, { mount });
  } catch (e) {
    if (e instanceof MountNameInUseError) {
      return sendJson(res, 409, { error: "conflict", message: e.message });
    }
    return sendJson(res, 400, { error: "bad_request", message: errMessage(e) });
  }
}

async function detachMount(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const mounts = deps.driveMounts;
  if (!mounts) return sendJson(res, 503, { error: "unavailable", message: "Drive folders are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const mount = await mounts.store.get(params.id!);
  if (!mount) return sendJson(res, 404, { error: "not_found" });

  const decision = await decideMountMutation({
    triggered: Boolean(ctx.capability?.triggered),
    principalId,
    scopeId: mount.scopeId,
    canUseContext: mounts.canUseContext,
  });
  if (!decision.ok) return refuse(ctx, decision);

  await mounts.store.detach(mount.id);
  // Every viewer's copy, not just this caller's — the folder is gone for all.
  mounts.cache.invalidateMount(mount.id);
  audit(deps, {
    principalId,
    action: "drive.mount.detached",
    resource: `${mount.name} (${mount.externalId})`,
    scopeLabel: mount.scopeId,
  });
  return sendJson(res, 200, { ok: true });
}

async function refreshMount(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const mounts = deps.driveMounts;
  if (!mounts) return sendJson(res, 503, { error: "unavailable", message: "Drive folders are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const mount = await mounts.store.get(params.id!);
  if (!mount) return sendJson(res, 404, { error: "not_found" });

  const decision = await decideMountRead({
    principalId,
    scopeId: mount.scopeId,
    canUseContext: mounts.canUseContext,
  });
  if (!decision.ok) return refuse(ctx, decision);

  // Only this caller's view. Refreshing my own listing must not re-list on a
  // teammate's behalf, since a listing is made with whoever's token asked.
  mounts.cache.invalidate(principalId, mount.id);
  return sendJson(res, 200, { ok: true });
}

async function browseFolders(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const mounts = deps.driveMounts;
  if (!mounts) return sendJson(res, 503, { error: "unavailable", message: "Drive folders are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const token = await mounts.tokenFor(principalId);
  if (!token) return sendJson(res, 409, { error: "not_connected", message: "connect Google Workspace first" });

  try {
    // Only {id, name} leaves core: the browser never sees a Google credential,
    // and never more of the person's Drive than the picker needs to render.
    const folders = await mounts.browseFolders(token, ctx.url.searchParams.get("parent") ?? "root");
    return sendJson(res, 200, { folders: folders.map((f) => ({ id: f.id, name: f.name })) });
  } catch (e) {
    if (e instanceof DriveListError) {
      return sendJson(res, e.status === 401 ? 409 : e.status, { error: "drive_error", message: e.message });
    }
    return sendJson(res, 502, { error: "drive_unreachable", message: errMessage(e) });
  }
}

export const mountRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/mounts", auth: "either", handle: listMounts },
  { method: "GET", path: "/v1/mounts/browse", auth: "source", handle: browseFolders },
  { method: "POST", path: "/v1/mounts", auth: "either", handle: attachMount },
  { method: "POST", path: "/v1/mounts/:id/refresh", auth: "either", handle: refreshMount },
  { method: "DELETE", path: "/v1/mounts/:id", auth: "either", handle: detachMount },
];
