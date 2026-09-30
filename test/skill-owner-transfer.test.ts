import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../src/types.ts";
import { ADMIN, grantsOf, ownerFixture, publishSkill } from "./support/skill-owner-fixture.ts";

const PRIV = scopeId("channel", "CPRIV");

test("transferring a personal skill moves it to the new owner's personal space with its grants", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await built.app.shareSkill({ id: s.id, toScope: PRIV, permission: "read", actorId: "U1", liveActor: true });
  const result = await built.app.transferSkillOwner({ id: s.id, newOwnerId: "U2", actorId: "U1", liveActor: true });
  assert.ok(result.ok, JSON.stringify(result));
  const stored = await built.skills.get(s.id);
  assert.equal(stored?.scopeId, scopeId("personal", "U2"));
  assert.equal(stored?.ownerId, "U2");
  assert.deepEqual(
    (await grantsOf(built, s.id)).map((g) => [g.ownerScopeId, g.granteeScopeId]),
    [[scopeId("personal", "U2"), PRIV]],
  );
  const audit = (await built.auditLog.events()).find((e) => e.action === "skill_owner_transfer")!;
  assert.deepEqual(JSON.parse(audit.detail!), { from: "U1", to: "U2", home: scopeId("personal", "U2") });
  const notice = (await built.deliveries.pending("principal")).find((d) =>
    d.idempotencyKey?.startsWith(`skill-owner:${s.id}:U2:`),
  );
  assert.ok(notice, "the new owner is told");
  assert.match(notice!.text ?? "", /made you the owner of \/slides/);
});

test("a skill handed back and forth notifies its new owner every time", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides", home: PRIV, ownerId: "U1" });
  const hand = (newOwnerId: string, actorId: string) =>
    built.app.transferSkillOwner({ id: s.id, newOwnerId, actorId, liveActor: true });
  await hand("U2", "U1");
  await new Promise((r) => setTimeout(r, 2));
  await hand("U1", "U2");
  await new Promise((r) => setTimeout(r, 2));
  await hand("U2", "U1");
  const keys = (await built.deliveries.pending("principal"))
    .map((d) => d.idempotencyKey)
    .filter((k) => k?.startsWith(`skill-owner:${s.id}:U2:`));
  assert.equal(new Set(keys).size, 2);
});

test("a personal skill can instead land in a shared home both people belong to", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  const result = await built.app.transferSkillOwner({
    id: s.id,
    newOwnerId: "U2",
    homeScope: PRIV,
    actorId: "U1",
    liveActor: true,
  });
  assert.ok(result.ok, JSON.stringify(result));
  const stored = await built.skills.get(s.id);
  assert.equal(stored?.scopeId, PRIV);
  assert.equal(stored?.ownerId, "U2");
  const outside = await publishSkill(built, { owner: "U1", name: "other" });
  const refused = await built.app.transferSkillOwner({
    id: outside.id,
    newOwnerId: "U3",
    homeScope: PRIV,
    actorId: "U1",
    liveActor: true,
  });
  assert.equal(!refused.ok && refused.code, "bad_request", "the new owner must belong to the chosen home");
});

test("a shared-home skill changes owner without moving", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides", home: PRIV, ownerId: "U1" });
  const result = await built.app.transferSkillOwner({ id: s.id, newOwnerId: "U2", actorId: "U1", liveActor: true });
  assert.ok(result.ok);
  const stored = await built.skills.get(s.id);
  assert.equal(stored?.scopeId, PRIV);
  assert.equal(stored?.ownerId, "U2");
});

test("unknown, external, and manually deactivated people cannot become owners", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  const transfer = (newOwnerId: string) =>
    built.app.transferSkillOwner({ id: s.id, newOwnerId, actorId: "U1", liveActor: true });
  const unknown = await transfer("nobody");
  assert.equal(!unknown.ok && unknown.code, "bad_request");
  await built.identity.deactivate("U3", "manual");
  const deactivated = await transfer("U3");
  assert.equal(!deactivated.ok && deactivated.code, "bad_request");
});

test("only the owner or an admin transfers, and never on an unattended turn", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  const byOther = await built.app.transferSkillOwner({ id: s.id, newOwnerId: "U2", actorId: "U3", liveActor: true });
  assert.equal(!byOther.ok && byOther.code, "forbidden");
  const trigger = await built.app.transferSkillOwner({ id: s.id, newOwnerId: "U2", actorId: "U1", liveActor: false });
  assert.equal(!trigger.ok && trigger.code, "trigger_blocked");
  const adminOnUnshared = await built.app.transferSkillOwner({
    id: s.id,
    newOwnerId: "U2",
    actorId: ADMIN,
    liveActor: true,
    asAdmin: true,
  });
  assert.equal(
    !adminOnUnshared.ok && adminOnUnshared.code,
    "forbidden",
    "an unshared personal skill stays its owner's",
  );
  await built.app.shareSkill({ id: s.id, toScope: PRIV, permission: "read", actorId: "U1", liveActor: true });
  const adminApi = await built.app.transferSkillOwner({
    id: s.id,
    newOwnerId: "U2",
    actorId: ADMIN,
    liveActor: true,
    asAdmin: true,
  });
  assert.ok(adminApi.ok, "once shared, the admin API transfers it");
});
