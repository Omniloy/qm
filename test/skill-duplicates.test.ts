import { test } from "node:test";
import assert from "node:assert/strict";
import { planSkillDuplicates } from "../src/skills/skill-namespace.ts";
import type { Skill } from "../src/skills/skill-store.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import type { Grant } from "../src/types.ts";

const ORG = "org:omniloy";
let at = 1;
const row = (id: string, name: string, scopeId: string, over: Partial<Skill> & { body?: string } = {}): Skill => ({
  id,
  scopeId,
  manifest: { name, description: name, requiredCapabilities: [], body: over.body ?? `# ${name}` },
  signature: over.signature ?? `sig-${name}`,
  status: "published",
  createdBy: "enrique",
  version: 1,
  grantedCapabilities: [],
  approvals: [],
  updatedAt: at++,
  ...over,
});
const promote = (resource: string): AuditEvent => ({
  at: Date.UTC(2026, 8, 12),
  principalId: "admin",
  action: "skill_promote",
  resource,
  scopeLabel: ORG,
});

const skills: Skill[] = [
  row("1f0e", "slides", "personal:sergio", { createdBy: "sergio" }),
  row("621e", "slides", ORG, { createdBy: "sergio" }),
  row("f1fc", "slides", ORG, { createdBy: "sergio", status: "archived" }),
  row("c7dd", "jira", "personal:noe", { createdBy: "noe" }),
  row("j-org", "jira", ORG, { createdBy: "noe" }),
  row("4531", "laberit", "channel:CLAB"),
  row("l-org", "laberit", ORG),
  row("76b1", "granola", "personal:enrique"),
  row("851", "granola", ORG),
  row("ff3e", "granola", "personal:sergio", { createdBy: "sergio", signature: "sig-granola-sergio" }),
  row("v4", "videos", "channel:CVID", { createdBy: "noe", signature: "sig-v4", body: "# videos v4 longer body" }),
  row("v1", "videos", ORG, { createdBy: "noe", signature: "sig-v1", body: "# videos v1" }),
  row("olivia-src", "olivia", "personal:enrique"),
  row("829b", "olivia", ORG, { status: "archived" }),
  row("smoke-a", "share-smoke-test", "personal:enrique", { status: "archived" }),
  row("smoke-b", "share-smoke-test", ORG, { status: "archived" }),
  row("seed", "digest", ORG, { createdBy: "system:skills-seed" }),
  row("digest-mine", "digest", "personal:enrique", { signature: "sig-digest-mine" }),
  row("amb-org", "triage", ORG, { createdBy: "ana", signature: "sig-org" }),
  row("amb-1", "triage", "personal:ana", { createdBy: "ana", signature: "sig-1" }),
  row("amb-2", "triage", "channel:CANA", { createdBy: "ana", signature: "sig-2" }),
  row("old", "slides", ORG, { status: "archived", supersededBy: "1f0e" }),
  row("stranger-a", "stranger-notes", "personal:ana", { createdBy: "ana", status: "archived" }),
  row("stranger-b", "stranger-notes", "personal:bob", { createdBy: "bob", status: "archived" }),
  row("unrelated-arch", "share-smoke-test", "personal:bob", { createdBy: "bob", status: "archived" }),
];
const grants: Grant[] = [
  { ownerScopeId: ORG, ref: "skill:621e", granteeScopeId: "channel:CSQUAD", permission: "read", grantedBy: "x" },
  {
    ownerScopeId: "channel:CLAB",
    ref: "skill:4531",
    granteeScopeId: "channel:CX",
    permission: "write",
    grantedBy: "x",
  },
];
const report = planSkillDuplicates({
  skills,
  grants,
  promotes: [promote("1f0e"), promote("76b1"), promote("v4"), promote("olivia-src")],
  orgScopeId: ORG,
});
const cluster = (name: string) => report.clusters.find((c) => c.name === name)!;

test("slides: the promoted source is kept, its identical org copy is retired and the archived copy purged", () => {
  const slides = cluster("slides");
  assert.equal(slides.status, "auto");
  assert.equal(slides.canonical?.id, "1f0e");
  assert.deepEqual(
    slides.retire.map((r) => r.id),
    ["621e"],
  );
  assert.equal(slides.retire[0]!.grants, 1);
  assert.deepEqual(
    slides.purge.map((r) => r.id),
    ["f1fc"],
  );
  assert.match(slides.evidence[0]!, /audit skill_promote 1f0e→org 2026-09-12/);
  assert.deepEqual(slides.actions, [
    { method: "POST", path: "/v1/admin/skills/621e/merge", body: { into: "1f0e" } },
    { method: "POST", path: "/v1/admin/skills/f1fc/purge" },
  ]);
});

test("jira and laberit merge automatically on authorship when no promotion was audited", () => {
  assert.equal(cluster("jira").status, "auto");
  assert.equal(cluster("jira").canonical?.id, "c7dd");
  assert.deepEqual(cluster("jira").evidence, ["same createdBy"]);
  assert.equal(cluster("laberit").status, "auto");
  assert.equal(cluster("laberit").canonical?.id, "4531");
});

test("granola: the promoted copy merges, and an unrelated personal skill of the same name is only reported", () => {
  assert.equal(cluster("granola").status, "auto");
  assert.equal(cluster("granola").canonical?.id, "76b1");
  assert.deepEqual(
    cluster("granola").retire.map((r) => r.id),
    ["851"],
  );
  const clash = report.nameClashes.find((n) => n.name === "granola")!;
  assert.ok(clash.rows.some((r) => r.id === "ff3e"));
});

test("videos: a copy that drifted from its source needs the owner's approval and shows what differs", () => {
  const videos = cluster("videos");
  assert.equal(videos.status, "needs_approval");
  assert.equal(videos.canonical?.id, "v4");
  assert.deepEqual(videos.diff, { description: false, bodyDeltaChars: 12, files: [] });
  assert.deepEqual(videos.actions, [
    { method: "POST", path: "/v1/admin/skills/v1/merge", body: { into: "v4", force: true } },
  ]);
});

test("olivia: only an archived org copy is left, so the plan purges it", () => {
  assert.equal(cluster("olivia").status, "auto");
  assert.deepEqual(cluster("olivia").retire, []);
  assert.deepEqual(
    cluster("olivia").purge.map((r) => r.id),
    ["829b"],
  );
});

test("a name whose every copy is archived is an archived leftover, and superseded rows are ignored", () => {
  assert.deepEqual(report.archivedLeftovers.map((r) => r.id).sort(), ["smoke-a", "smoke-b"]);
  assert.ok(
    !report.archivedLeftovers.some((r) => r.id.startsWith("stranger") || r.id === "unrelated-arch"),
    "someone else's archived personal skill is never offered for purge",
  );
  assert.ok(!JSON.stringify(report).includes('"old"'));
});

test("the report lists every skill write grant", () => {
  assert.deepEqual(report.writeGrants, [
    { skillId: "4531", name: "laberit", ownerScopeId: "channel:CLAB", granteeScopeId: "channel:CX" },
  ]);
});

test("a name is listed as a clash once even when it clashes with a built-in and with other copies", () => {
  const planned = planSkillDuplicates({
    skills: [
      row("seed2", "brief", ORG, { createdBy: "system:skills-seed" }),
      row("b1", "brief", "personal:ana", { createdBy: "ana", signature: "sig-b1" }),
      row("b2", "brief", "personal:bob", { createdBy: "bob", signature: "sig-b2" }),
    ],
    grants: [],
    promotes: [],
    orgScopeId: ORG,
  });
  const briefs = planned.nameClashes.filter((n) => n.name === "brief");
  assert.equal(briefs.length, 1);
  assert.deepEqual(briefs[0]!.rows.map((r) => r.id).sort(), ["b1", "b2", "seed2"]);
});

test("a built-in with the same name is reported as a clash and never merged", () => {
  assert.equal(
    report.clusters.find((c) => c.name === "digest"),
    undefined,
  );
  const digest = report.nameClashes.find((n) => n.name === "digest")!;
  assert.equal(digest.note, "overrides a built-in skill");
});

test("two candidate sources by the same author with no identical content stay ambiguous, with no actions", () => {
  const triage = cluster("triage");
  assert.equal(triage.status, "ambiguous");
  assert.equal(triage.canonical, null);
  assert.deepEqual(triage.actions, []);
});

test("the owner backfill counts skills with no recorded owner and flags personal skills created by someone else", () => {
  const planned = planSkillDuplicates({
    skills: [
      row("a", "a", "personal:ana", { createdBy: "bob" }),
      row("b", "b", "channel:C", { ownerId: "bob", createdBy: "bob" }),
      row("c", "c", ORG, { createdBy: "system:skills-seed" }),
    ],
    grants: [],
    promotes: [],
    orgScopeId: ORG,
  });
  assert.equal(planned.ownerBackfill.pending, 1);
  assert.deepEqual(
    planned.ownerBackfill.personalHomeMismatch.map((r) => r.id),
    ["a"],
  );
});
