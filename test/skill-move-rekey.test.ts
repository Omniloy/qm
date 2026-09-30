import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { ADMIN, grantsOf, ORG_SCOPE, ownerFixture, publishSkill } from "./support/skill-owner-fixture.ts";

const PRIV = scopeId("channel", "CPRIV");
const PUB = scopeId("channel", "CPUB");

test("a move re-keys every grant onto the new home and revokes the old keys", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "read", actorId: "U1", liveActor: true });
  await built.app.setSkillOrgWide({ id: s.id, on: true, actorId: ADMIN, liveActor: true });
  const moved = await built.app.moveSkillHome({ id: s.id, toScope: PRIV, actorId: "U1", liveActor: true });
  assert.ok(moved.ok, JSON.stringify(moved));
  const after = await grantsOf(built, s.id);
  assert.deepEqual(after.map((g) => [g.ownerScopeId, g.granteeScopeId]).sort(), [
    [PRIV, PUB],
    [PRIV, ORG_SCOPE],
  ]);
  const stored = await built.skills.get(s.id);
  assert.equal(stored?.scopeId, PRIV);
  assert.equal(stored?.ownerId, "U1", "the owner survives leaving their personal space");
  const audit = (await built.auditLog.events()).find((e) => e.action === "skill_move" && e.resource === s.id)!;
  assert.deepEqual(JSON.parse(audit.detail!), { from: scopeId("personal", "U1"), to: PRIV, regranted: 2 });
});

test("a failed flip rolls back the grants it added and leaves the old ones in place", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "read", actorId: "U1", liveActor: true });
  const setOwner = built.skills.setOwner;
  built.skills.setOwner = async () => {
    throw new Error("store down");
  };
  await assert.rejects(built.app.moveSkillHome({ id: s.id, toScope: PRIV, actorId: "U1", liveActor: true }), /down/);
  built.skills.setOwner = setOwner;
  assert.deepEqual(
    (await grantsOf(built, s.id)).map((g) => [g.ownerScopeId, g.granteeScopeId]),
    [[scopeId("personal", "U1"), PUB]],
  );
  assert.equal((await built.skills.get(s.id))?.scopeId, scopeId("personal", "U1"));
});

test("there is no visibility gap: the grantee sees the skill before and after the move", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({
    id: s.id,
    toScope: scopeId("personal", "U4"),
    permission: "read",
    actorId: "U1",
    liveActor: true,
  });
  const sees = async () => (await built.app.listVisibleSkills("U4")).some((r) => r.skill?.id === s.id);
  assert.equal(await sees(), true);
  await built.app.moveSkillHome({ id: s.id, toScope: PRIV, actorId: "U1", liveActor: true });
  assert.equal(await sees(), true);
});

test("moves are refused into someone else's personal space, into the org for a non-admin, or by a non-member", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  const move = (toScope: string, actorId = "U1") =>
    built.app.moveSkillHome({ id: s.id, toScope, actorId, liveActor: true });
  const personal = await move(scopeId("personal", "U2"));
  assert.equal(!personal.ok && personal.code, "forbidden");
  const org = await move(ORG_SCOPE);
  assert.equal(!org.ok && org.code, "forbidden");
  const channel = await move(scopeId("channel", "CNOPE"));
  assert.equal(!channel.ok && channel.code, "forbidden");
  const stranger = await move(PRIV, "U2");
  assert.equal(!stranger.ok && stranger.code, "forbidden", "only the owner or an admin moves a skill");
  const trigger = await built.app.moveSkillHome({ id: s.id, toScope: PRIV, actorId: "U1", liveActor: false });
  assert.equal(!trigger.ok && trigger.code, "trigger_blocked");
  const unsharedByAdmin = await built.app.moveSkillHome({
    id: s.id,
    toScope: ORG_SCOPE,
    actorId: ADMIN,
    liveActor: true,
    asAdmin: true,
  });
  assert.equal(
    !unsharedByAdmin.ok && unsharedByAdmin.code,
    "forbidden",
    "an admin leaves an unshared personal skill alone",
  );
  await built.app.shareSkill({ id: s.id, toScope: PUB, permission: "read", actorId: "U1", liveActor: true });
  const adminMove = await built.app.moveSkillHome({
    id: s.id,
    toScope: ORG_SCOPE,
    actorId: ADMIN,
    liveActor: true,
    asAdmin: true,
  });
  assert.ok(adminMove.ok, JSON.stringify(adminMove));
});

test("a move into a home that already has a skill with that name is a name conflict", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  const there = await publishSkill(built, { owner: "U2", name: "slides", home: PRIV });
  const result = await built.app.moveSkillHome({ id: s.id, toScope: PRIV, actorId: "U1", liveActor: true });
  assert.equal(!result.ok && result.code, "name_conflict");
  assert.equal(!result.ok && result.conflict?.id, there.id);
});
