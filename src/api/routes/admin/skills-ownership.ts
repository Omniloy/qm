import { parseScopeId, type ScopeId } from "../../../types.ts";
import { sendJson } from "../../http.ts";
import { OUTCOME_STATUS, type SkillFailure } from "../../app-skill-ownership.ts";
import { requireScopedAdmin } from "../shared.ts";
import { type ApiCtx, type Route } from "../route.ts";
import { ownerTransferInput } from "../skill-ownership.ts";
import { requireScopedResource } from "./common.ts";

async function requireOrgAdmin(ctx: ApiCtx) {
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return null;
  if (parseScopeId(authz.scope).kind !== "org") {
    sendJson(ctx.res, 403, { error: "forbidden", message: "this needs the org scope" });
    return null;
  }
  return authz;
}

function sendFailure(ctx: ApiCtx, failure: SkillFailure): void {
  const { ok: _ok, code, ...rest } = failure;
  sendJson(ctx.res, OUTCOME_STATUS[code], { error: code, ...rest });
}

const bodyOf = (ctx: ApiCtx) =>
  (typeof ctx.body === "object" && ctx.body !== null ? ctx.body : {}) as Record<string, unknown>;

async function duplicates(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrgAdmin(ctx);
  if (!authz) return;
  return sendJson(ctx.res, 200, { scopeId: authz.scope, ...(await ctx.app.skillDuplicateReport()) });
}

async function merge(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrgAdmin(ctx);
  if (!authz) return;
  const b = bodyOf(ctx);
  if (typeof b.into !== "string" || !b.into)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "into required" });
  const result = await ctx.app.mergeSkill({
    fromId: ctx.params.id!,
    intoId: b.into,
    actorId: authz.actor.id,
    force: b.force === true,
  });
  if (!result.ok) return sendFailure(ctx, result);
  const { ok, retired, into, regranted, orgWide } = result;
  return sendJson(ctx.res, 200, { ok, retired, into, regranted, orgWide });
}

async function purge(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrgAdmin(ctx);
  if (!authz) return;
  const result = await ctx.app.purgeArchivedSkill({ id: ctx.params.id!, actorId: authz.actor.id });
  if (!result.ok) return sendFailure(ctx, result);
  return sendJson(ctx.res, 200, { ok: true });
}

async function backfill(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrgAdmin(ctx);
  if (!authz) return;
  const dryRun = bodyOf(ctx).dryRun === true;
  return sendJson(ctx.res, 200, {
    dryRun,
    ...(await ctx.app.backfillSkillOwners({ dryRun, actorId: authz.actor.id })),
  });
}

function scopedSkill(ctx: ApiCtx) {
  return requireScopedResource(
    ctx,
    () => ctx.app.getSkill(ctx.params.id!),
    (s) => s.scopeId,
    "skill",
  );
}

async function transferOwner(ctx: ApiCtx): Promise<void> {
  const scoped = await scopedSkill(ctx);
  if (!scoped) return;
  const input = ownerTransferInput(ctx.body);
  if (!input) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "ownerId required; homeScope must be a scope id" });
  }
  const result = await ctx.app.transferSkillOwner({
    id: scoped.record.id,
    newOwnerId: input.ownerId,
    ...(input.homeScope ? { homeScope: input.homeScope } : {}),
    actorId: scoped.actor.id,
    liveActor: true,
    asAdmin: true,
  });
  if (!result.ok) return sendFailure(ctx, result);
  return sendJson(ctx.res, 200, {
    skill: { id: result.skill.id, ownerId: result.skill.ownerId, scopeId: result.skill.scopeId },
  });
}

async function move(ctx: ApiCtx): Promise<void> {
  const scoped = await scopedSkill(ctx);
  if (!scoped) return;
  const toScope = bodyOf(ctx).toScope;
  if (typeof toScope !== "string" || parseScopeId(toScope).kind === null) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "toScope must be a scope id" });
  }
  const result = await ctx.app.moveSkillHome({
    id: scoped.record.id,
    toScope: toScope as ScopeId,
    actorId: scoped.actor.id,
    liveActor: true,
    asAdmin: true,
  });
  if (!result.ok) return sendFailure(ctx, result);
  return sendJson(ctx.res, 200, { skill: { id: result.skill.id, scopeId: result.skill.scopeId } });
}

export const adminSkillOwnershipRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/admin/skills/duplicates", auth: "either", handle: duplicates },
  { method: "POST", path: "/v1/admin/skills/backfill-owners", auth: "either", handle: backfill },
  { method: "POST", path: "/v1/admin/skills/:id/merge", auth: "either", handle: merge },
  { method: "POST", path: "/v1/admin/skills/:id/purge", auth: "either", handle: purge },
  { method: "POST", path: "/v1/admin/skills/:id/owner", auth: "either", handle: transferOwner },
  { method: "POST", path: "/v1/admin/skills/:id/move", auth: "either", handle: move },
];
