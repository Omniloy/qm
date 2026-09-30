import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { encodeRef, fileRef } from "../src/acl/resource-ref.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { grantSharedContextRead } from "../src/core/attachments.ts";
import { ADMIN, grantsOf, ORG_SCOPE, ownerFixture, publishSkill } from "./support/skill-owner-fixture.ts";

const PRIV = scopeId("channel", "CPRIV");
const PUB = scopeId("channel", "CPUB");
const live = { liveActor: true };

test("a file whose path reads as a skill ref can never be granted as a file", async () => {
  assert.throws(() => encodeRef(fileRef("skill:abc")), /can't be shared as a file/);
  assert.equal(encodeRef(fileRef("reports/skill:abc.md")), "reports/skill:abc.md");
  await assert.rejects(
    grantSharedContextRead(createAclStore(), {
      ownerScopeId: scopeId("personal", "U2"),
      path: "skill:abc",
      createdInScope: PRIV,
      grantedBy: "U2",
    }),
    /can't be shared as a file/,
  );
});

test("a channel member cannot plant a grant under their channel's key for someone else's skill", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "y" });
  await assert.rejects(
    built.acl.grant({
      ownerScopeId: PRIV,
      ref: `skill:${s.id}`,
      granteeScopeId: ORG_SCOPE,
      permission: "write",
      grantedBy: "U2",
    }),
  );
  assert.deepEqual(await grantsOf(built, s.id), []);
});

test("grants already filed under the destination home are dropped, not resurrected, by a move", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "y" });
  await built.acl.grant({
    ownerScopeId: PRIV,
    ref: `skill:${s.id}`,
    granteeScopeId: ORG_SCOPE,
    permission: "write",
    grantedBy: ADMIN,
  });
  const moved = await built.app.moveSkillHome({ id: s.id, toScope: PRIV, actorId: "U1", ...live });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.deepEqual(await grantsOf(built, s.id), []);
  const [sharing] = await built.app.skillSharingFor([(await built.skills.get(s.id))!], "U1");
  assert.equal(sharing!.orgWide, false);
});

test("an admin cannot make an unshared personal skill org-wide, but can once its owner shared it", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "secret" });
  const refused = await built.app.setSkillOrgWide({ id: s.id, on: true, actorId: ADMIN, ...live });
  assert.equal(!refused.ok && refused.code, "forbidden");
  assert.deepEqual(await grantsOf(built, s.id), []);
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "read", actorId: "U1", ...live });
  const allowed = await built.app.setSkillOrgWide({ id: s.id, on: true, actorId: ADMIN, ...live });
  assert.ok(allowed.ok, JSON.stringify(allowed));
});

test("when only admins may share into contexts, an owner cannot hand a personal skill to someone else", async () => {
  const built = await ownerFixture();
  await built.config.setSkillSharingPolicy({ contexts: "admins", org: "admins" });
  const s = await publishSkill(built, { owner: "U1", name: "x" });
  const refused = await built.app.transferSkillOwner({ id: s.id, newOwnerId: "U2", actorId: "U1", ...live });
  assert.equal(!refused.ok && refused.code, "forbidden");
  assert.equal((await built.skills.get(s.id))?.scopeId, scopeId("personal", "U1"));
});

test("when only admins may take skills from the org, the owner can neither archive nor move out an org-home skill", async () => {
  const built = await ownerFixture();
  await built.config.setSkillSharingPolicy({ contexts: "everyone", org: "admins" });
  const s = await publishSkill(built, { owner: "U1", name: "z", home: ORG_SCOPE });
  assert.equal(await built.app.deleteOwnedSkill({ principalId: "U1", id: s.id, liveActor: true }), "org_admins_only");
  const moved = await built.app.moveSkillHome({ id: s.id, toScope: scopeId("personal", "U1"), actorId: "U1", ...live });
  assert.equal(!moved.ok && moved.code, "forbidden");
  const stored = await built.skills.get(s.id);
  assert.equal(stored?.status, "published");
  assert.equal(stored?.scopeId, ORG_SCOPE);
  assert.equal(await built.app.deleteOwnedSkill({ principalId: ADMIN, id: s.id, liveActor: true }), "deleted");
});

test("a name clash names the other skill only to someone who can see it", async () => {
  const built = await ownerFixture();
  const hidden = await publishSkill(built, { owner: "U2", name: "notes" });
  await built.app.shareSkill({
    id: hidden.id,
    toScope: scopeId("personal", "U4"),
    permission: "read",
    actorId: "U2",
    ...live,
  });
  const mine = await publishSkill(built, { owner: "U1", name: "notes" });
  const result = await built.app.shareSkill({
    id: mine.id,
    toScope: scopeId("personal", "U4"),
    permission: "read",
    actorId: "U1",
    ...live,
  });
  assert.equal(!result.ok && result.code, "name_conflict");
  assert.equal(!result.ok && result.conflict, undefined);
  assert.equal(!result.ok && result.message, "a skill with this name is already visible there");
});

test("a shared-home skill only goes to a member of its home, unless an admin does it", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "triage", home: PRIV, ownerId: "U1" });
  const refused = await built.app.transferSkillOwner({ id: s.id, newOwnerId: "U3", actorId: "U1", ...live });
  assert.equal(!refused.ok && refused.code, "bad_request");
  assert.equal((await built.skills.get(s.id))?.ownerId, "U1");
  const byAdmin = await built.app.transferSkillOwner({ id: s.id, newOwnerId: "U3", actorId: ADMIN, ...live });
  assert.ok(byAdmin.ok, JSON.stringify(byAdmin));
});

test("unsharing, including from the whole org, takes a live person", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "read", actorId: "U1", ...live });
  const blocked = await built.app.unshareSkill({ id: s.id, scope: PUB, actorId: "U1", liveActor: false });
  assert.equal(!blocked.ok && blocked.code, "trigger_blocked");
  assert.equal((await grantsOf(built, s.id)).length, 1);
  const ok = await built.app.unshareSkill({ id: s.id, scope: PUB, actorId: "U1", liveActor: true });
  assert.ok(ok.ok);
});

test("a source-managed skill is never merged, on either side", async () => {
  const built = await ownerFixture();
  const seed = await publishSkill(built, { owner: "U1", name: "digest", home: ORG_SCOPE, createdBy: "system:seed" });
  const mine = await publishSkill(built, { owner: "U1", name: "digest" });
  const into = await built.app.mergeSkill({ fromId: mine.id, intoId: seed.id, actorId: ADMIN });
  assert.equal(!into.ok && into.code, "forbidden");
  const from = await built.app.mergeSkill({ fromId: seed.id, intoId: mine.id, actorId: ADMIN });
  assert.equal(!from.ok && from.code, "forbidden");
  assert.equal((await built.skills.get(seed.id))?.supersededBy, undefined);
});

test("a public-channel write grant lets that channel's members edit, never someone who can merely read it", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "jira" });
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "write", actorId: "U1", ...live });
  await built.app.setSkillOrgWide({ id: s.id, on: true, actorId: ADMIN, ...live });
  const skill = (await built.skills.get(s.id))!;
  const [member, outsider] = await Promise.all([
    built.app.skillEditAccess([skill], "U3", true),
    built.app.skillEditAccess([skill], "U4", true),
  ]);
  assert.equal(member[0], "editable");
  assert.equal(outsider[0], "not_yours");
  assert.equal(await built.app.updateOwnedSkill(s.id, "U4", { body: "injected" }, live), null);
});

test("downgrade-write-grants lists skill write grants on a dry run and turns them into read grants when applied", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "jira" });
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "write", actorId: "U1", ...live });
  const report = await built.app.skillDuplicateReport();
  assert.deepEqual(report.writeGrants, [
    { skillId: s.id, name: "jira", ownerScopeId: scopeId("personal", "U1"), granteeScopeId: PUB },
  ]);
  const dry = await built.app.downgradeSkillWriteGrants({ dryRun: true, actorId: ADMIN });
  assert.equal(dry.downgraded.length, 1);
  assert.equal((await grantsOf(built, s.id))[0]!.permission, "write");
  await built.app.downgradeSkillWriteGrants({ dryRun: false, actorId: ADMIN });
  assert.deepEqual(
    (await grantsOf(built, s.id)).map((g) => [g.granteeScopeId, g.permission]),
    [[PUB, "read"]],
  );
  const [access] = await built.app.skillEditAccess([(await built.skills.get(s.id))!], "U3", true);
  assert.equal(access, "not_yours");
});

test("unmerge brings the retired copy back with its grants and takes back what the merge gave the canonical", async () => {
  const built = await ownerFixture();
  const canonical = await publishSkill(built, { owner: "U1", name: "slides" });
  const orgCopy = await publishSkill(built, { owner: "U1", name: "slides", home: ORG_SCOPE });
  await built.acl.grant({
    ownerScopeId: ORG_SCOPE,
    ref: `skill:${orgCopy.id}`,
    granteeScopeId: PRIV,
    permission: "read",
    grantedBy: ADMIN,
  });
  const merged = await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  assert.ok(merged.ok);
  assert.equal((await grantsOf(built, canonical.id)).length, 2);
  const undone = await built.app.unmergeSkill({ id: orgCopy.id, actorId: ADMIN });
  assert.ok(undone.ok, JSON.stringify(undone));
  const restored = await built.skills.get(orgCopy.id);
  assert.equal(restored?.supersededBy, undefined);
  assert.equal(restored?.status, "published");
  assert.deepEqual(await grantsOf(built, canonical.id), []);
  assert.deepEqual(
    (await grantsOf(built, orgCopy.id)).map((g) => [g.ownerScopeId, g.granteeScopeId]),
    [[ORG_SCOPE, PRIV]],
  );
  const again = await built.app.unmergeSkill({ id: orgCopy.id, actorId: ADMIN });
  assert.equal(!again.ok && again.code, "bad_request");
});

test("unmerge keeps an org grant the canonical already had before the merge", async () => {
  const built = await ownerFixture();
  const canonical = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({ id: canonical.id, toScope: PUB, permission: "read", actorId: "U1", ...live });
  await built.app.setSkillOrgWide({ id: canonical.id, on: true, actorId: ADMIN, ...live });
  const orgCopy = await publishSkill(built, { owner: "U1", name: "slides", home: ORG_SCOPE });
  await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  await built.app.unmergeSkill({ id: orgCopy.id, actorId: ADMIN });
  assert.deepEqual((await grantsOf(built, canonical.id)).map((g) => g.granteeScopeId).sort(), [PUB, ORG_SCOPE].sort());
});

test("changing only a skill's owner does not touch updatedAt", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides", home: PRIV });
  const before = (await built.skills.get(s.id))!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  await built.skills.setOwner(s.id, "U2");
  assert.equal((await built.skills.get(s.id))?.updatedAt, before);
  await built.skills.setOwner(s.id, "U2", PUB);
  assert.notEqual((await built.skills.get(s.id))?.updatedAt, before);
});

test("an archived skill can still stop being org-wide", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "read", actorId: "U1", ...live });
  await built.app.setSkillOrgWide({ id: s.id, on: true, actorId: ADMIN, ...live });
  await built.skills.archive(s.id);
  const off = await built.app.setSkillOrgWide({ id: s.id, on: false, actorId: "U1", ...live });
  assert.ok(off.ok, JSON.stringify(off));
  assert.deepEqual(
    (await grantsOf(built, s.id)).map((g) => g.granteeScopeId),
    [PUB],
  );
});

test("restoring a skill is a name conflict when one of its audiences already sees another skill of that name", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "read", actorId: "U1", ...live });
  await built.skills.archive(s.id);
  await publishSkill(built, { owner: "U3", name: "slides", home: PUB, ownerId: "U3" });
  assert.equal(await built.app.restoreOwnedSkill(s.id, "U1", live), "name_conflict");
  assert.equal((await built.skills.get(s.id))?.status, "archived");
});

test("a retired id tells a stranger nothing about where it went", async () => {
  const built = await ownerFixture();
  const canonical = await publishSkill(built, { owner: "U1", name: "slides" });
  const copy = await publishSkill(built, { owner: "U1", name: "slides", home: PRIV, ownerId: "U1" });
  await built.app.mergeSkill({ fromId: copy.id, intoId: canonical.id, actorId: ADMIN });
  assert.equal(await built.app.deleteOwnedSkill({ principalId: "U3", id: copy.id, liveActor: true }), "forbidden");
  assert.equal(await built.app.restoreOwnedSkill(copy.id, "U3", live), null);
  assert.equal(await built.app.deleteOwnedSkill({ principalId: "U1", id: copy.id, liveActor: true }), "superseded");
});
