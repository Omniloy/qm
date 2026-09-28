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
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
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

async function publish(built: BuiltApp, owner: string, name: string) {
  const skill = await built.skills.create({
    scopeId: scopeId("personal", owner),
    manifest: { name, description: name, requiredCapabilities: [], body: `# ${name}` },
    createdBy: owner,
  });
  await built.skills.review(skill.id, "reviewer", []);
  return built.skills.publish(skill.id);
}

const live = (actorId: string): CapabilityClaims =>
  ({ actorId, scopeId: scopeId("personal", actorId), exp: 9_999_999_999, liveActor: true }) as CapabilityClaims;

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
  assert.equal(promoted.scopeId, ORG_SCOPE);
});

test("when everyone may share with the org, a member promotes and takes back their own skill but no one else's", async () => {
  const built = buildApp(testConfig());
  const { app, config } = built;
  await config.setSkillSharingPolicy({ contexts: "everyone", org: "everyone" });
  const mine = await publish(built, "U1", "digest");
  const theirs = await publish(built, "U2", "triage");

  await assert.rejects(app.promoteSkill(mine.id, ORG_SCOPE, "U1", false), /live person/);
  await assert.rejects(app.promoteSkill(theirs.id, ORG_SCOPE, "U1", true), /isn't yours/);
  const promoted = await app.promoteSkill(mine.id, ORG_SCOPE, "U1", true);
  assert.equal(promoted.scopeId, ORG_SCOPE);

  const rival = await publish(built, "U2", "digest");
  await assert.rejects(app.promoteSkill(rival.id, ORG_SCOPE, "U2", true), /only an org admin can replace/);
  const adminCopy = await app.promoteSkill(theirs.id, ORG_SCOPE, "admin-alice", true);

  await assert.rejects(app.demoteSkill(adminCopy.id, "U1", true), /only an org admin/);
  await app.demoteSkill(promoted.id, "U1", true);
  assert.equal((await built.skills.get(promoted.id))?.status, "archived");
});

test("with the default org setting a member cannot take back even a skill they wrote", async () => {
  const built = buildApp(testConfig());
  const mine = await publish(built, "U1", "digest");
  const promoted = await built.app.promoteSkill(mine.id, ORG_SCOPE, "admin-alice", true);
  await assert.rejects(built.app.demoteSkill(promoted.id, "U1", true), /only an org admin/);
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
  assert.match((refused as { message: string }).message, /only an org admin can share or move a skill/);
  const moved = await control.shareArtifact(
    { type: "skill", id: mine.id, scope: scopeId("personal", "U1"), move: true },
    live("U1"),
  );
  assert.equal(moved.ok, false);
});
