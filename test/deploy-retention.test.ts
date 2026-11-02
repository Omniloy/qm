import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployService, MAX_APP_VERSIONS } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

const OWNER = scopeId("personal", "u1");
const HOUR = 3_600_000;

function harness(opts: { mounted?: () => Set<string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deploy-retention-"));
  const deployDir = join(root, "snapshots");
  mkdirSync(deployDir, { recursive: true });
  const deployStore = createDeployStore({ git: { repoRoot: join(root, "repos") } });
  const applied: string[] = [];
  let refuse = false;
  const audits: AuditEvent[] = [];
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async (_d, version) => {
      if (refuse) throw new Error("the entrypoint exited");
      applied.push(version.snapshotDir);
      return { host: "127.0.0.1", port: 8080 };
    },
    destroy: async () => {},
    ...(opts.mounted ? { mountedDirs: async () => opts.mounted!() } : {}),
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    deployDir,
    auditLog: { record: (e) => audits.push(e), events: async () => audits, tail: async () => [] },
    acl: createAclStore(),
  });
  const publish = async (n: number, id?: string) => {
    const files = [{ path: "server.js", data: `v${n}` }];
    if (!id) return deploy.deploy({ ownerScopeId: OWNER, createdBy: "u1", entrypoint: "node server.js", files });
    return deploy.redeploy(id, { entrypoint: "node server.js", files });
  };
  const versions = async (id: string) => (await deployStore.get(id))!.versions;
  return {
    deploy,
    deployStore,
    deployDir,
    applied,
    audits,
    publish,
    versions,
    refuse(on: boolean) {
      refuse = on;
    },
  };
}

async function publishFive(h: ReturnType<typeof harness>) {
  const d = await h.publish(1);
  const dirs = [d.versions[0]!.snapshotDir];
  for (let n = 2; n <= 5; n++) {
    const after = await h.publish(n, d.id);
    dirs.push(after.versions.find((v) => v.version === n)!.snapshotDir);
  }
  return { id: d.id, dirs };
}

test("each publish keeps only the newest copies and deletes older ones with their refs", async () => {
  const h = harness();
  const { id, dirs } = await publishFive(h);
  assert.equal(MAX_APP_VERSIONS, 3);
  assert.deepEqual(
    (await h.versions(id)).map((v) => v.version),
    [3, 4, 5],
  );
  assert.deepEqual(
    dirs.map((dir) => existsSync(dir)),
    [false, false, true, true, true],
  );
  assert.equal(await h.deployStore.refOf(id, "refs/versions/1"), null);
  assert.equal(await h.deployStore.refOf(id, "refs/versions/2"), null);
  assert.ok(await h.deployStore.refOf(id, "refs/versions/3"));
  const pruned = h.audits.filter((e) => e.action === "deploy_versions_pruned");
  assert.ok(pruned.length >= 2);
  assert.ok(pruned.every((e) => e.principalId === "system"));
  assert.ok(JSON.parse(pruned[0]!.detail!).freedBytes > 0);

  const next = await h.publish(6, id);
  assert.equal(next.currentVersion, 6, "numbering continues after deleted versions");
});

test("a publish records the size of its copy", async () => {
  const h = harness();
  const d = await h.deploy.deploy({
    ownerScopeId: OWNER,
    createdBy: "u1",
    entrypoint: "node server.js",
    files: [
      { path: "server.js", data: "12345" },
      { path: "logo.bin", data: new Uint8Array(10) },
    ],
  });
  assert.equal(d.versions[0]!.sizeBytes, 15);
  const r = await h.deploy.redeploy(d.id, { entrypoint: "node server.js", files: [{ path: "a", data: "é" }] });
  assert.equal(r.versions.find((v) => v.version === 2)!.sizeBytes, 2);
});

test("an older current version survives pruning after a rollback", async () => {
  const h = harness();
  const { id, dirs } = await publishFive(h);
  await h.deployStore.addVersion(id, { entrypoint: "node server.js", snapshotDir: "" });
  await h.deploy.rollbackDeployment(id, 3);
  await h.deployStore.addVersion(id, { entrypoint: "node server.js", snapshotDir: "" });
  await h.deploy.rollbackDeployment(id, 3);
  const swept = await h.deploy.sweepDeploymentSnapshots();
  assert.equal(swept.prunedVersions, 1);
  assert.deepEqual(
    (await h.versions(id)).map((v) => v.version),
    [3, 5, 6, 7],
  );
  assert.equal(existsSync(dirs[2]!), true, "the current copy is kept");
  assert.equal(existsSync(dirs[3]!), false);
});

test("a failed redeploy keeps the version still serving", async () => {
  const h = harness();
  const { id, dirs } = await publishFive(h);
  await h.deploy.rollbackDeployment(id, 3);
  h.refuse(true);
  await assert.rejects(h.publish(6, id), /entrypoint exited/);
  h.refuse(false);
  await h.deploy.sweepDeploymentSnapshots();
  const after = (await h.deployStore.get(id))!;
  assert.equal(after.appliedVersion, 3);
  assert.deepEqual(
    after.versions.map((v) => v.version),
    [3, 4, 5, 6],
  );
  assert.equal(existsSync(dirs[2]!), true);
});

test("a copy another version still points at is not deleted", async () => {
  const h = harness();
  const d = await h.publish(1);
  const shared = d.versions[0]!.snapshotDir;
  await h.deployStore.addVersion(d.id, { entrypoint: "node server.js", snapshotDir: shared });
  await h.publish(3, d.id);
  await h.publish(4, d.id);
  assert.deepEqual(
    (await h.versions(d.id)).map((v) => v.version),
    [2, 3, 4],
  );
  assert.equal(existsSync(shared), true);
});

test("a copy a container mounts is never deleted, even once nothing references it", async () => {
  const mounted = new Set<string>();
  const h = harness({ mounted: () => mounted });
  const d = await h.publish(1);
  const kept = d.versions[0]!.snapshotDir;
  mounted.add(kept);
  for (let n = 2; n <= 4; n++) await h.publish(n, d.id);
  assert.deepEqual(
    (await h.versions(d.id)).map((v) => v.version),
    [2, 3, 4],
  );
  assert.equal(existsSync(kept), true);
  await h.deploy.sweepDeploymentSnapshots(Date.now() + 2 * HOUR);
  assert.equal(existsSync(kept), true, "the orphan sweep honors the mount too");
  mounted.clear();
  const swept = await h.deploy.sweepDeploymentSnapshots(Date.now() + 2 * HOUR);
  assert.equal(existsSync(kept), false, "once unmounted, the orphan sweep reclaims it");
  assert.ok(swept.removedDirs >= 1);
});

test("when docker cannot list mounts, nothing is deleted until it can", async () => {
  let broken = true;
  const h = harness({
    mounted: () => {
      if (broken) throw new Error("docker ps failed");
      return new Set();
    },
  });
  const { id, dirs } = await publishFive(h);
  assert.deepEqual(
    (await h.versions(id)).map((v) => v.version),
    [3, 4, 5],
  );
  assert.deepEqual(
    dirs.map((dir) => existsSync(dir)),
    [true, true, true, true, true],
  );
  broken = false;
  await h.deploy.sweepDeploymentSnapshots(Date.now() + 2 * HOUR);
  assert.deepEqual(
    dirs.map((dir) => existsSync(dir)),
    [false, false, true, true, true],
  );
});

test("the orphan sweep removes only old, unreferenced, unmounted copies", async () => {
  const mounted = new Set<string>();
  const h = harness({ mounted: () => mounted });
  const d = await h.publish(1);
  const referenced = d.versions[0]!.snapshotDir;
  const make = (name: string, ageMs: number) => {
    const dir = join(h.deployDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f"), "x".repeat(2048));
    const at = new Date(Date.now() - ageMs);
    utimesSync(dir, at, at);
    return dir;
  };
  const old = make("old-orphan", 2 * HOUR);
  const fresh = make("fresh-orphan", 10 * 60_000);
  const busy = make("mounted-orphan", 2 * HOUR);
  mounted.add(busy);
  const past = new Date(Date.now() - 2 * HOUR);
  utimesSync(referenced, past, past);
  const result = await h.deploy.sweepDeploymentSnapshots();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(busy), true);
  assert.equal(existsSync(referenced), true);
  assert.equal(result.removedDirs, 1);
  assert.ok(result.freedBytes > 0);
});

test("the sweep fills in sizes for copies published before sizes were recorded", async () => {
  const h = harness();
  const d = await h.publish(1);
  const dir = d.versions[0]!.snapshotDir;
  const legacy = await h.deployStore.addVersion(d.id, { entrypoint: "node server.js", snapshotDir: dir });
  assert.equal(legacy.sizeBytes, undefined);
  await h.deploy.sweepDeploymentSnapshots();
  assert.ok(((await h.deployStore.versionOf(d.id, 2))!.sizeBytes ?? 0) > 0);
});

test("applying a version reuses its own recorded copy instead of writing another", async () => {
  const h = harness();
  const d = await h.publish(1);
  const dir = d.versions[0]!.snapshotDir;
  await h.publish(2, d.id);
  await h.deploy.rollbackDeployment(d.id, 1);
  assert.equal(h.applied.at(-1), dir);
  assert.equal(h.applied[0], dir, "the first publish mounts the copy it recorded");
  assert.equal((await h.versions(d.id)).length, 2);
});

test("a missing copy is rewritten once from git and recorded", async () => {
  const h = harness();
  const d = await h.publish(1);
  const v1dir = d.versions[0]!.snapshotDir;
  rmSync(v1dir, { recursive: true, force: true });
  await h.publish(2, d.id);
  await h.deploy.rollbackDeployment(d.id, 1);
  const rewritten = (await h.deployStore.versionOf(d.id, 1))!;
  assert.notEqual(rewritten.snapshotDir, v1dir);
  assert.equal(existsSync(rewritten.snapshotDir), true);
  assert.equal(h.applied.at(-1), rewritten.snapshotDir);
  assert.equal(rewritten.sizeBytes, 2);
});

test("a legacy pushed version that recorded its parent's copy never mounts that copy, even after the parent is deleted", async () => {
  const h = harness();
  const d = await h.publish(1);
  const parentDir = d.versions[0]!.snapshotDir;
  const pushed = await h.deployStore.addVersion(d.id, {
    entrypoint: "node server.js",
    snapshotDir: "",
    files: [{ path: "server.js", data: "v2" }],
  });
  await h.deployStore.setVersionSnapshot(d.id, pushed.version, { snapshotDir: parentDir });
  await h.deployStore.setCurrentVersion(d.id, pushed.version);
  await h.deployStore.setAppliedVersion(d.id, pushed.version);
  assert.deepEqual(await h.deploy.deleteDeploymentVersion(d.id, 1, "u1"), { status: "deleted", freedBytes: 0 });
  assert.equal(existsSync(parentDir), true, "the pushed version still points at it");

  await h.deploy.sweepDeploymentSnapshots();
  assert.equal((await h.deployStore.versionOf(d.id, pushed.version))!.sizeBytes, undefined, "no size for a stale copy");

  await h.deploy.rollbackDeployment(d.id, pushed.version);
  const own = (await h.deployStore.versionOf(d.id, pushed.version))!;
  assert.notEqual(h.applied.at(-1), parentDir);
  assert.equal(h.applied.at(-1), own.snapshotDir);
  assert.equal(readFileSync(join(own.snapshotDir, "server.js"), "utf8"), "v2");
  assert.equal(own.snapshotCommit, own.commit);

  await h.deploy.rollbackDeployment(d.id, pushed.version);
  assert.equal(h.applied.at(-1), own.snapshotDir, "and reuses its own copy afterwards");
});
