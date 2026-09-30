import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { ADMIN, grantsOf, ORG_SCOPE, ownerFixture, publishSkill } from "./support/skill-owner-fixture.ts";

const PUB = scopeId("channel", "CPUB");
const PRIV = scopeId("channel", "CPRIV");

async function legacyCopy() {
  const built = await ownerFixture();
  const canonical = await publishSkill(built, { owner: "U1", name: "slides" });
  const orgCopy = await publishSkill(built, { owner: "U1", name: "slides", home: ORG_SCOPE });
  return { built, canonical, orgCopy };
}

test("a merge makes the canonical skill reach everything the copy reached, read-only, then retires the copy", async () => {
  const { built, canonical, orgCopy } = await legacyCopy();
  await built.acl.grant({
    ownerScopeId: ORG_SCOPE,
    ref: `skill:${orgCopy.id}`,
    granteeScopeId: PRIV,
    permission: "write",
    grantedBy: ADMIN,
  });
  const result = await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    { retired: result.ok && result.retired, into: result.ok && result.into, orgWide: result.ok && result.orgWide },
    { retired: orgCopy.id, into: canonical.id, orgWide: true },
  );
  const retired = await built.skills.get(orgCopy.id);
  assert.equal(retired?.status, "archived");
  assert.equal(retired?.supersededBy, canonical.id);
  assert.deepEqual(await grantsOf(built, orgCopy.id), [], "the copy's grants are revoked");
  assert.deepEqual(
    (await grantsOf(built, canonical.id)).map((g) => [g.ownerScopeId, g.granteeScopeId, g.permission]).sort(),
    [
      [scopeId("personal", "U1"), PRIV, "read"],
      [scopeId("personal", "U1"), ORG_SCOPE, "read"],
    ].sort(),
  );
  assert.equal((await built.skills.get(canonical.id))?.ownerId, "U1", "the canonical record gets its owner");
  assert.ok((await built.auditLog.events()).some((e) => e.action === "skill_merge" && e.resource === orgCopy.id));
});

test("a copy whose content drifted needs force, and the refusal carries the diff", async () => {
  const { built, canonical, orgCopy } = await legacyCopy();
  await built.skills.update(orgCopy.id, { ...orgCopy.manifest, body: "# slides, edited by an admin" });
  const refused = await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  assert.equal(!refused.ok && refused.code, "diverged");
  assert.ok(!refused.ok && refused.diff && refused.diff.bodyDeltaChars < 0);
  assert.equal((await built.skills.get(orgCopy.id))?.status, "published", "nothing changes without force");
  const forced = await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN, force: true });
  assert.ok(forced.ok);
});

test("a retired id redirects to the canonical skill, and a second merge of it is refused", async () => {
  const { built, canonical, orgCopy } = await legacyCopy();
  await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  const resolved = await built.app.resolveSkillId(orgCopy.id);
  assert.equal(resolved?.skill.id, canonical.id);
  assert.equal(resolved?.supersededFrom, orgCopy.id);
  const again = await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  assert.equal(!again.ok && again.code, "superseded");
  const other = await publishSkill(built, { owner: "U2", name: "notes" });
  const mismatch = await built.app.mergeSkill({ fromId: other.id, intoId: canonical.id, actorId: ADMIN });
  assert.equal(!mismatch.ok && mismatch.code, "name_mismatch");
});

test("the canonical skill's own channel grants take effect once the org copy stops shadowing them", async () => {
  const { built, canonical, orgCopy } = await legacyCopy();
  await built.app.shareSkill({ id: canonical.id, toScope: PUB, permission: "read", actorId: "U1", liveActor: true });
  const resolvedFor = async (who: string) =>
    (await built.app.listVisibleSkills(who)).find((r) => r.skill?.manifest.name === "slides")?.skill?.id;
  assert.equal(await resolvedFor("U3"), orgCopy.id, "before the merge the org copy wins");
  await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  assert.equal(await resolvedFor("U3"), canonical.id);
  assert.equal(await resolvedFor("U4"), canonical.id, "and everyone else reaches it through the org grant");
});

test("purge deletes only archived skills that nothing redirects to, and revokes their grants", async () => {
  const { built, canonical, orgCopy } = await legacyCopy();
  const live = await built.app.purgeArchivedSkill({ id: canonical.id, actorId: ADMIN });
  assert.equal(!live.ok && live.code, "bad_request");
  await built.app.mergeSkill({ fromId: orgCopy.id, intoId: canonical.id, actorId: ADMIN });
  const leftover = await publishSkill(built, { owner: "U2", name: "smoke" });
  await built.acl.grant({
    ownerScopeId: scopeId("personal", "U2"),
    ref: `skill:${leftover.id}`,
    granteeScopeId: PRIV,
    permission: "read",
    grantedBy: "U2",
  });
  await built.skills.archive(leftover.id);
  const purged = await built.app.purgeArchivedSkill({ id: leftover.id, actorId: ADMIN });
  assert.ok(purged.ok);
  assert.equal(await built.skills.get(leftover.id), null);
  assert.deepEqual(await grantsOf(built, leftover.id), []);
});
