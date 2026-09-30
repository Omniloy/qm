import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId, type Grant } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const owner = scopeId("personal", "U1");
const carol = scopeId("personal", "U2");
const org = scopeId("org", "default-org");
const grant = (over: Partial<Grant> = {}): Grant => ({
  ownerScopeId: owner,
  ref: "redline.md",
  granteeScopeId: carol,
  permission: "read",
  grantedBy: "U1",
  ...over,
});

test("revoke has the same owner check as grant: a non-owner cannot revoke a personal-scope grant", async () => {
  const acl = createAclStore();
  await acl.grant(grant());
  await assert.rejects(acl.revoke(owner, "redline.md", carol, "U2"), /only a manager/);
  assert.equal((await acl.grantsFor(owner, "redline.md")).length, 1, "the grant survives the rejected revoke");
  await acl.revoke(owner, "redline.md", carol, "U1");
  assert.equal((await acl.grantsFor(owner, "redline.md")).length, 0, "the owner can revoke");
});

test("org-owned grants have no single owner, so revoke is not owner-gated (same as grant)", async () => {
  const acl = createAclStore();
  await acl.grant(grant({ ownerScopeId: org, grantedBy: "admin" }));
  await acl.revoke(org, "redline.md", carol, "someone-else");
  assert.equal((await acl.grantsFor(org, "redline.md")).length, 0);
});

test("POST /v1/grants/revoke requires revokedBy and rejects a non-owner", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "revoke-")) }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/v1/grants", grant())).status, 200);

    const missing = await post("/v1/grants/revoke", { ownerScopeId: owner, ref: "redline.md", granteeScopeId: carol });
    assert.equal(missing.status, 400, "revokedBy is required");

    const forged = await post("/v1/grants/revoke", {
      ownerScopeId: owner,
      ref: "redline.md",
      granteeScopeId: carol,
      revokedBy: "U2",
    });
    assert.equal(forged.status, 400);
    assert.equal(((await forged.json()) as { error: string }).error, "revoke_failed");
    assert.equal((await built.acl.grantsFor(owner, "redline.md")).length, 1, "the grant survives");

    const legit = await post("/v1/grants/revoke", {
      ownerScopeId: owner,
      ref: "redline.md",
      granteeScopeId: carol,
      revokedBy: "U1",
    });
    assert.equal(legit.status, 200);
    assert.equal((await built.acl.grantsFor(owner, "redline.md")).length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a managesResource hook decides skill grants and revokes; undefined falls back to the scope rule", async () => {
  const decided: string[] = [];
  const acl = createAclStore(undefined, {
    managesResource: async (principalId, _ownerScopeId, ref) => {
      decided.push(ref);
      if (!ref.startsWith("skill:")) return undefined;
      return principalId === "admin";
    },
  });
  const skill = grant({ ref: "skill:s1", grantedBy: "admin" });
  await acl.grant(skill);
  await assert.rejects(acl.grant({ ...skill, granteeScopeId: org, grantedBy: "U1" }), /only a manager/);
  await assert.rejects(
    acl.revoke(owner, "skill:s1", carol, "U1"),
    /only a manager/,
    "the hook overrides the owner rule",
  );
  await acl.revoke(owner, "skill:s1", carol, "admin");
  await acl.grant(grant());
  await assert.rejects(acl.revoke(owner, "redline.md", carol, "U2"), /only a manager/);
  await acl.revoke(owner, "redline.md", carol, "U1");
  assert.ok(decided.includes("redline.md"), "the hook is asked about every ref and may pass");
});

test("in the wired app an org admin revokes a shared personal skill's grant, and a stranger cannot", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "acl-skill-hook-")) }));
  const s = await built.skills.create({
    scopeId: owner,
    manifest: { name: "digest", description: "d", requiredCapabilities: [], body: "# d" },
    createdBy: "U1",
  });
  const ref = `skill:${s.id}`;
  await built.acl.grant(grant({ ref }));
  await assert.rejects(built.acl.revoke(owner, ref, carol, "U3"), /only a manager/);
  await built.acl.revoke(owner, ref, carol, "admin-alice");
  assert.deepEqual(await built.acl.grantsFor(owner, ref), []);
});
