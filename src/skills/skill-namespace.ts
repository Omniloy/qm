import { parseScopeId, type Grant, type ScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { encodeRef, parseRef, skillRef } from "../acl/resource-ref.ts";
import type { AuditEvent } from "../audit/audit-log.ts";
import { effectiveSkillOwner } from "./skill-rights.ts";
import { PLATFORM_SKILL_AUTHOR, type Skill, type SkillManifest } from "./skill-store.ts";

export function skillGrantsOf(skill: Pick<Skill, "id" | "scopeId">, grants: readonly Grant[]): Grant[] {
  const ref = encodeRef(skillRef(skill.id));
  return grants.filter((g) => g.ref === ref && g.ownerScopeId === skill.scopeId);
}

export interface SkillWriteGrant {
  skillId: string;
  name?: string;
  ownerScopeId: ScopeId;
  granteeScopeId: ScopeId;
}

export function skillWriteGrants(skills: readonly Skill[], grants: readonly Grant[]): SkillWriteGrant[] {
  const names = new Map(skills.map((s) => [s.id, s.manifest.name]));
  return grants.flatMap((g) => {
    const ref = parseRef(g.ref);
    if (ref.kind !== "skill" || g.permission !== "write") return [];
    const name = names.get(ref.id);
    return [
      {
        skillId: ref.id,
        ...(name ? { name } : {}),
        ownerScopeId: g.ownerScopeId,
        granteeScopeId: g.granteeScopeId,
      },
    ];
  });
}

export function audienceNameClash(input: {
  skill: Pick<Skill, "id" | "manifest">;
  granteeScopeId: ScopeId;
  all: readonly Skill[];
  grants: readonly Grant[];
  orgScopeId: ScopeId;
}): Skill | null {
  const { skill, granteeScopeId, orgScopeId } = input;
  const audiences = new Set([granteeScopeId, orgScopeId]);
  return (
    input.all.find(
      (s) =>
        s.id !== skill.id &&
        (s.status === "published" || (s.scopeId === orgScopeId && PLATFORM_SKILL_AUTHOR.test(s.createdBy))) &&
        s.manifest.name === skill.manifest.name &&
        (audiences.has(s.scopeId) || skillGrantsOf(s, input.grants).some((g) => audiences.has(g.granteeScopeId))),
    ) ?? null
  );
}

export interface ManifestDiff {
  description: boolean;
  bodyDeltaChars: number;
  files: string[];
}

export function manifestDiff(a: SkillManifest, b: SkillManifest): ManifestDiff {
  const filesOf = (m: SkillManifest) => new Map((m.files ?? []).map((f) => [f.path, f.content]));
  const fa = filesOf(a);
  const fb = filesOf(b);
  const paths = [...new Set([...fa.keys(), ...fb.keys()])].filter((p) => fa.get(p) !== fb.get(p)).sort();
  return {
    description: a.description !== b.description,
    bodyDeltaChars: b.body.length - a.body.length,
    files: paths,
  };
}

export interface DuplicateRow {
  id: string;
  scopeId: ScopeId;
  ownerId?: string;
  createdBy: string;
  status: Skill["status"];
  version: number;
  signature: string;
  grants: number;
  updatedAt?: number;
}

export interface DuplicateAction {
  method: "POST";
  path: string;
  body?: Record<string, unknown>;
}

export interface DuplicateCluster {
  name: string;
  status: "auto" | "needs_approval" | "ambiguous";
  canonical: DuplicateRow | null;
  retire: DuplicateRow[];
  purge: DuplicateRow[];
  evidence: string[];
  diff: ManifestDiff | null;
  actions: DuplicateAction[];
}

export interface DuplicateReport {
  clusters: DuplicateCluster[];
  nameClashes: Array<{ name: string; rows: DuplicateRow[]; note?: string }>;
  archivedLeftovers: DuplicateRow[];
  writeGrants: SkillWriteGrant[];
  ownerBackfill: { pending: number; personalHomeMismatch: DuplicateRow[] };
}

export function ownerBackfillFor(skill: Skill): string | undefined {
  const owner = effectiveSkillOwner(skill);
  return owner && !samePerson(owner, skill.ownerId) ? owner : undefined;
}

export function personalHomeMismatch(skill: Skill): boolean {
  const { kind, ref } = parseScopeId(skill.scopeId);
  return (
    kind === "personal" &&
    !PLATFORM_SKILL_AUTHOR.test(skill.createdBy) &&
    (!samePerson(ref, skill.createdBy) || (skill.ownerId !== undefined && !samePerson(ref, skill.ownerId)))
  );
}

const newest = (rows: Skill[]): Skill =>
  rows.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a), rows[0]!);

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function planSkillDuplicates(input: {
  skills: readonly Skill[];
  grants: readonly Grant[];
  promotes: readonly AuditEvent[];
  orgScopeId: ScopeId;
}): DuplicateReport {
  const { orgScopeId } = input;
  const row = (s: Skill): DuplicateRow => ({
    id: s.id,
    scopeId: s.scopeId,
    ...(s.ownerId ? { ownerId: s.ownerId } : {}),
    createdBy: s.createdBy,
    status: s.status,
    version: s.version,
    signature: s.signature,
    grants: skillGrantsOf(s, input.grants).length,
    ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
  });
  const report: DuplicateReport = {
    clusters: [],
    nameClashes: [],
    archivedLeftovers: [],
    writeGrants: skillWriteGrants(input.skills, input.grants),
    ownerBackfill: {
      pending: input.skills.filter((s) => ownerBackfillFor(s) !== undefined).length,
      personalHomeMismatch: input.skills.filter(personalHomeMismatch).map(row),
    },
  };
  const byName = new Map<string, Skill[]>();
  for (const s of input.skills) {
    if (s.supersededBy) continue;
    byName.set(s.manifest.name, [...(byName.get(s.manifest.name) ?? []), s]);
  }
  const isOrg = (s: Skill) => s.scopeId === orgScopeId;
  const promoteOf = (s: Skill) => input.promotes.find((e) => e.resource === s.id && e.scopeLabel === orgScopeId);
  for (const [name, rows] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < 2) continue;
    const clash = (clashing: Skill[], note?: string) => {
      const known = report.nameClashes.find((n) => n.name === name);
      if (!known) {
        report.nameClashes.push({ name, rows: clashing.map(row), ...(note ? { note } : {}) });
        return;
      }
      const seen = new Set(known.rows.map((r) => r.id));
      known.rows.push(...clashing.filter((s) => !seen.has(s.id)).map(row));
    };
    const org = rows.filter((s) => isOrg(s) && !PLATFORM_SKILL_AUTHOR.test(s.createdBy));
    const seeds = rows.filter((s) => isOrg(s) && PLATFORM_SKILL_AUTHOR.test(s.createdBy) && s.status === "published");
    const src = rows.filter((s) => !isOrg(s) && s.status === "published");
    if (seeds.length && src.length) clash([...seeds, ...src], "overrides a built-in skill");
    if (!org.length) {
      if (src.length > 1) clash(src);
      continue;
    }
    if (!src.length) {
      const lineage = (s: Skill) =>
        isOrg(s) || promoteOf(s) !== undefined || org.some((o) => samePerson(o.createdBy, s.createdBy));
      const allArchived = rows.every((s) => s.status === "archived");
      const leftovers = allArchived ? rows.filter(lineage) : org.filter((o) => o.status === "archived");
      report.archivedLeftovers.push(...leftovers.map(row));
      continue;
    }
    const evidence: string[] = [];
    let linked = src.filter((s) => promoteOf(s));
    for (const s of linked) evidence.push(`audit skill_promote ${s.id}→org ${day(promoteOf(s)!.at)}`);
    if (!linked.length) {
      linked = src.filter((s) => org.some((o) => samePerson(o.createdBy, s.createdBy)));
      if (linked.length) evidence.push("same createdBy");
    }
    if (linked.length > 1) {
      const identical = linked.filter((s) => org.some((o) => o.signature === s.signature));
      if (identical.length) {
        linked = identical;
        evidence.push("identical content");
      }
    }
    if (linked.length !== 1) {
      report.clusters.push({
        name,
        status: "ambiguous",
        canonical: null,
        retire: org.filter((o) => o.status === "published").map(row),
        purge: org.filter((o) => o.status === "archived").map(row),
        evidence: [...evidence, `${linked.length} candidate sources`],
        diff: null,
        actions: [],
      });
      continue;
    }
    const canonical = linked[0]!;
    const others = src.filter((s) => s.id !== canonical.id);
    if (others.length) clash([canonical, ...others]);
    const pubOrg = org.filter((o) => o.status === "published");
    const archOrg = org.filter((o) => o.status === "archived");
    const auto = pubOrg.every((o) => o.signature === canonical.signature);
    report.clusters.push({
      name,
      status: auto ? "auto" : "needs_approval",
      canonical: row(canonical),
      retire: pubOrg.map(row),
      purge: archOrg.map(row),
      evidence,
      diff: auto || !pubOrg.length ? null : manifestDiff(newest(pubOrg).manifest, canonical.manifest),
      actions: [
        ...pubOrg.map((o): DuplicateAction => ({
          method: "POST",
          path: `/v1/admin/skills/${o.id}/merge`,
          body: { into: canonical.id, ...(auto ? {} : { force: true }) },
        })),
        ...archOrg.map((o): DuplicateAction => ({ method: "POST", path: `/v1/admin/skills/${o.id}/purge` })),
      ],
    });
  }
  return report;
}
