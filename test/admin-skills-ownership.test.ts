import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { ADMIN, ORG_SCOPE, ownerFixture, publishSkill } from "./support/skill-owner-fixture.ts";

const HEADERS = { "content-type": "application/json", "x-admin-actor": `${ADMIN}@default-org` };
const PRIV = scopeId("channel", "CPRIV");

async function start() {
  const built = await ownerFixture();
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = HEADERS) =>
    fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { built, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const org = `?scope=${encodeURIComponent(ORG_SCOPE)}`;

test("duplicates, merge, purge and backfill are org-scope admin routes; /duplicates is not read as a skill id", async () => {
  const s = await start();
  try {
    const report = await s.call("GET", `/v1/admin/skills/duplicates${org}`);
    assert.equal(report.status, 200);
    assert.ok(Array.isArray(((await report.json()) as { clusters: unknown[] }).clusters));
    const scoped = `?scope=${encodeURIComponent(PRIV)}`;
    assert.equal((await s.call("GET", `/v1/admin/skills/duplicates${scoped}`)).status, 403);
    assert.equal((await s.call("POST", `/v1/admin/skills/backfill-owners${scoped}`, {})).status, 403);
    const outsider = { ...HEADERS, "x-admin-actor": "U1@default-org" };
    assert.equal((await s.call("GET", `/v1/admin/skills/duplicates${org}`, undefined, outsider)).status, 403);
  } finally {
    await s.close();
  }
});

test("backfill reports what it would change on a dry run and records owners when applied", async () => {
  const s = await start();
  try {
    const mine = await publishSkill(s.built, { owner: "U1", name: "digest" });
    const dry = (await (await s.call("POST", `/v1/admin/skills/backfill-owners${org}`, { dryRun: true })).json()) as {
      dryRun: boolean;
      updated: string[];
    };
    assert.equal(dry.dryRun, true);
    assert.ok(dry.updated.includes(mine.id));
    assert.equal((await s.built.skills.get(mine.id))?.ownerId, undefined);
    const applied = (await (await s.call("POST", `/v1/admin/skills/backfill-owners${org}`, {})).json()) as {
      updated: string[];
    };
    assert.ok(applied.updated.includes(mine.id));
    assert.equal((await s.built.skills.get(mine.id))?.ownerId, "U1");
    const again = (await (await s.call("POST", `/v1/admin/skills/backfill-owners${org}`, {})).json()) as {
      updated: string[];
    };
    assert.ok(!again.updated.includes(mine.id), "the backfill is idempotent");
  } finally {
    await s.close();
  }
});

test("unmerge over HTTP brings a retired copy back", async () => {
  const s = await start();
  try {
    const canonical = await publishSkill(s.built, { owner: "U1", name: "slides" });
    const copy = await publishSkill(s.built, { owner: "U1", name: "slides", home: ORG_SCOPE });
    await s.call("POST", `/v1/admin/skills/${copy.id}/merge${org}`, { into: canonical.id });
    const scoped = `?scope=${encodeURIComponent(PRIV)}`;
    assert.equal((await s.call("POST", `/v1/admin/skills/${copy.id}/unmerge${scoped}`, {})).status, 403);
    const undone = await s.call("POST", `/v1/admin/skills/${copy.id}/unmerge${org}`, {});
    assert.equal(undone.status, 200);
    assert.deepEqual(await undone.json(), {
      ok: true,
      restored: copy.id,
      from: canonical.id,
      regranted: 0,
      revoked: 1,
    });
    assert.equal((await s.built.skills.get(copy.id))?.status, "published");
    const dry = await s.call("POST", `/v1/admin/skills/downgrade-write-grants${org}`, { dryRun: true });
    assert.deepEqual(await dry.json(), { dryRun: true, downgraded: [], skipped: [] });
  } finally {
    await s.close();
  }
});

test("merge over HTTP retires the copy; the retired id then redirects GET and PUT, and 409s DELETE and restore", async () => {
  const s = await start();
  try {
    const canonical = await publishSkill(s.built, { owner: "U1", name: "slides" });
    const copy = await publishSkill(s.built, { owner: "U1", name: "slides", home: ORG_SCOPE });
    const merged = await s.call("POST", `/v1/admin/skills/${copy.id}/merge${org}`, { into: canonical.id });
    assert.equal(merged.status, 200);
    assert.deepEqual(
      { ...((await merged.json()) as Record<string, unknown>), regranted: 0 },
      { ok: true, retired: copy.id, into: canonical.id, regranted: 0, orgWide: true },
    );
    const detail = (await (await s.call("GET", `/v1/skills/${copy.id}?principalId=U1`)).json()) as {
      skill: { id: string; supersededFrom?: string; ownerId?: string; orgWide?: boolean };
    };
    assert.equal(detail.skill.id, canonical.id);
    assert.equal(detail.skill.supersededFrom, copy.id);
    assert.equal(detail.skill.orgWide, true);
    const put = await s.call("PUT", `/v1/skills/${copy.id}`, { principalId: "U1", body: "# v2" });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { skill: { id: string } }).skill.id, canonical.id);
    assert.equal((await s.built.skills.get(canonical.id))?.manifest.body, "# v2");
    const del = await s.call("DELETE", `/v1/skills/${copy.id}`, { principalId: "U1" });
    assert.equal(del.status, 409);
    assert.equal(((await del.json()) as { supersededBy: string }).supersededBy, canonical.id);
    assert.equal((await s.call("POST", `/v1/skills/${copy.id}/restore`, { principalId: "U1" })).status, 409);
    const listed = (await (await s.call("GET", `/v1/skills?principalId=U1`)).json()) as {
      skills: Array<{ id: string }>;
    };
    assert.ok(!listed.skills.some((row) => row.id === copy.id), "a retired row is never listed");
  } finally {
    await s.close();
  }
});

test("a scoped admin transfers and moves a skill in their scope; a personal skill only once it is shared", async () => {
  const s = await start();
  try {
    const inChannel = await publishSkill(s.built, { owner: "U1", name: "triage", home: PRIV, ownerId: "U1" });
    const scoped = `?scope=${encodeURIComponent(PRIV)}`;
    const owner = await s.call("POST", `/v1/admin/skills/${inChannel.id}/owner${scoped}`, { ownerId: "U2" });
    assert.equal(owner.status, 200);
    assert.equal((await s.built.skills.get(inChannel.id))?.ownerId, "U2");
    const personal = await publishSkill(s.built, { owner: "U1", name: "digest" });
    assert.equal(
      (await s.call("POST", `/v1/admin/skills/${personal.id}/owner${scoped}`, { ownerId: "U2" })).status,
      403,
    );
    const unshared = await s.call("POST", `/v1/admin/skills/${personal.id}/move${org}`, { toScope: PRIV });
    assert.equal(unshared.status, 403, "an admin leaves an unshared personal skill alone");
    assert.equal((await s.call("POST", `/v1/admin/skills/${personal.id}/owner${org}`, { ownerId: "U2" })).status, 403);
    assert.equal(
      (await s.call("PUT", `/v1/admin/skills/${personal.id}${org}`, { body: "# rewritten by an admin" })).status,
      403,
    );
    assert.equal((await s.built.skills.get(personal.id))?.manifest.body, "# digest");
    await s.built.app.shareSkill({
      id: personal.id,
      toScope: scopeId("channel", "CPUB"),
      permission: "read",
      actorId: "U1",
      liveActor: true,
    });
    assert.equal(
      (await s.call("PUT", `/v1/admin/skills/${personal.id}${org}`, { body: "# edited by an admin" })).status,
      200,
    );
    const moved = await s.call("POST", `/v1/admin/skills/${personal.id}/move${org}`, { toScope: PRIV });
    assert.equal(moved.status, 200, "once its owner shared it, the admin API moves it");
    assert.equal((await s.built.skills.get(personal.id))?.scopeId, PRIV);
    assert.equal((await s.call("POST", `/v1/admin/skills/${personal.id}/move${org}`, { toScope: "nope" })).status, 400);
  } finally {
    await s.close();
  }
});

test("the user owner route transfers a skill the caller owns and refuses one they don't", async () => {
  const s = await start();
  try {
    const mine = await publishSkill(s.built, { owner: "U1", name: "digest" });
    const refused = await s.call("POST", `/v1/skills/${mine.id}/owner`, { principalId: "U2", ownerId: "U3" });
    assert.equal(refused.status, 403);
    assert.equal((await s.call("POST", `/v1/skills/${mine.id}/owner`, { principalId: "U1" })).status, 400);
    const ok = await s.call("POST", `/v1/skills/${mine.id}/owner`, { principalId: "U1", ownerId: "U2" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), {
      skill: { id: mine.id, ownerId: "U2", scopeId: scopeId("personal", "U2") },
    });
  } finally {
    await s.close();
  }
});
