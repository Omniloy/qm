import type { ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import {
  isSourceManagedSkill,
  managesSkill,
  type Skill,
  type SkillManifest,
  type SkillStanding,
} from "../skills/skill-store.ts";
import type { SkillPack, SkillPackStore } from "../skills/skill-pack-store.ts";
import type { SkillPackFetcher } from "../skills/pack-fetcher.ts";
import { planIngest, importPack, collectSharedBundle, type ImportResult } from "../skills/ingest.ts";
import { computeBundleHash } from "../skills/skill-bundle-store.ts";
import { persistedSkillRecordPaths, SKILL_MATERIALIZATION_LOCK } from "../skills/skill-collision.ts";
import { livePersonCapability } from "./artifact-share.ts";
import { conversationLabelFor } from "../core/orchestrator/turn-helpers.ts";
import { samePerson } from "../directory/person.ts";

import type { App, AppDeps, SkillViewer } from "./app-types.ts";
import { encodeRef, parseRef, skillRef } from "../acl/resource-ref.ts";
import { effectiveSkillOwner } from "../skills/skill-rights.ts";
import { audienceNameClash, skillGrantsOf } from "../skills/skill-namespace.ts";
import { principalEntitledToScope } from "../resolution/context-filter.ts";
import type { Grant, Principal } from "../types.ts";
import type { AppHelpers } from "./app-helpers.ts";

export async function skillVisibilityContext(
  deps: AppDeps,
  h: AppHelpers,
  principalId: string,
  homes: readonly ScopeId[],
) {
  const actor = deps.identity.classify(principalId);
  const sharedHomes = [
    ...new Set(
      homes.filter((sid) => {
        const k = parseScopeId(sid).kind;
        return k === "channel" || k === "group";
      }),
    ),
  ];
  const accessibleScopes = new Set(await h.currentResourceScopesForViewer(principalId));
  const member = sharedHomes.map((sid) => (accessibleScopes.has(sid) ? sid : null));
  const shared = member.filter((sid): sid is ScopeId => sid !== null);
  const teams = (actor.teamIds ?? []).map((t) => scopeId("team", t));
  const ordered = [...new Set([scopeId("personal", principalId), ...shared, ...teams, scopeId("org", orgIdOf())])];
  const entitled = (p: Principal, label: ScopeId, sess: ScopeId, org: ScopeId) =>
    principalEntitledToScope(p, label, sess, org) || accessibleScopes.has(label);
  const granted = (
    await deps.acl
      .sharedOfKindForAudience("skill", [actor], scopeId("personal", principalId), scopeId("org", orgIdOf()), entitled)
      .catch(() => [])
  ).map((g) => ({ id: parseRef(g.ref).id, ownerScopeId: g.ownerScopeId }));
  return { ordered, granted };
}

async function skillHomeLabel(deps: AppDeps, home: ScopeId, viewer: SkillViewer): Promise<string> {
  const { kind, ref } = parseScopeId(home);
  if (kind === "org") return "org";
  if (kind === "personal" && samePerson(ref, viewer.actorId)) return "personal (yours)";
  if (home !== viewer.scopeId) return "shared from another conversation";
  if (kind === "group") {
    const name = await deps.projects?.name(ref).catch(() => undefined);
    return name ? `project ${name}` : "this conversation";
  }
  if (kind === "channel") return (await conversationLabelFor(deps.directory, home, undefined)) ?? "this conversation";
  return "this conversation";
}

function skillStandingsFor(
  deps: AppDeps,
  h: AppHelpers,
  viewer: SkillViewer,
): (skill: Skill) => Promise<Required<SkillStanding>> {
  const access = h.skillEditAccessFor(viewer.actorId, livePersonCapability(viewer));
  const labels = new Map<ScopeId, Promise<string>>();
  const names = new Map<string, Promise<string>>();
  const org = scopeId("org", orgIdOf());
  let grants: Promise<readonly Grant[]> | undefined;
  const nameOf = (id: string) => {
    const known =
      names.get(id) ??
      deps.directory.get(id).then(
        (m) => m?.displayName ?? id,
        () => id,
      );
    names.set(id, known);
    return known;
  };
  return async (skill) => {
    grants ??= deps.acl.list().catch(() => []);
    const ownerId = effectiveSkillOwner(skill);
    const owner = ownerId ? await nameOf(ownerId) : "built-in";
    const orgWide = skill.scopeId === org || skillGrantsOf(skill, await grants).some((g) => g.granteeScopeId === org);
    const label = labels.get(skill.scopeId) ?? skillHomeLabel(deps, skill.scopeId, viewer);
    labels.set(skill.scopeId, label);
    const home = orgWide && skill.scopeId !== org ? `org-wide (home ${await label})` : await label;
    return { id: skill.id, home, edit: await access(skill), owner, orgWide };
  };
}

function requireRegistry(deps: AppDeps): { packs: SkillPackStore; fetcher: SkillPackFetcher } {
  if (!deps.skillPacks || !deps.skillFetcher) throw new Error("skill registry not configured");
  return { packs: deps.skillPacks, fetcher: deps.skillFetcher };
}

async function nativeNamesFor(deps: AppDeps, packId: string, scope: ScopeId): Promise<Set<string>> {
  const all = await deps.skills.list();
  return new Set(
    all.filter((s) => s.scopeId === scope && s.createdBy !== `pack:${packId}`).map((s) => s.manifest.name),
  );
}

async function importedPackSkills(
  deps: AppDeps,
  packId: string,
): Promise<Array<{ scopeId: ScopeId; upstreamName: string }>> {
  return (await deps.skills.list()).flatMap((s) =>
    s.status === "published" && s.pack?.packId === packId
      ? [{ scopeId: s.scopeId, upstreamName: s.pack.upstreamName }]
      : [],
  );
}

async function buildClaimedPaths(deps: AppDeps, exceptPackId: string, scopeId: ScopeId): Promise<Map<string, string>> {
  const claimed = new Map<string, string>();
  for (const s of await deps.skills.list()) {
    if (s.status !== "published" || s.createdBy === `pack:${exceptPackId}` || s.scopeId !== scopeId) continue;
    for (const p of persistedSkillRecordPaths(s.manifest.name, s.manifest.files)) claimed.set(p, s.createdBy);
  }
  return claimed;
}

async function buildClaimedBundlePaths(deps: AppDeps): Promise<Map<string, string>> {
  const claimed = new Map<string, string>();
  for (const skill of await deps.skills.list()) {
    if (skill.status !== "published") continue;
    for (const path of persistedSkillRecordPaths(skill.manifest.name, skill.manifest.files)) {
      claimed.set(path, `skill "${skill.manifest.name}" in ${skill.scopeId}`);
    }
  }
  return claimed;
}

async function archiveRemoved(deps: AppDeps, packId: string, scopeId: ScopeId, kept: string[]): Promise<string[]> {
  const keptSet = new Set(kept);
  const archived: string[] = [];
  for (const s of await deps.skills.list()) {
    if (s.createdBy !== `pack:${packId}` || s.scopeId !== scopeId || s.status === "archived") continue;
    const upstream = s.pack?.upstreamName;
    if (upstream && !keptSet.has(upstream)) {
      await deps.skills.archive(s.id);
      archived.push(s.manifest.name);
    }
  }
  return archived;
}

interface ReconcileTarget {
  scopeId: ScopeId;
  selected: "all" | string[];
}

function skillPackSourceIdentity(pack: SkillPack): string {
  return JSON.stringify([
    pack.url,
    pack.ref,
    pack.syncMode,
    pack.trustTier,
    pack.config ?? null,
    pack.targetScopeId,
    pack.subset,
    pack.authCredentialSlug ?? null,
    pack.lastImport ?? null,
  ]);
}

export function withSkillMutationLock<T>(deps: AppDeps, fn: () => Promise<T>): Promise<T> {
  return deps.advisoryLock?.withLock(SKILL_MATERIALIZATION_LOCK, fn) ?? fn();
}

async function reconcilePack(
  deps: AppDeps,
  packs: SkillPackStore,
  fetcher: SkillPackFetcher,
  id: string,
  targets: ReconcileTarget[],
): Promise<ImportResult> {
  const pack = await packs.get(id);
  if (!pack) throw new Error(`unknown skill pack: ${id}`);
  let repo: Awaited<ReturnType<SkillPackFetcher["fetch"]>>;
  try {
    repo = await fetcher.fetch(pack);
  } catch (e) {
    await packs.recordImport(id, {
      at: Date.now(),
      commit: pack.ref,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  const applyFetched = async (): Promise<ImportResult> => {
    const current = await packs.get(id);
    if (!current) throw new Error(`unknown skill pack: ${id}`);
    if (skillPackSourceIdentity(current) !== skillPackSourceIdentity(pack)) {
      throw new Error(`skill pack changed while fetching: ${id}`);
    }
    try {
      const bundleFiles = collectSharedBundle(repo, pack.config);
      const canonPlan = planIngest(repo, {
        ...(pack.config ? { config: pack.config } : {}),
        nativeNames: await nativeNamesFor(deps, id, pack.targetScopeId),
      });
      const imported: string[] = [];
      const updated: string[] = [];
      const skipped: string[] = [];
      const archived: string[] = [];
      for (const target of targets) {
        const nativeNames = await nativeNamesFor(deps, id, target.scopeId);
        const claimedPaths = await buildClaimedPaths(deps, id, target.scopeId);
        const claimedBundlePaths = await buildClaimedBundlePaths(deps);
        const { kept, ...base } = await importPack(repo, deps.skills, {
          pack,
          selected: target.selected,
          targetScopeId: target.scopeId,
          nativeNames,
          claimedPaths,
          claimedBundlePaths,
          bundleFiles,
        });
        imported.push(...base.imported);
        updated.push(...base.updated);
        skipped.push(...base.skipped);
        archived.push(...(await archiveRemoved(deps, id, target.scopeId, kept)));
      }
      if (deps.skillBundles) {
        await deps.skillBundles.put({
          packId: id,
          commit: repo.commit,
          files: bundleFiles,
          hash: computeBundleHash(bundleFiles),
        });
      }
      const result: ImportResult = { imported, updated, skipped, archived, counts: canonPlan.counts };
      await packs.recordImport(id, {
        at: Date.now(),
        commit: repo.commit,
        status: "ok",
        counts: {
          ...canonPlan.counts,
          imported: imported.length,
          updated: updated.length,
          skipped: skipped.length,
          archived: archived.length,
        },
      });
      await packs.update(id, { updateAvailable: false, available: canonPlan.counts.eligible });
      return result;
    } catch (e) {
      await packs.recordImport(id, {
        at: Date.now(),
        commit: pack.ref,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };
  return withSkillMutationLock(deps, applyFetched);
}

export function createSkillMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  | "listSkills"
  | "getSkill"
  | "archiveSkill"
  | "editSkill"
  | "listVisibleSkills"
  | "skillEditAccess"
  | "skillStanding"
  | "listTurnSkills"
  | "updateOwnedSkill"
  | "restoreOwnedSkill"
  | "listSkillPacks"
  | "getSkillPack"
  | "registerSkillPack"
  | "updateSkillPack"
  | "skillPackCatalog"
  | "importSkillPack"
  | "syncSkillPack"
  | "removeSkillPack"
  | "createOwnedSkill"
  | "deleteOwnedSkill"
> {
  const { skillEditAccessFor, maySkillLiveIn } = h;
  function editSkill(id: string, patch: { description?: string; body?: string }): Promise<Skill | "managed" | null> {
    return withSkillMutationLock(deps, async () => {
      const skill = await deps.skills.get(id);
      if (!skill || skill.status === "archived") return null;
      if (isSourceManagedSkill(skill)) return "managed";
      return deps.skills.update(id, {
        ...skill.manifest,
        description: patch.description ?? skill.manifest.description,
        body: patch.body ?? skill.manifest.body,
      });
    });
  }
  return {
    editSkill,
    listSkills() {
      return deps.skills.list();
    },
    getSkill(id) {
      return deps.skills.get(id);
    },
    archiveSkill(id) {
      return deps.skills.archive(id);
    },
    async listVisibleSkills(principalId) {
      const { ordered, granted } = await skillVisibilityContext(
        deps,
        h,
        principalId,
        (await deps.skills.list()).map((s) => s.scopeId),
      );
      return deps.skills.visibleFor(ordered, granted);
    },
    skillEditAccess(skills, principalId, liveActor) {
      const access = skillEditAccessFor(principalId, liveActor);
      return Promise.all(skills.map(access));
    },
    skillStanding(skill, viewer) {
      return skillStandingsFor(deps, h, viewer)(skill);
    },
    async listTurnSkills(viewer) {
      const org = scopeId("org", orgIdOf());
      const actor = deps.identity.classify(viewer.actorId);
      const own = viewer.scopeId === scopeId("personal", viewer.actorId);
      const teams = own ? (actor.teamIds ?? []).map((t) => scopeId("team", t)) : [];
      const ordered = [...new Set([viewer.scopeId, ...teams, org])];
      const granted = (
        await deps.acl
          .sharedOfKindForAudience("skill", [actor], viewer.scopeId, org, (p, label, sess, orgScope) =>
            own ? principalEntitledToScope(p, label, sess, orgScope) : label === sess || label === orgScope,
          )
          .catch(() => [])
      ).map((g) => ({ id: parseRef(g.ref).id, ownerScopeId: g.ownerScopeId }));
      const visible = (await deps.skills.visibleFor(ordered, granted)).flatMap((r) => (r.skill ? [r.skill] : []));
      const standingOf = skillStandingsFor(deps, h, viewer);
      return Promise.all(
        visible.map(async (skill) => {
          const standing = await standingOf(skill);
          return {
            id: skill.id,
            name: skill.manifest.name,
            description: skill.manifest.description,
            home: standing.home,
            editable: standing.edit === "editable",
            edit: standing.edit,
            owner: standing.owner,
            orgWide: standing.orgWide,
          };
        }),
      );
    },
    async updateOwnedSkill(id, principalId, patch, opts) {
      const skill = await deps.skills.get(id);
      if (!skill) return null;
      const access = await skillEditAccessFor(principalId, opts?.liveActor === true)(skill);
      if (!managesSkill(access)) return null;
      if (access === "needs_live_person") return "trigger_blocked";
      if (skill.status === "archived") return null;
      if (access === "admins_only") return "forbidden";
      const updated = await editSkill(id, patch);
      if (!updated || updated === "managed") return updated;
      const role = await h.skillRoleFor(skill, principalId, { writeGrants: true });
      const org = scopeId("org", orgIdOf());
      const orgWide =
        skill.scopeId === org ||
        (await deps.acl.grantsFor(skill.scopeId, encodeRef(skillRef(id))).catch(() => [])).some(
          (g) => g.granteeScopeId === org,
        );
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "skill_update",
        resource: id,
        scopeLabel: skill.scopeId,
        detail: JSON.stringify({ role, orgWide }),
      });
      return updated;
    },
    async restoreOwnedSkill(id, principalId, opts) {
      const skill = await deps.skills.get(id);
      if (!skill || skill.status !== "archived") return null;
      const access = await skillEditAccessFor(principalId, opts?.liveActor === true)(skill);
      if (!managesSkill(access) || !(await h.skillRoleFor(skill, principalId))) return null;
      if (skill.supersededBy) return "superseded";
      if (access === "needs_live_person") return "trigger_blocked";
      if (access === "admins_only") return "forbidden";
      const all = await deps.skills.list();
      const grants = await deps.acl.list();
      const org = scopeId("org", orgIdOf());
      const taken =
        all.some(
          (s) =>
            s.id !== id &&
            s.scopeId === skill.scopeId &&
            s.manifest.name === skill.manifest.name &&
            s.status === "published",
        ) ||
        skillGrantsOf(skill, grants).some((g) =>
          audienceNameClash({ skill, granteeScopeId: g.granteeScopeId, all, grants, orgScopeId: org }),
        );
      if (taken) return "name_conflict";
      await deps.skills.review(id, principalId, skill.manifest.requiredCapabilities);
      const restored = await deps.skills.publish(id);
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "skill_restore",
        resource: id,
        scopeLabel: skill.scopeId,
      });
      return restored;
    },
    listSkillPacks() {
      return deps.skillPacks ? deps.skillPacks.list() : Promise.resolve([]);
    },
    getSkillPack(id) {
      return deps.skillPacks ? deps.skillPacks.get(id) : Promise.resolve(null);
    },
    async registerSkillPack(input) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.create(input);
      try {
        const repo = await fetcher.fetch(pack);
        const nativeNames = await nativeNamesFor(deps, pack.id, pack.targetScopeId);
        const plan = planIngest(repo, { ...(pack.config ? { config: pack.config } : {}), nativeNames });
        return await packs.update(pack.id, { available: plan.counts.eligible });
      } catch (e) {
        await packs.recordImport(pack.id, {
          at: Date.now(),
          commit: pack.ref,
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        return (await packs.get(pack.id)) ?? pack;
      }
    },
    async updateSkillPack(id, patch) {
      const { packs } = requireRegistry(deps);
      return withSkillMutationLock(deps, () => packs.update(id, patch));
    },
    async skillPackCatalog(id) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.get(id);
      if (!pack) throw new Error(`unknown skill pack: ${id}`);
      const repo = await fetcher.fetch(pack);
      const nativeNames = await nativeNamesFor(deps, id, pack.targetScopeId);
      const plan = planIngest(repo, { ...(pack.config ? { config: pack.config } : {}), nativeNames });
      const bundlePaths = collectSharedBundle(repo, pack.config).map((file) => file.path);
      const importedScopesByUpstream = new Map<string, ScopeId[]>();
      for (const { scopeId, upstreamName } of await importedPackSkills(deps, id)) {
        const arr = importedScopesByUpstream.get(upstreamName) ?? [];
        arr.push(scopeId);
        importedScopesByUpstream.set(upstreamName, arr);
      }
      return {
        ...plan,
        bundlePaths,
        candidates: plan.candidates.map((c) => ({
          ...c,
          importedScopes: importedScopesByUpstream.get(c.upstreamName) ?? [],
        })),
      };
    },
    async importSkillPack(id, selected, scopeIds) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.get(id);
      if (!pack) throw new Error(`unknown skill pack: ${id}`);
      const scopes = scopeIds && scopeIds.length ? scopeIds : [pack.targetScopeId];
      return reconcilePack(
        deps,
        packs,
        fetcher,
        id,
        scopes.map((scopeId) => ({ scopeId, selected })),
      );
    },
    async syncSkillPack(id) {
      const { packs, fetcher } = requireRegistry(deps);
      const pack = await packs.get(id);
      if (!pack) throw new Error(`unknown skill pack: ${id}`);
      const importedByScope = new Map<ScopeId, string[]>();
      for (const { scopeId, upstreamName } of await importedPackSkills(deps, id)) {
        const arr = importedByScope.get(scopeId) ?? [];
        arr.push(upstreamName);
        importedByScope.set(scopeId, arr);
      }
      const targets = [...importedByScope].map(([scopeId, selected]) => ({ scopeId, selected }));
      if (!targets.length) targets.push({ scopeId: pack.targetScopeId, selected: [] });
      return reconcilePack(deps, packs, fetcher, id, targets);
    },
    async removeSkillPack(id) {
      const { packs } = requireRegistry(deps);
      return withSkillMutationLock(deps, async () => {
        const mine = (await deps.skills.list()).filter((s) => s.createdBy === `pack:${id}`);
        for (const s of mine) await deps.skills.delete(s.id);
        await deps.skillBundles?.delete(id);
        await packs.remove(id);
        return { removed: mine.length };
      });
    },
    async createOwnedSkill(input) {
      const name = input.name.trim();
      const description = input.description.trim();
      const body = input.body.trim();
      if (!name || !description || !body) throw new Error("skill requires a non-empty name, description, and body");
      const homeScope = input.homeScope ?? scopeId("personal", input.principalId);
      const homeKind = parseScopeId(homeScope).kind;
      if (homeKind !== "personal" && homeKind !== "channel" && homeKind !== "group") {
        throw new Error(
          "a skill cannot be created directly in an org or team scope — promote a published skill instead",
        );
      }
      if (!(await maySkillLiveIn(homeScope, input.principalId))) return "forbidden";
      const existing = (await deps.skills.list()).find((s) => s.scopeId === homeScope && s.manifest.name === name);
      if (existing && existing.status !== "archived") return null;
      if (existing) await deps.skills.delete(existing.id);
      const manifest: SkillManifest = {
        name,
        description,
        requiredCapabilities: input.requiredCapabilities ?? [],
        body,
      };
      const skill = await deps.skills.create({
        scopeId: homeScope,
        manifest,
        createdBy: input.principalId,
        ownerId: input.principalId,
      });
      await deps.skills.review(skill.id, "system:skill-authoring", manifest.requiredCapabilities);
      const published = await deps.skills.publish(skill.id);
      deps.auditLog.record({
        at: Date.now(),
        principalId: input.principalId,
        action: "skill_create",
        resource: skill.id,
        scopeLabel: homeScope,
      });
      return published;
    },
    async deleteOwnedSkill({ principalId, id, liveActor }) {
      const skill = await deps.skills.get(id);
      if (!skill) return "missing";
      const access = await skillEditAccessFor(principalId, liveActor === true)(skill);
      if (!managesSkill(access) || !(await h.skillRoleFor(skill, principalId))) return "forbidden";
      if (skill.supersededBy) return "superseded";
      if (access === "needs_live_person") return "trigger_blocked";
      if (access === "admins_only") return "admins_only";
      if (!(await h.mayTakeSkillFromOrg(skill, principalId))) return "org_admins_only";
      await deps.skills.archive(id);
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "skill_archive",
        resource: id,
        scopeLabel: skill.scopeId,
      });
      return "deleted";
    },
  };
}
