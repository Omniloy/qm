import { test } from "node:test";
import assert from "node:assert/strict";
import { createSkillRights, effectiveSkillOwner, triggerBlocksSkillChange } from "../src/skills/skill-rights.ts";
import type { Skill } from "../src/skills/skill-store.ts";
import type { Grant } from "../src/types.ts";

const skill = (over: Partial<Skill>): Skill => ({
  id: "s1",
  scopeId: "personal:owner",
  manifest: { name: "s", description: "d", requiredCapabilities: [], body: "b" },
  signature: "sig",
  status: "published",
  createdBy: "owner",
  version: 1,
  grantedCapabilities: [],
  approvals: [],
  ...over,
});

function rights(opts: {
  members?: Record<string, string[]>;
  admins?: string[];
  inactive?: string[];
  grants?: Grant[];
}) {
  return createSkillRights({
    isActivePerson: (p) => !(opts.inactive ?? []).includes(p),
    isHomeMember: async (p, scope) => (opts.members?.[scope] ?? []).includes(p),
    isOrgAdmin: async (p) => (opts.admins ?? []).includes(p),
    grantsOf: async () => opts.grants ?? [],
  });
}

const grant = (over: Partial<Grant>): Grant => ({
  ownerScopeId: "personal:owner",
  ref: "skill:s1",
  granteeScopeId: "org:acme",
  permission: "read",
  grantedBy: "owner",
  ...over,
});

test("the owner is the owner; a deactivated owner has no role at all", async () => {
  const s = skill({});
  assert.equal(await rights({}).roleFor(s, "owner"), "owner");
  assert.equal(await rights({ inactive: ["owner"] }).roleFor(s, "owner"), null);
});

test("any current member of a private or public channel home, or a group home, is a home member", async () => {
  const members = { "channel:CPRIV": ["m1"], "channel:CPUB": ["m2"], "group:G1": ["m3"] };
  const r = rights({ members });
  assert.equal(await r.roleFor(skill({ scopeId: "channel:CPRIV", ownerId: "owner" }), "m1"), "home_member");
  assert.equal(await r.roleFor(skill({ scopeId: "channel:CPUB", ownerId: "owner" }), "m2"), "home_member");
  assert.equal(await r.roleFor(skill({ scopeId: "group:G1", ownerId: "owner" }), "m3"), "home_member");
  assert.equal(await r.roleFor(skill({ scopeId: "channel:CPRIV", ownerId: "owner" }), "m2"), null);
});

test("an admin manages a personal skill only once it is shared; shared homes always", async () => {
  const personal = skill({});
  assert.equal(await rights({ admins: ["a"] }).roleFor(personal, "a"), null);
  assert.equal(await rights({ admins: ["a"], grants: [grant({})] }).roleFor(personal, "a"), "admin");
  assert.equal(
    await rights({ admins: ["a"], grants: [grant({ ownerScopeId: "channel:OLD" })] }).roleFor(personal, "a"),
    null,
    "a stale grant keyed on an old home does not count",
  );
  assert.equal(await rights({ admins: ["a"] }).roleFor(skill({ scopeId: "channel:C" }), "a"), "admin");
});

test("a write grantee edits only when write grants are honoured and they are a member of the grantee", async () => {
  const s = skill({ scopeId: "channel:C", ownerId: "owner" });
  const r = rights({
    grants: [grant({ ownerScopeId: "channel:C", granteeScopeId: "channel:D", permission: "write" })],
    members: { "channel:D": ["w"] },
  });
  assert.equal(await r.roleFor(s, "w"), null);
  assert.equal(await r.roleFor(s, "w", { writeGrants: true }), "write_grantee");
  assert.equal(await r.roleFor(s, "reader", { writeGrants: true }), null, "reading a public channel is not membership");
  assert.equal(await r.manages(s, "w"), false, "a write grantee never shares, moves or archives");
});

test("a personal write grant is that one person's, and an org write grant never lets anyone edit", async () => {
  const s = skill({ scopeId: "channel:C", ownerId: "owner" });
  const r = rights({
    grants: [
      grant({ ownerScopeId: "channel:C", granteeScopeId: "personal:ana", permission: "write" }),
      grant({ ownerScopeId: "channel:C", granteeScopeId: "org:acme", permission: "write" }),
    ],
  });
  assert.equal(await r.roleFor(s, "ana", { writeGrants: true }), "write_grantee");
  assert.equal(await r.roleFor(s, "bob", { writeGrants: true }), null);
});

test("under a key that is not the skill's home, members may only revoke; only the owner or an admin may grant", async () => {
  const s = skill({ scopeId: "personal:owner" });
  const r = rights({ members: { "channel:OLD": ["m"] }, admins: ["a"] });
  assert.equal(await r.managesGrantKey(s, "m", "channel:OLD", "revoke"), true);
  assert.equal(await r.managesGrantKey(s, "m", "channel:OLD", "grant"), false);
  assert.equal(await r.managesGrantKey(s, "outsider", "personal:outsider", "grant"), false);
  assert.equal(await r.managesGrantKey(s, "outsider", "personal:outsider", "revoke"), true);
  assert.equal(await r.managesGrantKey(s, "owner", "channel:OLD", "grant"), true);
  assert.equal(await r.managesGrantKey(s, "a", "channel:OLD", "grant"), true);
});

test("a personal home's owner is always that person, whatever createdBy or a stale ownerId say", () => {
  assert.equal(effectiveSkillOwner(skill({ scopeId: "personal:ana", createdBy: "bob", ownerId: "carl" })), "ana");
  assert.equal(effectiveSkillOwner(skill({ scopeId: "channel:C", createdBy: "bob" })), "bob");
  assert.equal(effectiveSkillOwner(skill({ scopeId: "channel:C", createdBy: "bob", ownerId: "carl" })), "carl");
  assert.equal(effectiveSkillOwner(skill({ scopeId: "org:acme", createdBy: "system:skills-seed" })), undefined);
});

test("moving and transferring is owner or admin only, and a source-managed skill is only archivable", async () => {
  const s = skill({ scopeId: "channel:C", ownerId: "owner" });
  const r = rights({ members: { "channel:C": ["m"] }, admins: ["a"] });
  assert.equal(await r.movesOrTransfers(s, "owner"), true);
  assert.equal(await r.movesOrTransfers(s, "a"), true);
  assert.equal(await r.movesOrTransfers(s, "m"), false);
  const seed = skill({ scopeId: "channel:C", createdBy: "system:skills-seed" });
  assert.equal(await r.roleFor(seed, "a"), "admin");
  assert.equal(await r.roleFor(seed, "m"), "home_member");
  assert.equal(await r.manages(seed, "a"), false);
  assert.equal(await r.movesOrTransfers(seed, "a"), false);
});

test("a change to a skill that reaches beyond one person needs a live person", () => {
  assert.equal(triggerBlocksSkillChange("personal:u", false, false), false);
  assert.equal(triggerBlocksSkillChange("personal:u", true, false), true);
  assert.equal(triggerBlocksSkillChange("channel:C", false, false), true);
  assert.equal(triggerBlocksSkillChange("org:acme", false, false), true);
  assert.equal(triggerBlocksSkillChange("channel:C", true, true), false);
});
