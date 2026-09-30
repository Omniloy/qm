import { isSharedScope, parseScopeId, scopeId, type Grant, type Permission, type ScopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import { encodeRef, skillRef } from "../acl/resource-ref.ts";
import type { AuditEvent } from "../audit/audit-log.ts";
import { principalDestination } from "../reach/reach.ts";
import { swallow } from "../util/errors.ts";
import { isSourceManagedSkill, type Skill } from "../skills/skill-store.ts";
import {
  adminReachesSkill,
  createSkillRights,
  effectiveSkillOwner,
  roleManages,
  roleMovesOrTransfers,
  type SkillRole,
} from "../skills/skill-rights.ts";
import {
  audienceNameClash,
  manifestDiff,
  ownerBackfillFor,
  personalHomeMismatch,
  planSkillDuplicates,
  skillGrantsOf,
  skillWriteGrants,
  type ManifestDiff,
} from "../skills/skill-namespace.ts";
import { SHARED_SKILL_TRIGGER_REFUSAL, SKILL_CONTEXTS_ADMIN_ONLY, UNATTESTED_TURN_CAUSE } from "./artifact-share.ts";
import { skillVisibilityContext, withSkillMutationLock } from "./app-skills.ts";
import { AdminError } from "../admin/admin-service.ts";
import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

interface SkillConflict {
  id: string;
  name: string;
  home: ScopeId;
  owner: string;
}

export type SkillOwnershipCode =
  | "not_found"
  | "forbidden"
  | "trigger_blocked"
  | "name_conflict"
  | "name_mismatch"
  | "bad_request"
  | "superseded"
  | "diverged";

export type SkillFailure = {
  ok: false;
  code: SkillOwnershipCode;
  message: string;
  conflict?: SkillConflict;
  supersededBy?: string;
  diff?: ManifestDiff;
};

export type SkillOutcome<T = Skill> = ({ ok: true } & T) | SkillFailure;

export interface SkillSharing {
  role: SkillRole | null;
  ownerId?: string;
  ownerName: string;
  orgWide: boolean;
  canManage: boolean;
  canMoveOrTransfer: boolean;
  sharedWith?: Array<{ scopeId: ScopeId; permission: Permission }>;
}

const fail = (code: SkillOwnershipCode, message: string, extra: Partial<SkillFailure> = {}): SkillFailure => ({
  ok: false,
  code,
  message,
  ...extra,
});

const BUILT_IN = "built-in";

interface MergeDetail {
  added: ScopeId[];
  fromStatus?: Skill["status"];
  fromGrants: Array<{ granteeScopeId: ScopeId; permission: Permission }>;
}

function mergeDetail(raw: string | undefined): MergeDetail {
  const d = (raw ? JSON.parse(raw) : {}) as Partial<MergeDetail>;
  return {
    added: d.added ?? [],
    fromGrants: d.fromGrants ?? [],
    ...(d.fromStatus ? { fromStatus: d.fromStatus } : {}),
  };
}

export const OUTCOME_STATUS: Record<SkillOwnershipCode, number> = {
  not_found: 404,
  forbidden: 403,
  trigger_blocked: 403,
  name_conflict: 409,
  name_mismatch: 409,
  bad_request: 400,
  superseded: 409,
  diverged: 409,
};

export function createSkillOwnershipMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  | "canManageSkill"
  | "promoteSkill"
  | "demoteSkill"
  | "shareSkill"
  | "unshareSkill"
  | "setSkillOrgWide"
  | "moveSkillHome"
  | "transferSkillOwner"
  | "mergeSkill"
  | "unmergeSkill"
  | "downgradeSkillWriteGrants"
  | "purgeArchivedSkill"
  | "skillDuplicateReport"
  | "backfillSkillOwners"
  | "resolveSkillId"
  | "skillSharingFor"
> {
  const org = () => scopeId("org", orgIdOf());
  const isAdmin = (p: string) => h.skillRightsBase.isOrgAdmin(p);
  const refOf = (id: string) => encodeRef(skillRef(id));
  const displayName = async (id: string) => (await deps.directory.get(id).catch(() => null))?.displayName ?? id;
  const locked = <T>(fn: () => Promise<T>) => withSkillMutationLock(deps, fn);

  async function conflictOf(s: Skill): Promise<SkillConflict> {
    const owner = effectiveSkillOwner(s);
    return { id: s.id, name: s.manifest.name, home: s.scopeId, owner: owner ? await displayName(owner) : BUILT_IN };
  }

  async function seesSkill(s: Skill, actorId: string): Promise<boolean> {
    if (await h.skillRoleFor(s, actorId)) return true;
    const { ordered, granted } = await skillVisibilityContext(deps, h, actorId, [s.scopeId]);
    return (await deps.skills.visibleFor(ordered, granted)).some(
      (r) => r.skill?.id === s.id || r.shadowed.some((x) => x.id === s.id),
    );
  }

  async function nameConflict(s: Skill, actorId: string): Promise<SkillFailure> {
    if (!(await seesSkill(s, actorId))) return fail("name_conflict", "a skill with this name is already visible there");
    return fail("name_conflict", `another /${s.manifest.name} is already visible there`, {
      conflict: await conflictOf(s),
    });
  }

  async function current(id: string): Promise<Skill | SkillFailure> {
    const s = await deps.skills.get(id);
    if (!s) return fail("not_found", "no such skill");
    if (s.supersededBy) {
      return fail("superseded", "this skill was merged into another one", { supersededBy: s.supersededBy });
    }
    return s;
  }

  async function mutable(id: string): Promise<Skill | SkillFailure> {
    const s = await current(id);
    if ("id" in s && s.status === "archived") return fail("bad_request", "restore the skill first");
    return s;
  }

  async function adminAllowed(s: Skill): Promise<boolean> {
    return adminReachesSkill(s, (await deps.acl.grantsFor(s.scopeId, refOf(s.id))).length);
  }

  async function mayChangeOwnership(
    s: Skill,
    actorId: string,
    liveActor: boolean,
    asAdmin: boolean | undefined,
    verb: string,
  ): Promise<SkillFailure | null> {
    if (asAdmin) {
      return (await adminAllowed(s))
        ? null
        : fail("forbidden", `an admin can only ${verb} a personal skill once its owner has shared it`);
    }
    if (!liveActor) return fail("trigger_blocked", SHARED_SKILL_TRIGGER_REFUSAL);
    if (!(await h.skillRights.movesOrTransfers(s, actorId))) {
      return fail("forbidden", `only the skill's owner or an org admin can ${verb} it`);
    }
    return null;
  }

  function homeClash(all: readonly Skill[], s: Skill, home: ScopeId): Skill | undefined {
    return all.find(
      (x) => x.id !== s.id && x.scopeId === home && x.manifest.name === s.manifest.name && x.status !== "archived",
    );
  }

  async function rekey(s: Skill, toScope: ScopeId, actorId: string, flip: () => Promise<unknown>): Promise<number> {
    const ref = refOf(s.id);
    const fromScope = s.scopeId;
    for (const g of await deps.acl.grantsFor(toScope, ref)) {
      await deps.acl.revoke(toScope, ref, g.granteeScopeId, actorId);
    }
    const prior = await deps.acl.grantsFor(fromScope, ref);
    const carried = prior.filter((g) => g.granteeScopeId !== toScope);
    const added: Grant[] = [];
    try {
      for (const g of carried) {
        const next = { ...g, ownerScopeId: toScope, grantedBy: actorId };
        await deps.acl.grant(next);
        added.push(next);
      }
      await flip();
    } catch (error) {
      for (const g of added) {
        await deps.acl
          .revoke(toScope, ref, g.granteeScopeId, actorId)
          .catch((e) => swallow("skills: roll back re-keyed grant", e));
      }
      throw error;
    }
    for (const g of prior) {
      await deps.acl
        .revoke(fromScope, ref, g.granteeScopeId, actorId)
        .catch((e) => swallow("skills: revoke stale grant after re-key", e));
    }
    return carried.length;
  }

  function audit(action: string, actorId: string, resource: string, scopeLabel: ScopeId, detail?: object): void {
    deps.auditLog.record({
      at: Date.now(),
      principalId: actorId,
      action,
      resource,
      scopeLabel,
      ...(detail ? { detail: JSON.stringify(detail) } : {}),
    });
  }

  async function homeLabel(scope: ScopeId): Promise<string> {
    const { kind, ref } = parseScopeId(scope);
    if (kind === "personal") return "your personal skills";
    if (kind === "org") return "the organization";
    if (kind === "group") return (await deps.projects?.name(ref).catch(() => undefined)) ?? "a group conversation";
    const channel = (await deps.directory.listChannels().catch(() => [])).find((c) => c.channelId === ref);
    return channel ? `#${channel.name}` : scope;
  }

  async function notifyNewOwner(s: Skill, newOwner: string, actorId: string, home: ScopeId): Promise<void> {
    try {
      await deps.deliveries.enqueue({
        destination: principalDestination(newOwner, actorId),
        text: `${await displayName(actorId)} made you the owner of /${s.manifest.name} (home ${await homeLabel(home)}). You can edit, share, move or transfer it.`,
        idempotencyKey: `skill-owner:${s.id}:${newOwner}:${Date.now()}`,
      });
    } catch (error) {
      swallow("skills: owner transfer notice", error);
    }
  }

  async function activeTeammate(id: string): Promise<boolean> {
    return (
      deps.identity.isInternal(deps.identity.classify(id)) &&
      deps.identity.deactivationSource?.(id) !== "manual" &&
      (await deps.directory.get(id).catch(() => null))?.type === "internal"
    );
  }

  function rightsFromIndex(grants: readonly Grant[]) {
    const admins = new Map<string, Promise<boolean>>();
    return createSkillRights({
      ...h.skillRightsBase,
      grantsOf: async (skill) => skillGrantsOf(skill, grants),
      isOrgAdmin: (p) => {
        const known = admins.get(p) ?? h.skillRightsBase.isOrgAdmin(p);
        admins.set(p, known);
        return known;
      },
    });
  }

  const setSkillOrgWide: App["setSkillOrgWide"] = ({ id, on, actorId, liveActor, portalSession }) =>
    locked(async () => {
      const s = await (on ? mutable(id) : current(id));
      if (!("id" in s)) return s;
      if (!liveActor) {
        return fail(
          "trigger_blocked",
          `changing who in the organization gets a skill takes a live person the platform can attest is present — ${UNATTESTED_TURN_CAUSE}`,
        );
      }
      if (s.scopeId === org()) return fail("bad_request", "this skill already lives in the org home");
      if (isSourceManagedSkill(s)) return fail("forbidden", "a skill managed by its source can only be archived");
      if (!(await h.skillRights.movesOrTransfers(s, actorId))) {
        return fail(
          "forbidden",
          on
            ? "that skill isn't yours to share"
            : "only the skill's owner or an org admin can stop sharing it with everyone",
        );
      }
      const orgGrant = (await deps.acl.grantsFor(s.scopeId, refOf(s.id))).find((g) => g.granteeScopeId === org());
      if (!on) {
        if (orgGrant) {
          await deps.acl.revoke(s.scopeId, refOf(s.id), org(), actorId);
          audit("skill_demote", actorId, s.id, org(), { mode: "grant" });
        }
        return { ok: true, skill: s };
      }
      if (s.status !== "published") return fail("bad_request", "only a published skill can go org-wide");
      if (!(await isAdmin(actorId))) {
        if (!(await h.skillSharingAllows(actorId, "org"))) {
          return fail("forbidden", "only an org admin can promote a skill org-wide");
        }
        if (!portalSession) {
          return fail(
            "forbidden",
            "giving a skill to the whole organization takes you, in the web app — the agent can't do it for you",
          );
        }
      }
      if (orgGrant) return { ok: true, skill: s };
      const clash = audienceNameClash({
        skill: s,
        granteeScopeId: org(),
        all: await deps.skills.list(),
        grants: await deps.acl.list(),
        orgScopeId: org(),
      });
      if (clash) return nameConflict(clash, actorId);
      await deps.acl.grant({
        ownerScopeId: s.scopeId,
        ref: refOf(s.id),
        granteeScopeId: org(),
        permission: "read",
        grantedBy: actorId,
      });
      audit("skill_promote", actorId, s.id, org(), { mode: "grant" });
      return { ok: true, skill: s };
    });

  return {
    async canManageSkill(id, principalId) {
      const s = await deps.skills.get(id);
      return !!s && (await h.canManageSkill(s, principalId));
    },

    async resolveSkillId(id) {
      let skill = await deps.skills.get(id);
      let redirected = false;
      for (let hop = 0; skill?.supersededBy && skill.status === "archived" && hop < 3; hop++) {
        const next = await deps.skills.get(skill.supersededBy);
        if (!next) break;
        skill = next;
        redirected = true;
      }
      if (!skill) return null;
      return redirected ? { skill, supersededFrom: id } : { skill };
    },

    async skillSharingFor(skills, principalId) {
      const grants = await deps.acl.list().catch(() => []);
      const rights = rightsFromIndex(grants);
      const names = new Map<string, Promise<string>>();
      const nameOf = (id: string) => {
        const known = names.get(id) ?? displayName(id);
        names.set(id, known);
        return known;
      };
      return Promise.all(
        skills.map(async (s): Promise<SkillSharing> => {
          const owner = effectiveSkillOwner(s);
          const live = skillGrantsOf(s, grants);
          const role = await rights.roleFor(s, principalId);
          const canManage = roleManages(s, role);
          return {
            role,
            ...(owner ? { ownerId: owner } : {}),
            ownerName: owner ? await nameOf(owner) : BUILT_IN,
            orgWide: s.scopeId === org() || live.some((g) => g.granteeScopeId === org()),
            canManage,
            canMoveOrTransfer: roleMovesOrTransfers(s, role),
            ...(canManage
              ? { sharedWith: live.map((g) => ({ scopeId: g.granteeScopeId, permission: g.permission })) }
              : {}),
          };
        }),
      );
    },

    shareSkill({ id, toScope, permission, actorId, liveActor }) {
      return locked(async () => {
        const s = await mutable(id);
        if (!("id" in s)) return s;
        if (s.status !== "published") return fail("bad_request", "only a published skill can be shared");
        if (!liveActor) return fail("trigger_blocked", SHARED_SKILL_TRIGGER_REFUSAL);
        if (!(await h.canManageSkill(s, actorId))) {
          return fail("forbidden", "only the skill's owner, a member of its home, or an org admin can share it");
        }
        const admin = await isAdmin(actorId);
        if (!admin && !(await h.skillSharingAllows(actorId, "contexts"))) {
          return fail("forbidden", SKILL_CONTEXTS_ADMIN_ONLY);
        }
        const { kind } = parseScopeId(toScope);
        if (kind === "org") return fail("bad_request", "sharing with everyone goes through the org-wide toggle");
        if (
          (kind === "channel" || kind === "group" || kind === "team") &&
          !admin &&
          !(await h.principalCanAccessCurrentScope(actorId, toScope))
        ) {
          return fail("forbidden", "you can't share into a context you're not a member of");
        }
        if (toScope === s.scopeId) return fail("bad_request", "the skill already lives there");
        const clash = audienceNameClash({
          skill: s,
          granteeScopeId: toScope,
          all: await deps.skills.list(),
          grants: await deps.acl.list(),
          orgScopeId: org(),
        });
        if (clash) return nameConflict(clash, actorId);
        await deps.acl.grant({
          ownerScopeId: s.scopeId,
          ref: refOf(s.id),
          granteeScopeId: toScope,
          permission,
          grantedBy: actorId,
        });
        audit("grant", actorId, refOf(s.id), toScope);
        return { ok: true, skill: s };
      });
    },

    unshareSkill({ id, scope, actorId, liveActor }) {
      return locked(async () => {
        const s = await deps.skills.get(id);
        if (!s) return fail("not_found", "no such skill");
        if (!liveActor) {
          return fail(
            "trigger_blocked",
            `changing who gets a skill takes a live person the platform can attest is present — ${UNATTESTED_TURN_CAUSE}`,
          );
        }
        if (!(await h.canManageSkill(s, actorId)))
          return fail("forbidden", "that skill isn't yours to share or unshare");
        if (scope === org() && !samePerson(effectiveSkillOwner(s), actorId) && !(await isAdmin(actorId))) {
          return fail("forbidden", "only the skill's owner or an org admin can stop sharing it with everyone");
        }
        await deps.acl.revoke(s.scopeId, refOf(s.id), scope, actorId);
        audit(scope === org() ? "skill_demote" : "revoke", actorId, scope === org() ? s.id : refOf(s.id), scope);
        return { ok: true, skill: s };
      });
    },

    setSkillOrgWide,

    async promoteSkill(id, targetScopeId, actorId, liveActor, portalSession = false) {
      if (parseScopeId(targetScopeId).kind !== "org") {
        throw new Error("promote targets the org scope — use share or move for anything narrower");
      }
      const result = await setSkillOrgWide({ id, on: true, actorId, liveActor, portalSession });
      if (!result.ok) throw new AdminError(OUTCOME_STATUS[result.code], result.message);
      return result.skill;
    },

    async demoteSkill(id, actorId, liveActor) {
      const s = await deps.skills.get(id);
      if (!s) throw new AdminError(404, "no such skill");
      if (s.scopeId !== org()) {
        const result = await setSkillOrgWide({ id, on: false, actorId, liveActor });
        if (!result.ok) throw new AdminError(OUTCOME_STATUS[result.code], result.message);
        return;
      }
      if (liveActor !== true) {
        throw new AdminError(
          403,
          `taking a skill back from the org takes a live person the platform can attest is present — ${UNATTESTED_TURN_CAUSE}`,
        );
      }
      if (!(await h.mayTakeSkillFromOrg(s, actorId))) {
        throw new AdminError(403, "only an org admin can take a skill back from the org");
      }
      await deps.skills.archive(id);
      audit("skill_demote", actorId, id, s.scopeId);
    },

    moveSkillHome({ id, toScope, actorId, liveActor, asAdmin }) {
      return locked(async () => {
        const s = await mutable(id);
        if (!("id" in s)) return s;
        if (isSourceManagedSkill(s)) return fail("forbidden", "a skill managed by its source can only be archived");
        const refused = await mayChangeOwnership(s, actorId, liveActor, asAdmin, "move");
        if (refused) return refused;
        const admin = asAdmin === true || (await isAdmin(actorId));
        if (!admin && !(await h.mayTakeSkillFromOrg(s, actorId))) {
          return fail("forbidden", "only an org admin can take a skill out of the org home");
        }
        const owner = effectiveSkillOwner(s)!;
        const { kind, ref } = parseScopeId(toScope);
        if (toScope === s.scopeId) return fail("bad_request", "the skill already lives there");
        if (kind === "org" && !admin) return fail("forbidden", "only an org admin can move a skill into the org home");
        if (kind !== "org" && kind !== "personal" && kind !== "channel" && kind !== "group") {
          return fail("bad_request", "a skill can live in a personal space, a channel, a group, or the org home");
        }
        if (kind === "personal" && !samePerson(ref, owner)) {
          return fail(
            "forbidden",
            "a skill only moves into its owner's personal space — transfer ownership to give it to someone",
          );
        }
        if (isSharedScope(toScope)) {
          if (!admin && !(await h.principalCanAccessCurrentScope(actorId, toScope))) {
            return fail("forbidden", "you can only move a skill into a context you belong to");
          }
          if (!admin && !(await h.maySkillLiveIn(toScope, actorId)))
            return fail("forbidden", SKILL_CONTEXTS_ADMIN_ONLY);
        }
        const clash = homeClash(await deps.skills.list(), s, toScope);
        if (clash) return nameConflict(clash, actorId);
        const from = s.scopeId;
        const regranted = await rekey(s, toScope, actorId, () => deps.skills.setOwner(s.id, owner, toScope));
        audit("skill_move", actorId, s.id, toScope, { from, to: toScope, regranted });
        return { ok: true, skill: (await deps.skills.get(s.id)) ?? s };
      });
    },

    transferSkillOwner({ id, newOwnerId, homeScope, actorId, liveActor, asAdmin }) {
      return locked(async () => {
        const s = await mutable(id);
        if (!("id" in s)) return s;
        if (isSourceManagedSkill(s)) return fail("forbidden", "a skill managed by its source can only be archived");
        const refused = await mayChangeOwnership(s, actorId, liveActor, asAdmin, "transfer");
        if (refused) return refused;
        const newOwner = canonicalPerson(newOwnerId.trim());
        if (!newOwner || !(await activeTeammate(newOwner))) {
          return fail("bad_request", "the new owner must be an active teammate");
        }
        const admin = asAdmin === true || (await isAdmin(actorId));
        const from = effectiveSkillOwner(s);
        let home = s.scopeId;
        if (parseScopeId(s.scopeId).kind === "personal") {
          if (!admin && !samePerson(newOwner, actorId) && !(await h.skillSharingAllows(actorId, "contexts"))) {
            return fail("forbidden", SKILL_CONTEXTS_ADMIN_ONLY);
          }
          home = homeScope ?? scopeId("personal", newOwner);
          const target = parseScopeId(home);
          if (target.kind === "personal" && !samePerson(target.ref, newOwner)) {
            return fail("bad_request", "a personal skill can only live in its owner's personal space");
          }
          if (target.kind !== "personal" && !isSharedScope(home)) {
            return fail("bad_request", "pick the new owner's personal space, a channel, or a group as its home");
          }
          if (isSharedScope(home)) {
            if (!(await h.principalCanAccessCurrentScope(newOwner, home))) {
              return fail("bad_request", "the new owner isn't a member of that context");
            }
            if (!admin && !(await h.principalCanAccessCurrentScope(actorId, home))) {
              return fail("forbidden", "you can only give the skill a home you belong to");
            }
            if (!admin && !(await h.maySkillLiveIn(home, actorId))) return fail("forbidden", SKILL_CONTEXTS_ADMIN_ONLY);
          }
          const clash = home === s.scopeId ? undefined : homeClash(await deps.skills.list(), s, home);
          if (clash) return nameConflict(clash, actorId);
          await rekey(s, home, actorId, () => deps.skills.setOwner(s.id, newOwner, home));
        } else {
          if (homeScope && homeScope !== s.scopeId) {
            return fail("bad_request", "only a personal skill changes home on transfer — move it instead");
          }
          if (isSharedScope(s.scopeId) && !admin && !(await h.skillRightsBase.isHomeMember(newOwner, s.scopeId))) {
            return fail("bad_request", "the new owner isn't a member of the skill's home");
          }
          await deps.skills.setOwner(s.id, newOwner);
        }
        audit("skill_owner_transfer", actorId, s.id, home, { from, to: newOwner, home });
        if (!samePerson(newOwner, actorId)) await notifyNewOwner(s, newOwner, actorId, home);
        return { ok: true, skill: (await deps.skills.get(s.id)) ?? s };
      });
    },

    mergeSkill({ fromId, intoId, actorId, force }) {
      return locked(async () => {
        const [from, into] = await Promise.all([deps.skills.get(fromId), deps.skills.get(intoId)]);
        if (!from || !into) return fail("not_found", "no such skill");
        if (from.id === into.id) return fail("bad_request", "a skill can't be merged into itself");
        if (isSourceManagedSkill(from) || isSourceManagedSkill(into)) {
          return fail("forbidden", "a skill managed by its source can't be merged");
        }
        if (from.manifest.name !== into.manifest.name) {
          return fail("name_mismatch", "only skills with the same name can be merged");
        }
        if (from.supersededBy || into.supersededBy) {
          return fail("superseded", "one of these skills was already merged", {
            supersededBy: from.supersededBy ?? into.supersededBy!,
          });
        }
        if (into.status !== "published") return fail("bad_request", "merge into a published skill");
        if (from.status === "published" && from.signature !== into.signature && !force) {
          return fail("diverged", "the two skills differ — get the owner's approval, then merge with force", {
            diff: manifestDiff(from.manifest, into.manifest),
          });
        }
        const fromStatus = from.status;
        const ref = refOf(into.id);
        const fromRef = refOf(from.id);
        const fromGrants = await deps.acl.grantsFor(from.scopeId, fromRef);
        const reached = new Set((await deps.acl.grantsFor(into.scopeId, ref)).map((g) => g.granteeScopeId));
        const needOrg =
          (from.scopeId === org() && from.status === "published") || fromGrants.some((g) => g.granteeScopeId === org());
        const targets = new Map<ScopeId, Permission>();
        for (const g of fromGrants) targets.set(g.granteeScopeId, g.granteeScopeId === org() ? "read" : g.permission);
        if (needOrg) targets.set(org(), "read");
        const added: ScopeId[] = [];
        for (const [grantee, permission] of targets) {
          if (grantee === into.scopeId || reached.has(grantee)) continue;
          await deps.acl.grant({
            ownerScopeId: into.scopeId,
            ref,
            granteeScopeId: grantee,
            permission,
            grantedBy: actorId,
          });
          added.push(grantee);
        }
        const regranted = added.length;
        await deps.skills.retire(from.id, into.id);
        for (const g of fromGrants) {
          await deps.acl
            .revoke(from.scopeId, fromRef, g.granteeScopeId, actorId)
            .catch((e) => swallow("skills: revoke merged skill grant", e));
        }
        const owner = effectiveSkillOwner(into);
        if (!into.ownerId && owner) await deps.skills.setOwner(into.id, owner);
        audit("skill_merge", actorId, from.id, into.scopeId, {
          into: into.id,
          forced: force === true,
          regranted,
          added,
          fromStatus,
          fromGrants: fromGrants.map((g) => ({ granteeScopeId: g.granteeScopeId, permission: g.permission })),
        });
        return {
          ok: true,
          retired: from.id,
          into: into.id,
          regranted,
          orgWide: into.scopeId === org() || needOrg || reached.has(org()),
        };
      });
    },

    unmergeSkill({ id, actorId }) {
      return locked(async () => {
        const s = await deps.skills.get(id);
        if (!s) return fail("not_found", "no such skill");
        const into = s.supersededBy;
        if (!into) return fail("bad_request", "this skill was never merged into another one");
        const clash = homeClash(await deps.skills.list(), s, s.scopeId);
        if (clash) return nameConflict(clash, actorId);
        const merge = (await deps.auditLog.tail({ limit: 50_000, action: "skill_merge", resourceContains: s.id }))
          .filter((e) => e.resource === s.id)
          .reduce<AuditEvent | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined);
        const detail = mergeDetail(merge?.detail);
        await deps.skills.unretire(s.id);
        if (detail.fromStatus !== "archived") await deps.skills.publish(s.id);
        const ref = refOf(s.id);
        for (const g of detail.fromGrants) {
          await deps.acl.grant({ ownerScopeId: s.scopeId, ref, ...g, grantedBy: actorId });
        }
        const canonical = await deps.skills.get(into);
        let revoked = 0;
        if (canonical) {
          const intoRef = refOf(canonical.id);
          const live = new Set((await deps.acl.grantsFor(canonical.scopeId, intoRef)).map((g) => g.granteeScopeId));
          for (const grantee of detail.added.filter((x) => live.has(x))) {
            await deps.acl.revoke(canonical.scopeId, intoRef, grantee, actorId);
            revoked++;
          }
        }
        audit("skill_unmerge", actorId, s.id, s.scopeId, { from: into, regranted: detail.fromGrants.length, revoked });
        return { ok: true, restored: s.id, from: into, regranted: detail.fromGrants.length, revoked };
      });
    },

    downgradeSkillWriteGrants({ dryRun, actorId }) {
      return locked(async () => {
        const writes = skillWriteGrants(await deps.skills.list(), await deps.acl.list());
        if (dryRun) return { downgraded: writes };
        for (const w of writes) {
          const ref = refOf(w.skillId);
          await deps.acl.revoke(w.ownerScopeId, ref, w.granteeScopeId, actorId);
          await deps.acl.grant({
            ownerScopeId: w.ownerScopeId,
            ref,
            granteeScopeId: w.granteeScopeId,
            permission: "read",
            grantedBy: actorId,
          });
        }
        if (writes.length) audit("skill_write_grants_downgrade", actorId, "skills", org(), { count: writes.length });
        return { downgraded: writes };
      });
    },

    purgeArchivedSkill({ id, actorId }) {
      return locked(async () => {
        const s = await deps.skills.get(id);
        if (!s) return fail("not_found", "no such skill");
        if (s.status !== "archived") return fail("bad_request", "only an archived skill can be purged");
        const all = await deps.skills.list();
        if (all.some((x) => x.supersededBy === s.id)) {
          return fail("bad_request", "other skills redirect to this one — it can't be purged");
        }
        const ref = refOf(s.id);
        for (const g of (await deps.acl.list()).filter((x) => x.ref === ref)) {
          await deps.acl.revoke(g.ownerScopeId, ref, g.granteeScopeId, actorId);
        }
        await deps.skills.delete(s.id);
        audit("skill_purge", actorId, s.id, s.scopeId, { name: s.manifest.name });
        return { ok: true, skill: s };
      });
    },

    async skillDuplicateReport() {
      const [skills, grants, promotes] = await Promise.all([
        deps.skills.list(),
        deps.acl.list(),
        deps.auditLog.tail({ limit: 50_000, action: "skill_promote" }),
      ]);
      return planSkillDuplicates({ skills, grants, promotes, orgScopeId: org() });
    },

    backfillSkillOwners({ dryRun, actorId }) {
      return locked(async () => {
        const all = await deps.skills.list();
        const updated: string[] = [];
        for (const s of all) {
          const owner = ownerBackfillFor(s);
          if (!owner) continue;
          if (!dryRun) await deps.skills.setOwner(s.id, owner);
          updated.push(s.id);
        }
        if (!dryRun && updated.length)
          audit("skill_owner_backfill", actorId, "skills", org(), { count: updated.length });
        return {
          updated,
          skipped: all.length - updated.length,
          personalHomeMismatch: all
            .filter(personalHomeMismatch)
            .map((s) => ({ id: s.id, scopeId: s.scopeId, createdBy: s.createdBy })),
        };
      });
    },
  };
}
