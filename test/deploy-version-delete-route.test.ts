import { existsSync, mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { isUnclassifiedWrite, isUserScoped } from "../src/api/user-scoped-routes.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { deployRef, encodeRef } from "../src/acl/resource-ref.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const SECRET = "deploy-version-delete-secret".repeat(3);

async function fixture() {
  const deployStore = createDeployStore({ git: { repoRoot: mkdtempSync(join(tmpdir(), "version-delete-repo-")) } });
  const acl = createAclStore();
  const directory = createDirectoryStore();
  const audits: AuditEvent[] = [];
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 19996 }),
      destroy: async () => {},
    },
    auditLog: { record: (e) => audits.push(e), events: async () => audits, tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "version-delete-deploy-")),
    canReadScope: createCanReadScope({ directory }),
    canWriteScope: createCanWriteScope({ directory }),
  });
  const app = createApp({
    deploy,
    acl,
    directory,
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  const server: Server = createServer(app, { signingSecret: SECRET });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const files = (n: number) => [{ path: "server.js", data: `v${n}` }];
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "OWNER"),
    createdBy: "OWNER",
    name: "trimmed",
    entrypoint: "node server.js",
    files: files(1),
  });
  await deploy.redeploy(d.id, { entrypoint: "node server.js", files: files(2) });
  await deploy.redeploy(d.id, { entrypoint: "node server.js", files: files(3) });
  const grant = async (who: string, permission: "read" | "write") =>
    acl.grant({
      ownerScopeId: d.ownerScopeId,
      ref: encodeRef(deployRef(d.id)),
      granteeScopeId: scopeId("personal", who),
      permission,
      grantedBy: "OWNER",
    });
  const del = async (actor: string, version: string | number, id = d.id) =>
    fetch(`${base}/v1/deployments/${encodeURIComponent(id)}/versions/${version}`, {
      method: "DELETE",
      headers: {
        "x-agent-capability": await mintCapabilityToken(
          {
            actorId: actor,
            scopeId: scopeId("personal", actor),
            aud: CONTROL_PLANE_AUD,
            liveActor: true,
            exp: Date.now() + CAPABILITY_TTL_MS,
          },
          SECRET,
        ),
      },
    });
  return {
    d,
    deployStore,
    audits,
    grant,
    del,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("the version delete route is a user-scoped write", () => {
  assert.equal(isUserScoped("DELETE", "/v1/deployments/abc/versions/2"), true);
  assert.equal(isUnclassifiedWrite("DELETE", "/v1/deployments/abc/versions/2"), false);
});

test("only someone who manages the app can delete its old copies", async () => {
  const f = await fixture();
  try {
    await f.grant("READER", "read");
    assert.equal((await f.del("STRANGER", 1)).status, 403);
    assert.equal((await f.del("READER", 1)).status, 403);
    assert.equal((await f.deployStore.get(f.d.id))!.versions.length, 3);

    const v1dir = (await f.deployStore.versionOf(f.d.id, 1))!.snapshotDir;
    const owner = await f.del("OWNER", 1);
    assert.equal(owner.status, 200);
    const body = (await owner.json()) as { deleted: boolean; freedBytes: number };
    assert.equal(body.deleted, true);
    assert.ok(body.freedBytes > 0);
    assert.equal(existsSync(v1dir), false);
    assert.ok(f.audits.some((e) => e.action === "deploy_version_delete" && e.principalId === "OWNER"));

    await f.grant("EDITOR", "write");
    const editor = await f.del("EDITOR", 2, "trimmed");
    assert.equal(editor.status, 200, "a write grantee may delete too, by app name");
    assert.deepEqual(
      (await f.deployStore.get(f.d.id))!.versions.map((v) => v.version),
      [3],
    );
  } finally {
    await f.close();
  }
});

test("the live copy cannot be deleted, unknown ones are 404, and junk versions are 400", async () => {
  const f = await fixture();
  try {
    const live = await f.del("OWNER", 3);
    assert.equal(live.status, 409);
    assert.deepEqual(await live.json(), {
      error: "version_live",
      message: "the live version cannot be deleted",
    });
    assert.equal((await f.del("OWNER", 9)).status, 404);
    assert.equal((await f.del("OWNER", 1, "no-such-app")).status, 404);
    assert.equal((await f.del("OWNER", "two")).status, 400);
    assert.equal((await f.del("OWNER", "1.5")).status, 400);
  } finally {
    await f.close();
  }
});
