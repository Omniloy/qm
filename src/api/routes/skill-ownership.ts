import { sendJson } from "../http.ts";
import { livePersonCapability } from "../artifact-share.ts";
import { OUTCOME_STATUS } from "../app-skill-ownership.ts";
import { parseScopeId, type ScopeId } from "../../types.ts";
import { type ApiCtx, type Route } from "./route.ts";

export async function skillActor(ctx: ApiCtx): Promise<{ id: string; live: boolean } | null> {
  const b = (ctx.body ?? {}) as { principalId?: unknown };
  if (ctx.capability) return { id: ctx.capability.actorId, live: livePersonCapability(ctx.capability) };
  const fromQuery = ctx.url?.searchParams.get("principalId");
  const id = typeof b.principalId === "string" && b.principalId ? b.principalId : (fromQuery ?? "");
  return id ? { id, live: true } : null;
}

export function ownerTransferInput(body: unknown): { ownerId: string; homeScope?: ScopeId } | null {
  const b = (body ?? {}) as { ownerId?: unknown; homeScope?: unknown };
  if (typeof b.ownerId !== "string" || !b.ownerId.trim()) return null;
  if (b.homeScope !== undefined && (typeof b.homeScope !== "string" || parseScopeId(b.homeScope).kind === null)) {
    return null;
  }
  return { ownerId: b.ownerId.trim(), ...(typeof b.homeScope === "string" ? { homeScope: b.homeScope } : {}) };
}

async function transferSkillOwner(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const actor = await skillActor(ctx);
  if (!actor) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  const input = ownerTransferInput(ctx.body);
  if (!input) {
    return sendJson(res, 400, { error: "bad_request", message: "ownerId required; homeScope must be a scope id" });
  }
  const result = await app.transferSkillOwner({
    id: ctx.params.id!,
    newOwnerId: input.ownerId,
    ...(input.homeScope ? { homeScope: input.homeScope } : {}),
    actorId: actor.id,
    liveActor: actor.live,
  });
  if (!result.ok) {
    return sendJson(res, OUTCOME_STATUS[result.code], {
      error: result.code,
      message: result.message,
      ...(result.conflict ? { conflict: result.conflict } : {}),
    });
  }
  return sendJson(res, 200, {
    skill: { id: result.skill.id, ownerId: result.skill.ownerId, scopeId: result.skill.scopeId },
  });
}

export const skillOwnershipRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/skills/:id/owner", auth: "either", handle: transferSkillOwner },
];
