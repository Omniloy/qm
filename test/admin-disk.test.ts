import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { buildApp } from "../src/wiring.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DiskReport, DiskService } from "../src/disk/disk-service.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const ALICE = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const RANDO = { "content-type": "application/json", "x-admin-actor": "rando@default-org" };
const ORG = "org:default-org";

function fakeDisk(report: DiskReport | null = null) {
  let measured = 0;
  let busy = false;
  const removed: string[] = [];
  const disk: DiskService = {
    latest: async () => report,
    measure: async () => {
      measured++;
      return report!;
    },
    measuring: async () => busy,
    removeStoppedContainer: async (name) => {
      if (!name.startsWith("qm-sbx-")) return "not_found";
      if (name === "qm-sbx-busy") return "running";
      removed.push(name);
      return "removed";
    },
  };
  return {
    disk,
    removed,
    get measured() {
      return measured;
    },
    busy(on: boolean) {
      busy = on;
    },
  };
}

async function start(opts: { disk?: DiskService | null } = {}) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-disk-")) }));
  const destroyed: string[] = [];
  const deploy = createDeployService({
    deployStore: createDeployStore({ git: { repoRoot: mkdtempSync(join(tmpdir(), "admin-disk-git-")) } }),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 9100 }),
      destroy: async (d) => {
        destroyed.push(d.id);
      },
    },
    auditLog: built.auditLog,
    acl: built.acl,
    deployDir: mkdtempSync(join(tmpdir(), "admin-disk-deploy-")),
  });
  const app: App = {
    ...built.app,
    listDeployments: () => deploy.listDeployments(),
    getDeployment: (id) => deploy.getDeployment(id),
    deploymentUrl: (d) => deploy.appUrl(d),
    stopDeployment: (id, actor) => deploy.stopDeployment(id, actor),
    deleteDeployment: (id, actor) => deploy.deleteDeployment(id, actor),
    deleteDeploymentVersion: (id, v, actor) => deploy.deleteDeploymentVersion(id, v, actor),
  };
  await built.directory.replace([{ principalId: "bob@acme.test", displayName: "Bob Builder", type: "internal" }]);
  const files = (n: number) => [{ path: "server.js", data: "x".repeat(n) }];
  const big = await deploy.deploy({
    ownerScopeId: scopeId("personal", "bob@acme.test"),
    createdBy: "bob@acme.test",
    name: "big-demo",
    entrypoint: "node server.js",
    files: files(100),
  });
  await deploy.redeploy(big.id, { entrypoint: "node server.js", files: files(200) });
  const disk = opts.disk === undefined ? fakeDisk().disk : opts.disk;
  const server = createInsecureTestServer(app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    config: built.config,
    ...(disk ? { disk } : {}),
    diskPolicy: { deployIdleTtlMs: 3_600_000, managedScaleToZero: false },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, headers: Record<string, string> = ALICE) =>
    fetch(base + path, { method, headers });
  return {
    built,
    deploy,
    big,
    destroyed,
    call,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const ROUTES: Array<[string, string]> = [
  ["GET", "/v1/admin/disk"],
  ["POST", "/v1/admin/disk/measure"],
  ["POST", "/v1/admin/disk/apps/big-demo/stop"],
  ["DELETE", "/v1/admin/disk/apps/big-demo"],
  ["DELETE", "/v1/admin/disk/apps/big-demo/versions/1"],
  ["DELETE", "/v1/admin/disk/sandbox-containers/qm-sbx-old"],
];

test("every disk route refuses a non-admin and changes nothing", async () => {
  const s = await start();
  try {
    for (const [method, path] of ROUTES) {
      assert.equal((await s.call(method, path, RANDO)).status, 403, `${method} ${path}`);
    }
    const d = (await s.deploy.getDeployment(s.big.id))!;
    assert.equal(d.status, "running");
    assert.equal(d.versions.length, 2);
  } finally {
    await s.close();
  }
});

test("the disk view joins live apps with the cached report before anything is measured", async () => {
  const s = await start();
  try {
    await s.built.config.setAppIdleStopDays(ORG, 14);
    const r = await s.call("GET", "/v1/admin/disk");
    assert.equal(r.status, 200);
    const view = (await r.json()) as {
      report: unknown;
      measuring: boolean;
      orgScopeId: string;
      retention: { maxVersions: number };
      autoStop: { days: number | null; envTtlMs: number | null; managedScaleToZero: boolean };
      scopes: Array<{ id: string; label: string; kind: string }>;
      apps: Array<Record<string, unknown> & { versions: Array<Record<string, unknown>> }>;
    };
    assert.equal(view.report, null);
    assert.equal(view.measuring, false);
    assert.equal(view.orgScopeId, ORG);
    assert.deepEqual(view.retention, { maxVersions: 3 });
    assert.deepEqual(view.autoStop, { days: 14, envTtlMs: 3_600_000, managedScaleToZero: false });
    const owner = view.scopes.find((x) => x.id === scopeId("personal", "bob@acme.test"));
    assert.equal(owner?.kind, "personal");
    assert.equal(owner?.label, "Bob Builder");
    assert.ok(view.scopes.some((x) => x.id === ORG && x.kind === "org"));

    const app = view.apps.find((a) => a.name === "big-demo")!;
    assert.equal(app.ownerEmail, "bob@acme.test");
    assert.equal(app.ownerName, "Bob Builder");
    assert.equal(app.status, "running");
    assert.equal(app.lastUsedSource, "deploy");
    assert.equal(typeof app.lastUsedAt, "number");
    assert.equal(app.snapshotBytes, 300);
    assert.equal(app.gitBytes, null);
    assert.equal(app.totalBytes, 300);
    assert.deepEqual(
      app.versions.map((v) => [v.version, v.sizeBytes, v.live]),
      [
        [1, 100, false],
        [2, 200, true],
      ],
    );

    await s.deploy.reachDeployment(s.big.id, "bob@acme.test", { bypassAcl: true });
    const after = (await (await s.call("GET", "/v1/admin/disk")).json()) as typeof view;
    assert.equal(after.apps.find((a) => a.name === "big-demo")!.lastUsedSource, "request");
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "disk.read" && e.scopeLabel === "org-wide"));
  } finally {
    await s.close();
  }
});

test("measure starts in the background and needs a disk service", async () => {
  const fake = fakeDisk();
  const s = await start({ disk: fake.disk });
  try {
    const r = await s.call("POST", "/v1/admin/disk/measure");
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { measuring: true });
    assert.equal(fake.measured, 1);
    fake.busy(true);
    assert.equal((await s.call("POST", "/v1/admin/disk/measure")).status, 202);
    assert.equal(fake.measured, 1, "a measurement already running elsewhere is not started twice");
    const view = (await (await s.call("GET", "/v1/admin/disk")).json()) as { measuring: boolean };
    assert.equal(view.measuring, true);
  } finally {
    await s.close();
  }
  const none = await start({ disk: null });
  try {
    assert.equal((await none.call("POST", "/v1/admin/disk/measure")).status, 503);
    assert.equal((await none.call("GET", "/v1/admin/disk")).status, 200);
    assert.equal((await none.call("DELETE", "/v1/admin/disk/sandbox-containers/qm-sbx-old")).status, 503);
  } finally {
    await none.close();
  }
});

test("admins stop apps, delete old copies and whole apps, each audited", async () => {
  const s = await start();
  try {
    const live = await s.call("DELETE", "/v1/admin/disk/apps/big-demo/versions/2");
    assert.equal(live.status, 409);
    assert.deepEqual(await live.json(), { error: "version_live" });
    assert.equal((await s.call("DELETE", "/v1/admin/disk/apps/big-demo/versions/7")).status, 404);
    assert.equal((await s.call("DELETE", "/v1/admin/disk/apps/big-demo/versions/x")).status, 400);
    const old = await s.call("DELETE", "/v1/admin/disk/apps/big-demo/versions/1");
    assert.equal(old.status, 200);
    assert.equal(((await old.json()) as { deleted: boolean }).deleted, true);
    assert.deepEqual(
      (await s.deploy.getDeployment(s.big.id))!.versions.map((v) => v.version),
      [2],
    );

    const stop = await s.call("POST", "/v1/admin/disk/apps/big-demo/stop");
    assert.deepEqual(await stop.json(), { stopped: true });
    assert.equal((await s.deploy.getDeployment(s.big.id))!.status, "stopped");
    assert.deepEqual(await (await s.call("POST", "/v1/admin/disk/apps/big-demo/stop")).json(), { stopped: false });
    assert.equal((await s.call("POST", "/v1/admin/disk/apps/nope/stop")).status, 404);

    const del = await s.call("DELETE", "/v1/admin/disk/apps/big-demo");
    assert.equal(del.status, 200);
    assert.equal(await s.deploy.getDeployment(s.big.id), null);
    assert.equal((await s.call("DELETE", "/v1/admin/disk/apps/big-demo")).status, 404);

    const actions = (await s.built.auditLog.events())
      .filter((e) => e.action.startsWith("disk.") && e.principalId.startsWith("admin-alice"))
      .map((e) => e.action);
    for (const action of ["disk.version_delete", "disk.app_stop", "disk.app_delete"]) {
      assert.ok(actions.includes(action), `${action} in ${actions.join(",")}`);
    }
  } finally {
    await s.close();
  }
});

test("sandbox container removal only takes stopped qm sandboxes", async () => {
  const fake = fakeDisk();
  const s = await start({ disk: fake.disk });
  try {
    assert.equal((await s.call("DELETE", "/v1/admin/disk/sandbox-containers/qm-sbx-busy")).status, 409);
    assert.equal((await s.call("DELETE", "/v1/admin/disk/sandbox-containers/agent-deploy-x")).status, 404);
    const ok = await s.call("DELETE", "/v1/admin/disk/sandbox-containers/qm-sbx-old");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { removed: true });
    assert.deepEqual(fake.removed, ["qm-sbx-old"]);
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "disk.sandbox_container_remove"),
      "audited",
    );
  } finally {
    await s.close();
  }
});
