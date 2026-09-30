import { isSharedScope, parseScopeId, type Grant, type Principal, type ScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { encodeRef, skillRef } from "../acl/resource-ref.ts";
import { isSourceManagedSkill, PLATFORM_SKILL_AUTHOR, type Skill } from "./skill-store.ts";

export type SkillRole = "owner" | "home_member" | "admin" | "write_grantee";

type OwnedSkill = Pick<Skill, "scopeId" | "ownerId" | "createdBy">;

export function effectiveSkillOwner(s: OwnedSkill): string | undefined {
  const { kind, ref } = parseScopeId(s.scopeId);
  if (kind === "personal" && ref) return ref;
  return s.ownerId ?? (PLATFORM_SKILL_AUTHOR.test(s.createdBy) ? undefined : s.createdBy);
}

export function liveSkillGrants(skill: Pick<Skill, "scopeId">, grants: readonly Grant[]): Grant[] {
  return grants.filter((g) => g.ownerScopeId === skill.scopeId);
}

function reachesBeyondHome(home: ScopeId, hasGrants: boolean): boolean {
  return isSharedScope(home) || parseScopeId(home).kind === "org" || hasGrants;
}

export function triggerBlocksSkillChange(home: ScopeId, hasGrants: boolean, liveActor: boolean): boolean {
  return reachesBeyondHome(home, hasGrants) && !liveActor;
}

export type GrantChange = "grant" | "revoke";

interface SkillRightsDeps {
  isActivePerson(principalId: string): boolean;
  isHomeMember(principalId: string, scope: ScopeId): Promise<boolean>;
  isOrgAdmin(principalId: string): Promise<boolean>;
  grantsOf(skill: Pick<Skill, "id" | "scopeId">): Promise<Grant[]>;
}

export function adminReachesSkill(skill: Skill, liveGrants: number): boolean {
  return isSourceManagedSkill(skill) || parseScopeId(skill.scopeId).kind !== "personal" || liveGrants > 0;
}

export function roleManages(skill: Skill, role: SkillRole | null): boolean {
  return !isSourceManagedSkill(skill) && (role === "owner" || role === "home_member" || role === "admin");
}

export function roleMovesOrTransfers(skill: Skill, role: SkillRole | null): boolean {
  return !isSourceManagedSkill(skill) && (role === "owner" || role === "admin");
}

export function createSkillRights(d: SkillRightsDeps) {
  function holdsWriteGrant(principalId: string, grantee: ScopeId): Promise<boolean> | boolean {
    const { kind, ref } = parseScopeId(grantee);
    if (kind === "personal") return samePerson(ref, principalId);
    return (kind === "channel" || kind === "group") && d.isHomeMember(principalId, grantee);
  }

  async function roleFor(
    skill: Skill,
    principalId: string,
    opts: { writeGrants?: boolean } = {},
  ): Promise<SkillRole | null> {
    if (!principalId || !d.isActivePerson(principalId)) return null;
    const sourceManaged = isSourceManagedSkill(skill);
    if (!sourceManaged && samePerson(effectiveSkillOwner(skill), principalId)) return "owner";
    const { kind } = parseScopeId(skill.scopeId);
    if ((kind === "channel" || kind === "group") && (await d.isHomeMember(principalId, skill.scopeId))) {
      return "home_member";
    }
    let grants: Grant[] | undefined;
    const loadGrants = async () => (grants ??= liveSkillGrants(skill, await d.grantsOf(skill)));
    if ((await d.isOrgAdmin(principalId)) && adminReachesSkill(skill, (await loadGrants()).length)) return "admin";
    if (sourceManaged) return null;
    if (opts.writeGrants) {
      for (const g of await loadGrants()) {
        if (g.permission === "write" && (await holdsWriteGrant(principalId, g.granteeScopeId))) {
          return "write_grantee";
        }
      }
    }
    return null;
  }

  async function manages(skill: Skill, principalId: string): Promise<boolean> {
    return roleManages(skill, await roleFor(skill, principalId));
  }

  async function movesOrTransfers(skill: Skill, principalId: string): Promise<boolean> {
    return roleMovesOrTransfers(skill, await roleFor(skill, principalId));
  }

  async function managesGrantKey(
    skill: Skill | null,
    principalId: string,
    ownerScopeId: ScopeId,
    change: GrantChange,
  ): Promise<boolean> {
    if (!principalId || !d.isActivePerson(principalId)) return false;
    if (await d.isOrgAdmin(principalId)) return true;
    if (!skill) return false;
    if (ownerScopeId === skill.scopeId) return manages(skill, principalId);
    if (await movesOrTransfers(skill, principalId)) return true;
    if (change === "grant") return false;
    const { kind, ref } = parseScopeId(ownerScopeId);
    if (kind === "personal") return samePerson(ref, principalId);
    return (kind === "channel" || kind === "group") && d.isHomeMember(principalId, ownerScopeId);
  }

  return { roleFor, manages, movesOrTransfers, managesGrantKey };
}

interface SkillRightsSources {
  identity: {
    classify(id: string): Principal;
    isInternal(p: Principal): boolean;
    deactivationSource?(id: string): string | undefined;
  };
  admin?: { adminStatusOf(p: Principal): Promise<{ isAdmin: boolean }> };
  isCurrentSharedScopeMember(principalId: string, scope: ScopeId): Promise<boolean>;
  acl: { grantsFor(ownerScopeId: ScopeId, ref: string): Promise<Grant[]> };
}

export function skillRightsDeps(src: SkillRightsSources): SkillRightsDeps {
  return {
    isActivePerson: (id) =>
      src.identity.isInternal(src.identity.classify(id)) && src.identity.deactivationSource?.(id) !== "manual",
    isHomeMember: (id, scope) => src.isCurrentSharedScopeMember(id, scope),
    isOrgAdmin: async (id) =>
      (await src.admin?.adminStatusOf({ id, type: "internal" }).catch(() => undefined))?.isAdmin === true,
    grantsOf: (skill) => src.acl.grantsFor(skill.scopeId, encodeRef(skillRef(skill.id))).catch(() => []),
  };
}
