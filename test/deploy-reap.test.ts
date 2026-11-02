import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { appIdleStopTtlMs, createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";

function svc(managedScaleToZero: boolean) {
  const deployStore = createDeployStore();
  let destroys = 0;
  let applies = 0;
  let refuse = false;
  const provider: DeployProvider = {
    profile: { managedScaleToZero },
    apply: async (_d, version) => {
      if (refuse || version.entrypoint === "broken") throw new Error("the entrypoint exited");
      applies++;
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {
      destroys++;
    },
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "reap-")),
  });
  return {
    deploy,
    deployStore,
    get destroys() {
      return destroys;
    },
    get applies() {
      return applies;
    },
    refuse(on: boolean) {
      refuse = on;
    },
  };
}

const future = Date.now() + 1_000_000;

test("unmanaged provider: an idle deployment is reaped (destroyed, stopped, endpoint cleared)", async () => {
  const { deploy, deployStore } = svc(false);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal((await deployStore.get(d.id))!.status, "running");

  const stopped = await deploy.reapIdleDeployments(60_000, future);
  assert.equal(stopped, 1);
  assert.equal((await deployStore.get(d.id))!.status, "stopped");
  assert.equal((await deployStore.get(d.id))!.endpoint, null);
});

test("managed provider: reap is a no-op — the platform sleeps/wakes it, endpoint stays valid", async () => {
  const { deploy, deployStore, destroys } = svc(true);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });

  const stopped = await deploy.reapIdleDeployments(60_000, future);
  assert.equal(stopped, 0);
  assert.equal(destroys, 0);
  assert.equal((await deployStore.get(d.id))!.status, "running");
  assert.deepEqual((await deployStore.get(d.id))!.endpoint, { host: "127.0.0.1", port: 5000 });
});

test("unmanaged provider: an always-on deployment is never reaped", async () => {
  const { deploy, deployStore } = svc(false);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await deploy.setDeploymentAlwaysOn(d.id, true);

  const stopped = await deploy.reapIdleDeployments(60_000, future);
  assert.equal(stopped, 0);
  assert.equal((await deployStore.get(d.id))!.status, "running");
});

test("an explicit stop takes down even an always-on app, audits the actor, and reports when nothing ran", async () => {
  const { deploy, deployStore } = svc(false);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await deploy.setDeploymentAlwaysOn(d.id, true);
  assert.equal(await deploy.stopDeployment(d.id, "admin@x"), true);
  const after = (await deployStore.get(d.id))!;
  assert.equal(after.status, "stopped");
  assert.equal(after.endpoint, null);
  assert.equal(await deploy.stopDeployment(d.id), false);
  assert.equal(await deploy.stopDeployment("missing"), false);
});

test("the idle-stop threshold prefers the org setting in days, then the deployment env, else off", () => {
  assert.equal(appIdleStopTtlMs(7, 60_000), 7 * 86_400_000);
  assert.equal(appIdleStopTtlMs(null, 60_000), 60_000);
  assert.equal(appIdleStopTtlMs(null, 0), undefined);
  assert.equal(appIdleStopTtlMs(null, undefined), undefined);
});

test("a stopped app starts again on its next visit, but an archived one stays down", async () => {
  const h = svc(false);
  const d = await h.deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal(await h.deploy.stopDeployment(d.id, "admin"), true);
  assert.equal((await h.deployStore.get(d.id))!.status, "stopped");

  h.refuse(true);
  assert.deepEqual(await h.deploy.reachDeployment(d.id, "U1"), { status: "not_found" });
  assert.equal((await h.deployStore.get(d.id))!.status, "stopped", "a failed wake leaves it stopped");

  h.refuse(false);
  const applied = h.applies;
  const reach = await h.deploy.reachDeployment(d.id, "U1");
  assert.equal(reach.status, "ok");
  assert.equal(h.applies, applied + 1);
  const woken = (await h.deployStore.get(d.id))!;
  assert.equal(woken.status, "running");
  assert.deepEqual(woken.endpoint, { host: "127.0.0.1", port: 5000 });

  assert.deepEqual(await h.deploy.reachDeployment(d.id, "U2"), { status: "denied" });

  await h.deploy.archiveDeployment(d.id);
  assert.deepEqual(await h.deploy.reachDeployment(d.id, "U1"), { status: "not_found" });
  assert.equal((await h.deployStore.get(d.id))!.status, "archived");
});

test("a stopped app whose last redeploy failed wakes on the version that was running", async () => {
  const h = svc(false);
  const d = await h.deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "good",
    files: [],
  });
  await assert.rejects(() => h.deploy.redeploy(d.id, { entrypoint: "broken", files: [] }), /exited/);
  const failed = (await h.deployStore.get(d.id))!;
  assert.equal(failed.currentVersion, 2);
  assert.equal(failed.appliedVersion, 1);
  assert.equal(await h.deploy.stopDeployment(d.id, "admin"), true);

  assert.equal((await h.deploy.reachDeployment(d.id, "U1")).status, "ok");
  const woken = (await h.deployStore.get(d.id))!;
  assert.equal(woken.status, "running");
  assert.equal(woken.appliedVersion, 1);
});
