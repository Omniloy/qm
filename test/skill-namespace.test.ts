import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceNameClash, manifestDiff } from "../src/skills/skill-namespace.ts";
import type { Skill } from "../src/skills/skill-store.ts";
import type { Grant } from "../src/types.ts";

const ORG = "org:acme";
const skill = (id: string, scopeId: string, over: Partial<Skill> = {}): Skill => ({
  id,
  scopeId,
  manifest: { name: "slides", description: "d", requiredCapabilities: [], body: "b" },
  signature: id,
  status: "published",
  createdBy: "someone",
  version: 1,
  grantedCapabilities: [],
  approvals: [],
  ...over,
});
const grant = (s: Skill, granteeScopeId: string, ownerScopeId = s.scopeId): Grant => ({
  ownerScopeId,
  ref: `skill:${s.id}`,
  granteeScopeId,
  permission: "read",
  grantedBy: "x",
});
const clash = (target: Skill, grantee: string, all: Skill[], grants: Grant[] = []) =>
  audienceNameClash({ skill: target, granteeScopeId: grantee, all, grants, orgScopeId: ORG })?.id ?? null;

test("org-wide clashes with a published org-home copy, another org grant, or a built-in that reserves the name", () => {
  const mine = skill("mine", "personal:u1");
  assert.equal(clash(mine, ORG, [mine, skill("orgcopy", ORG)]), "orgcopy");
  const theirs = skill("theirs", "personal:u2");
  assert.equal(clash(mine, ORG, [mine, theirs], [grant(theirs, ORG)]), "theirs");
  const seed = skill("seed", ORG, { status: "archived", createdBy: "system:skills-seed" });
  assert.equal(clash(mine, ORG, [mine, seed]), "seed", "an archived built-in still reserves its name");
  assert.equal(clash(mine, ORG, [mine, skill("old", ORG, { status: "archived" })]), null);
});

test("sharing into a channel clashes with a skill homed there, granted there, or visible org-wide", () => {
  const mine = skill("mine", "personal:u1");
  const there = skill("there", "channel:C");
  assert.equal(clash(mine, "channel:C", [mine, there]), "there");
  const granted = skill("granted", "personal:u2");
  assert.equal(clash(mine, "channel:C", [mine, granted], [grant(granted, "channel:C")]), "granted");
  assert.equal(clash(mine, "channel:C", [mine, skill("org", ORG)]), "org");
  assert.equal(clash(mine, "channel:C", [mine, skill("elsewhere", "channel:D")]), null);
});

test("a personal target clashes with that person's own same-name skill; stale grants never count", () => {
  const mine = skill("mine", "personal:u1");
  assert.equal(clash(mine, "personal:u2", [mine, skill("own", "personal:u2")]), "own");
  const moved = skill("moved", "channel:NEW");
  assert.equal(clash(mine, "personal:u2", [mine, moved], [grant(moved, "personal:u2", "channel:OLD")]), null);
});

test("the manifest diff reports description, body size and changed files", () => {
  const a = {
    name: "x",
    description: "one",
    requiredCapabilities: [],
    body: "12345",
    files: [{ path: "a", content: "1" }],
  };
  const b = {
    ...a,
    description: "two",
    body: "1234567",
    files: [
      { path: "a", content: "2" },
      { path: "b", content: "" },
    ],
  };
  assert.deepEqual(manifestDiff(a, b), { description: true, bodyDeltaChars: 2, files: ["a", "b"] });
});
