import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";

const OWNER = scopeId("personal", "u1");

function harness() {
  const started: string[] = [];
  let refuse: string | null = null;
  let gone = false;
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async (_d, version) => {
        if (refuse !== null && version.entrypoint === refuse) {
          throw new Error(`the entrypoint exited (status 127) without binding port 8080`);
        }
        started.push(version.entrypoint);
        gone = false;
        return { host: "127.0.0.1", port: 20500 + version.version };
      },
      destroy: async () => {
        gone = true;
      },
      resolveEndpoint: async (d) => (gone ? null : (d.endpoint ?? null)),
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-revert-")),
  });
  return {
    deploy,
    started: () => started,
    refuseEntrypoint: (e: string | null) => {
      refuse = e;
    },
    vanishContainer: () => {
      gone = true;
    },
  };
}

const files = [{ path: "server.js", data: "x" }];

test("a redeploy that will not start leaves the previous version serving", async () => {
  // Without this, apply() removed the working container, threw before
  // markVersionRunning, and left the store saying "running" at an address
  // nothing answered — so the link 502'd forever with no way back.
  const h = harness();
  const d = await h.deploy.deploy({
    ownerScopeId: OWNER,
    createdBy: "u1",
    entrypoint: "node server.js",
    files,
  });

  h.refuseEntrypoint("server.js");
  await assert.rejects(() => h.deploy.redeploy(d.id, { entrypoint: "server.js", files }), /exited \(status 127\)/);

  const after = await h.deploy.getDeployment(d.id);
  assert.equal(after?.status, "running", "the app should still be up on its last good version");
  assert.equal(after?.currentVersion, 2, "the candidate stays recorded as what was asked for");
  assert.equal(after?.appliedVersion, 1, "but v1 is what is actually serving");
  assert.deepEqual(h.started(), ["node server.js", "node server.js"], "v1 should have been put back");

  const reach = await h.deploy.reachDeployment(d.id, "u1", { bypassAcl: true });
  assert.equal(reach.status, "ok");
});

test("a first publish that will not start is stopped, not left claiming to run", async () => {
  // There is no previous version to fall back to, so the honest answer is that
  // the app is not running: reach must 404 rather than hand out a link to a
  // port with nothing behind it.
  const h = harness();
  h.refuseEntrypoint("server.js");

  await assert.rejects(
    () => h.deploy.deploy({ ownerScopeId: OWNER, createdBy: "u1", entrypoint: "server.js", files }),
    /exited \(status 127\)/,
  );

  const all = await h.deploy.listDeployments();
  assert.equal(all.length, 1);
  assert.notEqual(all[0]!.status, "running", "a deployment that never started must not claim to be running");
  assert.equal((await h.deploy.reachDeployment(all[0]!.id, "u1", { bypassAcl: true })).status, "not_found");
});

test("a rollback to a version that will not start does not strand the app", async () => {
  const h = harness();
  const d = await h.deploy.deploy({
    ownerScopeId: OWNER,
    createdBy: "u1",
    entrypoint: "node server.js",
    files,
  });
  await h.deploy.redeploy(d.id, { entrypoint: "node v2.js", files });

  h.refuseEntrypoint("node server.js");
  await assert.rejects(() => h.deploy.rollbackDeployment(d.id, 1), /exited \(status 127\)/);

  const after = await h.deploy.getDeployment(d.id);
  assert.equal(after?.status, "running");
  assert.equal(after?.appliedVersion, 2, "the version that still starts should be the one serving");
});

test("a failed redeploy does not resurrect an app the reaper stopped", async () => {
  // The revert path relaunches whatever was serving before the attempt — but a
  // deployment the idle reaper deliberately shut down was serving nothing, and
  // bringing it back would reset its idle clock and burn its memory budget on
  // stale code every time a broken push lands.
  const h = harness();
  const d = await h.deploy.deploy({
    ownerScopeId: OWNER,
    createdBy: "u1",
    entrypoint: "node server.js",
    files,
  });
  assert.equal(await h.deploy.reapIdleDeployments(-1), 1);
  assert.equal((await h.deploy.getDeployment(d.id))?.status, "stopped");
  const beforeStarts = h.started().length;

  h.refuseEntrypoint("server.js");
  await assert.rejects(() => h.deploy.redeploy(d.id, { entrypoint: "server.js", files }), /exited \(status 127\)/);

  assert.equal((await h.deploy.getDeployment(d.id))?.status, "stopped", "it should still be stopped");
  assert.equal(h.started().length, beforeStarts, "nothing should have been relaunched");
});

test("a transient failure while repairing leaves the app recoverable", async () => {
  // Marking the deployment stopped here would be a one-way door: the reaper
  // owns that state and only a fresh deploy leaves it, so a docker blip would
  // 404 a healthy app forever.
  const h = harness();
  const d = await h.deploy.deploy({
    ownerScopeId: OWNER,
    createdBy: "u1",
    entrypoint: "node server.js",
    files,
  });

  h.vanishContainer();
  h.refuseEntrypoint("node server.js");
  await assert.rejects(() => h.deploy.reachDeployment(d.id, "u1", { bypassAcl: true }), /exited \(status 127\)/);

  h.refuseEntrypoint(null);
  const again = await h.deploy.reachDeployment(d.id, "u1", { bypassAcl: true });
  assert.equal(again.status, "ok", "once docker recovers, the next request should repair the app");
});
