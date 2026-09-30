import assert from "node:assert/strict";
import test from "node:test";
import type { SkillItem } from "../src/composer.ts";
import {
  filterSkillGroups,
  filterSkills,
  groupSkills,
  matchSkills,
  otherHomes,
  skillEmptyState,
  skillHomeLabel,
  statusCounts,
} from "../src/skill-registry.ts";

function skill(overrides: Partial<SkillItem> = {}): SkillItem {
  return {
    id: "skill-1",
    name: "deploy",
    description: "Ship an application",
    scope: "org",
    source: "native",
    status: "published",
    ...overrides,
  };
}

test("groups same-name active and archived variants without inventing a global winner", () => {
  const groups = groupSkills([
    skill({ id: "archived", scope: "personal", scopeId: "personal:jordan", status: "archived" }),
    skill({ id: "org", scope: "org", scopeId: "org:acme", shadowed: true }),
    skill({ id: "other", name: "browse" }),
  ]);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["browse", "deploy"],
  );
  assert.deepEqual(
    groups[1]!.skills.map((row) => row.id),
    ["org", "archived"],
  );
});

test("keeps case-distinct skill names in separate groups", () => {
  const groups = groupSkills([skill({ id: "upper", name: "Deploy" }), skill({ id: "lower", name: "deploy" })]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.name).sort(), ["Deploy", "deploy"]);
  assert.deepEqual(groups.flatMap((group) => group.skills.map((row) => row.id)).sort(), ["lower", "upper"]);
});

test("scope filtering keeps the matching variant and overrides filtering keeps the whole collision group", () => {
  const groups = groupSkills([
    skill({ id: "personal", scope: "personal", shadowed: true }),
    skill({ id: "org", scope: "org" }),
  ]);
  const filtered = filterSkillGroups(groups, { query: "", scope: "org", source: "all", status: "active" });
  assert.deepEqual(
    filtered[0]!.skills.map((row) => row.id),
    ["org"],
  );
  const overrides = filterSkillGroups(groups, { query: "", scope: "all", source: "overrides", status: "active" });
  assert.deepEqual(
    overrides[0]!.skills.map((row) => row.id),
    ["personal", "org"],
  );
});

test("filters by status, scope, source, override, and searchable metadata", () => {
  const skills = [
    skill({ id: "active", scope: "personal", scopeId: "personal:jordan", shadowed: true }),
    skill({
      id: "archived",
      status: "archived",
      source: "pack",
      pack: { packId: "p", commit: "c", upstreamName: "tools" },
    }),
  ];
  assert.deepEqual(
    filterSkills(skills, { query: "jordan", scope: "personal", source: "overrides", status: "active" }).map(
      (row) => row.id,
    ),
    ["active"],
  );
  assert.deepEqual(
    filterSkills(skills, { query: "tools", scope: "all", source: "pack", status: "archived" }).map((row) => row.id),
    ["archived"],
  );
  assert.deepEqual(filterSkills(skills, { query: "missing", scope: "all", source: "all", status: "all" }), []);
});

test("counts active and archived skill variants", () => {
  assert.deepEqual(statusCounts([skill(), skill({ id: "a", status: "archived" }), skill({ id: "b" })]), {
    active: 2,
    archived: 1,
    all: 3,
  });
});

test("empty-state decisions distinguish loading, a filtered miss, and a truly empty catalog", () => {
  assert.equal(skillEmptyState(0, 0, true), "loading");
  assert.equal(skillEmptyState(4, 0, false), "filtered");
  assert.equal(skillEmptyState(0, 0, false), "empty");
  assert.equal(skillEmptyState(4, 2, false), "none");
});

function catalog(): SkillItem[] {
  const rows: SkillItem[] = [];
  const add = (count: number, scope: string, scopeId: string, prefix: string) => {
    for (let i = 0; i < count; i++) rows.push(skill({ id: `${prefix}-${i}`, name: `${prefix}-${i}`, scope, scopeId }));
  };
  add(26, "org", "org:acme", "org");
  add(8, "personal", "personal:me@acme.com", "mine");
  add(4, "channel", "channel:C1", "sales");
  add(1, "channel", "channel:C2", "ops");
  add(8, "group", "group:web-project-1", "proj");
  add(3, "personal", "personal:peer@acme.com", "peer");
  rows.push(
    skill({ id: "gone", name: "gone", scope: "personal", scopeId: "personal:me@acme.com", status: "archived" }),
  );
  return rows;
}

test("every visible skill is listed when no filter is chosen, and the tab counts match the list", () => {
  const rows = catalog();
  const filters = { query: "", scope: "all", source: "all", status: "active" as const };
  const groups = filterSkillGroups(groupSkills(rows), filters);
  assert.equal(groups.flatMap((group) => group.skills).length, 50);
  assert.equal(groups.length, 50);
  assert.deepEqual(statusCounts(rows), { active: 50, archived: 1, all: 51 });
});

test("a conversation's context filter keeps that context's skills and the org-wide ones", () => {
  const rows = catalog();
  const filters = { query: "", scope: "personal:me@acme.com", source: "all", status: "active" as const };
  const visible = filterSkillGroups(groupSkills(rows), filters).flatMap((group) => group.skills);
  assert.equal(visible.length, 34);
  assert.ok(visible.every((row) => row.scope === "org" || row.scopeId === "personal:me@acme.com"));
  const counted = filterSkillGroups(groupSkills(rows), { ...filters, status: "all" }).flatMap((group) => group.skills);
  assert.deepEqual(statusCounts(counted), { active: 34, archived: 1, all: 35 });
});

test("a skill's home names where the copy lives", () => {
  const title = (scopeId: string) => (scopeId === "channel:C1" ? "#sales" : `Project ${scopeId}`);
  const home = (overrides: Partial<SkillItem>) => skillHomeLabel(skill(overrides), "me@acme.com", title);
  assert.equal(home({ scope: "org", scopeId: "org:acme" }), "Org");
  assert.equal(home({ scope: "personal", scopeId: "personal:me@acme.com" }), "Personal");
  assert.equal(home({ scope: "personal", scopeId: "personal:ana.lopez@acme.com" }), "Shared by Ana Lopez");
  assert.equal(home({ scope: "channel", scopeId: "channel:C1" }), "#sales");
  assert.equal(home({ scope: "group", scopeId: "group:p" }), "Project group:p");
  assert.equal(home({ scope: "team", scopeId: "team:t" }), "Team");
});

test("other homes list the active copies of the same skill elsewhere", () => {
  const org = skill({ id: "org", scope: "org", scopeId: "org:acme" });
  const mine = skill({ id: "mine", scope: "personal", scopeId: "personal:me@acme.com" });
  const channel = skill({ id: "chan", scope: "channel", scopeId: "channel:C1" });
  const archived = skill({ id: "old", scope: "group", scopeId: "group:p", status: "archived" });
  const variants = [mine, channel, org, archived];
  assert.deepEqual(
    otherHomes(mine, variants).map((row) => row.id),
    ["chan", "org"],
  );
  assert.deepEqual(
    otherHomes(archived, variants).map((row) => row.id),
    ["mine", "chan", "org"],
  );
  assert.deepEqual(otherHomes(org, [org]), []);
});

test("the composer picker never offers an archived skill, with or without a query", () => {
  const skills = [
    skill({ id: "live", name: "deploy" }),
    skill({ id: "gone", name: "deploy-old", status: "archived" }),
    skill({ id: "other", name: "redeploy" }),
  ];
  assert.deepEqual(
    matchSkills("", skills).map((m) => m.skill.id),
    ["live", "other"],
  );
  const matches = matchSkills("DEPLOY", skills);
  assert.deepEqual(
    matches.map((m) => [m.skill.id, m.start, m.end]),
    [
      ["live", 0, 6],
      ["other", 2, 8],
    ],
  );
});

test("the composer picker labels a personal skill by whose it is, not just its scope kind", () => {
  const titleFor = (scopeId: string) => (scopeId === "channel:C1" ? "#ops" : scopeId);
  const label = (over: Partial<SkillItem>) => skillHomeLabel(skill(over), "me@acme.com", titleFor);
  assert.equal(label({ scope: "personal", scopeId: "personal:me@acme.com" }), "Personal");
  assert.equal(label({ scope: "personal", scopeId: "personal:sergio.ruiz@acme.com" }), "Shared by Sergio Ruiz");
  assert.equal(label({ scope: "channel", scopeId: "channel:C1" }), "#ops");
  assert.equal(label({ scope: "org", scopeId: "org:acme" }), "Org");
});
