import { isSharedScope, parseScopeId, scopeId, type Grant, type Permission, type ScopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { canonicalPerson, samePerson } from "../directory/person.ts";
import { encodeRef, skillRef } from "../acl/resource-ref.ts";
import { principalDestination } from "../reach/reach.ts";
import { swallow } from "../util/errors.ts";
import { isSourceManagedSkill, type Skill } from "../skills/skill-store.ts";
import { createSkillRights, effectiveSkillOwner, type SkillRights, type SkillRole } from "../skills/skill-rights.ts";
import {
  audienceNameClash,
  manifestDiff,
  ownerBackfillFor,
  personalHomeMismatch,
  planSkillDuplicates,
  skillGrantsOf,
  type ManifestDiff,
} from "../skills/skill-namespace.ts";
import { SHARED_SKILL_TRIGGER_REFUSAL, SKILL_CONTEXTS_ADMIN_ONLY, UNATTESTED_TURN_CAUSE } from "./artifact-share.ts";
import { withSkillMutationLock } from "./app-skills.ts";
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

  async function nameConflict(s: Skill): Promise<SkillFailure> {
    return fail("name_conflict", `another /${s.manifest.name} is already visible there`, {
      conflict: await conflictOf(s),
    });
  }

  async function mutable(id: string): Promise<Skill | SkillFailure> {
    const s = await deps.skills.get(id);
    if (!s) return fail("not_found", "no such skill");
    if (s.supersededBy) {
      return fail("superseded", "this skill was merged into another one", { supersededBy: s.supersededBy });
    }
    if (s.status === "archived") return fail("bad_request", "restore the skill first");
    return s;
  }

  function homeClash(all: readonly Skill[], s: Skill, home: ScopeId): Skill | undefined {
    return all.find(
      (x) => x.id !== s.id && x.scopeId === home && x.manifest.name === s.manifest.name && x.status !== "archived",
    );
  }

  async function rekey(s: Skill, toScope: ScopeId, actorId: string, flip: () => Promise<unknown>): Promise<number> {
    const ref = refOf(s.id);
    const fromScope = s.scopeId;
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
        idempotencyKey: `skill-owner:${s.id}:${newOwner}`,
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

  function rightsFromIndex(grants: readonly Grant[]): SkillRights {
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
      const s = await mutable(id);
      if (!("id" in s)) return s;
      if (!liveActor) {
        return fail(
          "trigger_blocked",
          `changing who in the organization gets a skill takes a live person the platform can attest is present — ${UNATTESTED_TURN_CAUSE}`,
        );
      }
      if (s.scopeId === org()) return fail("bad_request", "this skill already lives in the org home");
      if (isSourceManagedSkill(s)) return fail("forbidden", "a skill managed by its source can only be archived");
      const admin = await isAdmin(actorId);
      const owner = samePerson(effectiveSkillOwner(s), actorId);
      const orgGrant = skillGrantsOf(s, await deps.acl.list()).find((g) => g.granteeScopeId === org());
      if (!on) {
        if (!admin && !owner) {
          return fail("forbidden", "only the skill's owner or an org admin can stop sharing it with everyone");
        }
        if (orgGrant) {
          await deps.acl.revoke(s.scopeId, refOf(s.id), org(), actorId);
          audit("skill_demote", actorId, s.id, org(), { mode: "grant" });
        }
        return { ok: true, skill: s };
      }
      if (s.status !== "published") return fail("bad_request", "only a published skill can go org-wide");
      if (!admin) {
        if (!(await h.skillSharingAllows(actorId, "org"))) {
          return fail("forbidden", "only an org admin can promote a skill org-wide");
        }
        if (!portalSession) {
          return fail(
            "forbidden",
            "giving a skill to the whole organization takes you, in the web app — the agent can't do it for you",
          );
        }
        if (!owner) return fail("forbidden", "that skill isn't yours to share");
      }
      if (orgGrant) return { ok: true, skill: s };
      const clash = audienceNameClash({
        skill: s,
        granteeScopeId: org(),
        all: await deps.skills.list(),
        grants: await deps.acl.list(),
        orgScopeId: org(),
      });
      if (clash) return nameConflict(clash);
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
          const canManage = await rights.manages(s, principalId);
          return {
            role,
            ...(owner ? { ownerId: owner } : {}),
            ownerName: owner ? await nameOf(owner) : BUILT_IN,
            orgWide: s.scopeId === org() || live.some((g) => g.granteeScopeId === org()),
            canManage,
            canMoveOrTransfer: await rights.movesOrTransfers(s, principalId),
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
        if (clash) return nameConflict(clash);
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

    unshareSkill({ id, scope, actorId }) {
      return locked(async () => {
        const s = await deps.skills.get(id);
        if (!s) return fail("not_found", "no such skill");
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
      const own = samePerson(effectiveSkillOwner(s), actorId) && (await h.skillSharingAllows(actorId, "org"));
      if (!own && !(await isAdmin(actorId))) {
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
        if (!asAdmin) {
          if (!liveActor) return fail("trigger_blocked", SHARED_SKILL_TRIGGER_REFUSAL);
          if (!(await h.skillRights.movesOrTransfers(s, actorId))) {
            return fail("forbidden", "only the skill's owner or an org admin can move it");
          }
        }
        const admin = asAdmin === true || (await isAdmin(actorId));
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
        if (clash) return nameConflict(clash);
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
        if (!asAdmin) {
          if (!liveActor) return fail("trigger_blocked", SHARED_SKILL_TRIGGER_REFUSAL);
          if (!(await h.skillRights.movesOrTransfers(s, actorId))) {
            return fail("forbidden", "only the skill's owner or an org admin can transfer it");
          }
        }
        const newOwner = canonicalPerson(newOwnerId.trim());
        if (!newOwner || !(await activeTeammate(newOwner))) {
          return fail("bad_request", "the new owner must be an active teammate");
        }
        const admin = asAdmin === true || (await isAdmin(actorId));
        const from = effectiveSkillOwner(s);
        let home = s.scopeId;
        if (parseScopeId(s.scopeId).kind === "personal") {
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
          if (clash) return nameConflict(clash);
          await rekey(s, home, actorId, () => deps.skills.setOwner(s.id, newOwner, home));
        } else {
          if (homeScope && homeScope !== s.scopeId) {
            return fail("bad_request", "only a personal skill changes home on transfer — move it instead");
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
        const ref = refOf(into.id);
        const fromRef = refOf(from.id);
        const fromGrants = await deps.acl.grantsFor(from.scopeId, fromRef);
        const reached = new Set((await deps.acl.grantsFor(into.scopeId, ref)).map((g) => g.granteeScopeId));
        const needOrg =
          (from.scopeId === org() && from.status === "published") || fromGrants.some((g) => g.granteeScopeId === org());
        const targets = new Map<ScopeId, Permission>();
        for (const g of fromGrants) targets.set(g.granteeScopeId, g.granteeScopeId === org() ? "read" : g.permission);
        if (needOrg) targets.set(org(), "read");
        let regranted = 0;
        for (const [grantee, permission] of targets) {
          if (grantee === into.scopeId || reached.has(grantee)) continue;
          await deps.acl.grant({
            ownerScopeId: into.scopeId,
            ref,
            granteeScopeId: grantee,
            permission,
            grantedBy: actorId,
          });
          regranted++;
        }
        await deps.skills.retire(from.id, into.id);
        for (const g of fromGrants) {
          await deps.acl
            .revoke(from.scopeId, fromRef, g.granteeScopeId, actorId)
            .catch((e) => swallow("skills: revoke merged skill grant", e));
        }
        const owner = effectiveSkillOwner(into);
        if (!into.ownerId && owner) await deps.skills.setOwner(into.id, owner);
        audit("skill_merge", actorId, from.id, into.scopeId, { into: into.id, forced: force === true, regranted });
        return {
          ok: true,
          retired: from.id,
          into: into.id,
          regranted,
          orgWide: into.scopeId === org() || needOrg || reached.has(org()),
        };
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
