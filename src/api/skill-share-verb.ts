import { parseScopeId, type Permission, type ScopeId } from "../types.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import { livePersonCapability, type ShareArtifactRequest, type ShareArtifactResult } from "./artifact-share.ts";
import type { SkillOwnershipCode } from "./app-skill-ownership.ts";
import type { App } from "./app-types.ts";

const SHARE_CODE: Partial<Record<SkillOwnershipCode, "not_found" | "forbidden" | "bad_request" | "name_conflict">> = {
  not_found: "not_found",
  forbidden: "forbidden",
  trigger_blocked: "forbidden",
  name_conflict: "name_conflict",
  bad_request: "bad_request",
  superseded: "bad_request",
};

function shareVerb(org: boolean, move: boolean): "promote" | "move" | "share" {
  if (org) return "promote";
  return move ? "move" : "share";
}

function runSkillShare(
  app: App,
  verb: "promote" | "move" | "share",
  input: { id: string; toScope: ScopeId; actorId: string; permission: Permission; liveActor: boolean },
  capability: CapabilityClaims,
) {
  if (verb === "promote") {
    return app.setSkillOrgWide({
      id: input.id,
      on: true,
      actorId: input.actorId,
      liveActor: capability.liveActor === true,
      portalSession: capability.portalSession === true,
    });
  }
  if (verb === "move") return app.moveSkillHome(input);
  return app.shareSkill(input);
}

export async function shareSkillArtifact(
  app: App,
  req: ShareArtifactRequest,
  target: { scope: ScopeId; label: string },
  capability: CapabilityClaims,
  permission: Permission,
): Promise<ShareArtifactResult> {
  const actorId = capability.actorId;
  const org = parseScopeId(target.scope).kind === "org";
  const liveActor = livePersonCapability(capability);
  const verb = shareVerb(org, req.move === true);
  const result = await runSkillShare(
    app,
    verb,
    { id: req.id, toScope: target.scope, actorId, permission, liveActor },
    capability,
  );
  if (!result.ok) {
    return {
      ok: false,
      code: SHARE_CODE[result.code] ?? "share_failed",
      message: result.message,
      ...(result.conflict ? { conflict: result.conflict } : {}),
    };
  }
  return {
    ok: true,
    verb,
    type: "skill",
    id: req.id,
    target,
    permission: org ? "read" : permission,
  };
}
