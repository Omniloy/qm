import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createControlService } from "../src/api/control-service.ts";
import { createMemoryConfigStore, type PersistedSkillSharingPolicy } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { CONTROL_PLANE_AUD, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const ORG_SCOPE = scopeId("org", "default-org");
const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "skill-sharing-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function publish(built: BuiltApp, owner: string, name: string, home = scopeId("personal", owner)) {
  const skill = await built.skills.create({
    scopeId: home,
    manifest: { name, description: name, requiredCapabilities: [], body: `# ${name}` },
    createdBy: owner,
  });
  await built.skills.review(skill.id, "reviewer", []);
  return built.skills.publish(skill.id);
}

const live = (actorId: string): CapabilityClaims =>
  ({ actorId, scopeId: scopeId("personal", actorId), exp: 9_999_999_999, liveActor: true }) as CapabilityClaims;

const webSession = (actorId: string): CapabilityClaims => ({ ...live(actorId), portalSession: true });

const liveTurn = (actorId: string): CapabilityClaims => ({
  ...live(actorId),
  aud: CONTROL_PLANE_AUD,
  sessionId: "S1",
});

test("the skill sharing policy defaults to today's behaviour and persists in its durable map", async () => {
  const backing = createMemoryMap<PersistedSkillSharingPolicy>();
  const first = createMemoryConfigStore("default-org", { skillSharing: backing });
  assert.deepEqual(await first.getSkillSharingPolicy(), { contexts: "everyone", org: "admins" });
  await first.setSkillSharingPolicy({ contexts: "admins", org: "everyone" });
  const second = createMemoryConfigStore("default-org", { skillSharing: backing });
  assert.deepEqual(await second.getSkillSharingPolicy(), { contexts: "admins", org: "everyone" });
});

test("skill-sharing is an org-admin setting that validates both audiences and reads back in the skills view", async () => {
  const srv = start();
  const url = `${srv.base}/v1/admin/scopes/${ORG_SCOPE}/skill-sharing`;
  const put = (body: unknown, headers: Record<string, string> = ADMIN, target = url) =>
    fetch(target, { method: "PUT", headers, body: JSON.stringify(body) });
  const read = async () =>
    (
      (await (await fetch(`${srv.base}/v1/admin/scopes/${ORG_SCOPE}?view=skills`, { headers: ADMIN })).json()) as {
        skillSharing: unknown;
      }
    ).skillSharing;
  try {
    assert.deepEqual(await read(), { contexts: "everyone", org: "admins" });
    const open = { contexts: "everyone", org: "everyone" };
    assert.equal((await put(open, { ...ADMIN, "x-admin-actor": "nobody@default-org" })).status, 403);
    assert.equal((await put(open, ADMIN, `${srv.base}/v1/admin/scopes/personal:U1/skill-sharing`)).status, 400);
    for (const bad of [{ org: "everyone" }, { contexts: "everyone", org: "all" }, {}]) {
      assert.equal((await put(bad)).status, 400);
    }
    assert.equal((await put(open)).status, 200);
    assert.deepEqual(await read(), open);
    assert.deepEqual(await srv.built.config.getSkillSharingPolicy(), open);
  } finally {
    await srv.close();
  }
});

test("whoami tells a surface when a member may give skills to the org", async () => {
  const srv = start();
  const permissions = async (actor: string) =>
    (
      (await (await fetch(`${srv.base}/v1/admin/whoami`, { headers: { "x-admin-actor": actor } })).json()) as {
        permissions: string[];
      }
    ).permissions;
  try {
    assert.deepEqual(await permissions("admin-alice@default-org"), ["admin"]);
    assert.deepEqual(await permissions("U1@default-org"), []);
    await srv.built.config.setSkillSharingPolicy({ contexts: "admins", org: "everyone" });
    assert.deepEqual(await permissions("U1@default-org"), ["promote-skills"]);
  } finally {
    await srv.close();
  }
});

test("by default only an org admin can promote a skill org-wide", async () => {
  const built = buildApp(testConfig());
  const mine = await publish(built, "U1", "digest");
  await assert.rejects(built.app.promoteSkill(mine.id, ORG_SCOPE, "U1", true), /only an org admin/);
  const promoted = await built.app.promoteSkill(mine.id, ORG_SCOPE, "admin-alice", true);
  assert.equal(promoted.id, mine.id, "org-wide is a grant on the same skill, not a copy");
  assert.equal(promoted.scopeId, scopeId("personal", "U1"));
  assert.deepEqual(await built.app.listSkillGrants(mine.id), [{ granteeScopeId: ORG_SCOPE, permission: "read" }]);
});

test("when everyone may share with the org, a member promotes and takes back their own skill but no one else's", async () => {
  const built = buildApp(testConfig());
  const { app, config } = built;
  await config.setSkillSharingPolicy({ contexts: "everyone", org: "everyone" });
  const mine = await publish(built, "U1", "digest");
  const theirs = await publish(built, "U2", "triage");

  await assert.rejects(app.promoteSkill(mine.id, ORG_SCOPE, "U1", false, true), /live person/);
  await assert.rejects(app.promoteSkill(mine.id, ORG_SCOPE, "U1", true), /in the web app/);
  await assert.rejects(app.promoteSkill(theirs.id, ORG_SCOPE, "U1", true, true), /isn't yours/);
  const promoted = await app.promoteSkill(mine.id, ORG_SCOPE, "U1", true, true);
  assert.equal(promoted.id, mine.id);

  const rival = await publish(built, "U2", "digest");
  await assert.rejects(app.promoteSkill(rival.id, ORG_SCOPE, "U2", true, true), /already visible/);
  const adminShared = await app.promoteSkill(theirs.id, ORG_SCOPE, "admin-alice", true);

  await assert.rejects(app.demoteSkill(adminShared.id, "U1", true), /owner or an org admin/);
  await app.demoteSkill(promoted.id, "U1", true);
  assert.equal((await built.skills.get(promoted.id))?.status, "published", "it stays in its home");
  assert.deepEqual(await app.listSkillGrants(promoted.id), []);
});

test("with the default org setting the owner can still stop sharing their skill with everyone", async () => {
  const built = buildApp(testConfig());
  const mine = await publish(built, "U1", "digest");
  await built.app.promoteSkill(mine.id, ORG_SCOPE, "admin-alice", true);
  await assert.rejects(built.app.demoteSkill(mine.id, "U2", true), /owner or an org admin/);
  await built.app.demoteSkill(mine.id, "U1", true);
  assert.deepEqual(await built.app.listSkillGrants(mine.id), []);
});

test("limiting context sharing to admins refuses a member's skill share and move", async () => {
  const built = buildApp(testConfig());
  const control = createControlService(built.app, undefined, built.admin);
  const mine = await publish(built, "U1", "digest");
  const share = (actorId: string) =>
    control.shareArtifact({ type: "skill", id: mine.id, scope: scopeId("personal", "U2") }, live(actorId));

  assert.equal((await share("U1")).ok, true);
  await built.config.setSkillSharingPolicy({ contexts: "admins", org: "admins" });
  const refused = await share("U1");
  assert.equal(refused.ok, false);
  assert.match((refused as { message: string }).message, /only an org admin can put a skill/);
  const moved = await control.shareArtifact(
    { type: "skill", id: mine.id, scope: scopeId("personal", "U1"), move: true },
    live("U1"),
  );
  assert.equal(moved.ok, false);
});

test("a member's agent turn cannot give a skill to the org even when everyone may, but their web session can", async () => {
  const built = buildApp(testConfig());
  const control = createControlService(built.app, undefined, built.admin);
  await built.config.setSkillSharingPolicy({ contexts: "everyone", org: "everyone" });
  const mine = await publish(built, "U1", "digest");
  const promote = (claims: CapabilityClaims) =>
    control.shareArtifact({ type: "skill", id: mine.id, scope: ORG_SCOPE }, claims);

  const fromTurn = await promote(liveTurn("U1"));
  assert.equal(fromTurn.ok, false);
  assert.match((fromTurn as { message: string }).message, /in the web app/);
  const unclaimed = await promote(live("U1"));
  assert.equal(unclaimed.ok, false);
  assert.match((unclaimed as { message: string }).message, /in the web app/);
  assert.equal((await promote(webSession("U1"))).ok, true);

  const theirs = await publish(built, "admin-alice", "triage");
  const adminTurn = await control.shareArtifact(
    { type: "skill", id: theirs.id, scope: ORG_SCOPE },
    liveTurn("admin-alice"),
  );
  assert.equal(adminTurn.ok, true);
});

test("a member cannot claim an org skill name a built-in skill reserves, even while it is archived", async () => {
  const built = buildApp(testConfig());
  await built.config.setSkillSharingPolicy({ contexts: "everyone", org: "everyone" });
  const seed = await built.skills.create({
    scopeId: ORG_SCOPE,
    manifest: { name: "digest", description: "seed", requiredCapabilities: [], body: "# seed" },
    createdBy: "system:skills-seed",
  });
  await built.skills.archive(seed.id);
  const mine = await publish(built, "U1", "digest");
  await assert.rejects(built.app.promoteSkill(mine.id, ORG_SCOPE, "U1", true, true), /already visible/);
  await assert.rejects(built.app.promoteSkill(mine.id, ORG_SCOPE, "admin-alice", true), /already visible/);
});

test("the org name-taken check and take-back treat one person's differently cased ids as the same author", async () => {
  const built = buildApp(testConfig());
  await built.config.setSkillSharingPolicy({ contexts: "everyone", org: "everyone" });
  const mine = await publish(built, "Ana@Acme.com", "digest");
  const promoted = await built.app.promoteSkill(mine.id, ORG_SCOPE, "Ana@Acme.com", true, true);
  const again = await publish(built, "ana@acme.com", "digest");
  await assert.rejects(built.app.promoteSkill(again.id, ORG_SCOPE, "ana@acme.com", true, true), /already visible/);
  await built.app.demoteSkill(promoted.id, "ana@acme.com", true);
  assert.deepEqual(await built.app.listSkillGrants(promoted.id), []);
});

test("limiting context sharing to admins also refuses a member creating a skill in a shared home", async () => {
  const built = buildApp(testConfig());
  const channel = scopeId("channel", "C1");
  await built.config.setSkillSharingPolicy({ contexts: "admins", org: "admins" });
  const create = (principalId: string, homeScope?: typeof channel) =>
    built.app.createOwnedSkill({
      principalId,
      ...(homeScope ? { homeScope } : {}),
      name: "triage",
      description: "triage",
      body: "# triage",
    });

  const personal = await create("U1");
  assert.equal(typeof personal === "object" && personal?.scopeId, scopeId("personal", "U1"));
  assert.equal(await create("U1", channel), "forbidden");
  assert.equal(
    (await built.skills.list()).some((s) => s.scopeId === channel),
    false,
  );
  const admin = await create("admin-alice", channel);
  assert.equal(typeof admin === "object" && admin?.scopeId, channel);
});

test("the skills listing says who owns each skill and whether it is org-wide, without an org copy", async () => {
  const srv = start();
  const { built } = srv;
  const mine = await publish(built, "U1", "digest");
  await built.app.promoteSkill(mine.id, ORG_SCOPE, "admin-alice", true);
  try {
    const rows = (
      (await (await fetch(`${srv.base}/v1/skills?principalId=U1&includeShadowed=1`)).json()) as {
        skills: Array<{
          name: string;
          scope: string;
          editable: boolean;
          createdByViewer: boolean;
          ownedByViewer: boolean;
          orgWide: boolean;
          ownerName: string;
          sharedWith?: Array<{ scopeId: string }>;
        }>;
      }
    ).skills;
    const digest = rows.filter((r) => r.name === "digest");
    assert.equal(digest.length, 1, "promotion no longer copies the skill");
    assert.equal(digest[0]!.scope, "personal");
    assert.equal(digest[0]!.editable, true);
    assert.equal(digest[0]!.ownedByViewer, true);
    assert.equal(digest[0]!.orgWide, true);
    assert.deepEqual(
      digest[0]!.sharedWith?.map((g) => g.scopeId),
      [ORG_SCOPE],
    );
    assert.ok(rows.filter((r) => r.name !== "digest").every((r) => r.ownedByViewer === false));
    assert.ok(rows.filter((r) => r.name !== "digest").some((r) => r.ownerName === "built-in"));
    assert.ok(rows.length > 2);
  } finally {
    await srv.close();
  }
});
