import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskService, type DiskRecord } from "../src/disk/disk-service.ts";
import type { DockerApi } from "../src/disk/docker-api.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { deployRepoDir } from "../src/deploy/deploy-git-store.ts";
import { localVolumeName } from "../src/sandbox/local-sandbox.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { PgPool } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";

const SCOPE = scopeId("personal", "U1");

function fill(dir: string, bytes: number): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "f"), "x".repeat(bytes));
  return dir;
}

async function fixture(docker: DockerApi | null, pg: PgPool | null = null) {
  const dataDir = mkdtempSync(join(tmpdir(), "disk-service-"));
  const deployDir = join(dataDir, "deployments");
  const deployGitDir = join(dataDir, "deploy-git");
  const deployStore = createDeployStore();
  const referenced = fill(join(deployDir, "kept"), 8192);
  fill(join(deployDir, "orphan"), 16_384);
  const d = await deployStore.create({
    ownerScopeId: SCOPE,
    createdBy: "U1",
    entrypoint: "x",
    snapshotDir: referenced,
  });
  fill(deployRepoDir(deployGitDir, d.id), 4096);
  const store = createMemoryMap<DiskRecord>();
  const disk = createDiskService({
    dataDir,
    deployDir,
    deployGitDir,
    paths: { docstore: fill(join(dataDir, "docstore"), 4096), workspaces: join(dataDir, "missing") },
    deployStore,
    docker,
    pg,
    store,
  });
  return { disk, store, dataDir, deployment: d };
}

function fakeDocker(appId: string, deleted: string[] = []): DockerApi {
  const scope = scopeId("personal", "U1");
  return {
    async get<T>(path: string): Promise<T> {
      if (path === "/system/df")
        return {
          LayersSize: 1000,
          Images: [{ Size: 600 }, { Size: 400 }],
          BuildCache: [{ Size: 50 }],
          Containers: [
            {
              Id: "c1",
              Names: ["/qm-sbx-run"],
              Labels: { "qm.sandbox": "1", "qm.scope": scope },
              State: "running",
              SizeRw: 30,
            },
            { Id: "c2", Names: ["/qm-sbx-old"], Labels: { "qm.sandbox": "1" }, State: "exited", SizeRw: 70 },
            { Id: "c3", Names: ["/agent-deploy-x"], Labels: {}, State: "running", SizeRw: 5 },
          ],
          Volumes: [
            { Name: localVolumeName(scope), UsageData: { Size: 300 } },
            { Name: "qm-home-orphan", UsageData: { Size: 200 } },
            { Name: `agent-deploy-data-${appId.slice(0, 12)}`, UsageData: { Size: 90 } },
            { Name: "unrelated", UsageData: { Size: 10 } },
          ],
        } as T;
      if (path === "/containers/c2/json")
        return {
          State: { Running: false, StartedAt: "2026-10-01T00:00:00Z", FinishedAt: "2026-10-02T00:00:00Z" },
        } as T;
      if (path === "/containers/qm-sbx-old/json") return { State: { Running: false } } as T;
      if (path === "/containers/qm-sbx-run/json") return { State: { Running: true } } as T;
      throw new Error(`docker GET ${path} returned 404`);
    },
    async del(path: string): Promise<number> {
      deleted.push(path);
      return 204;
    },
  };
}

test("a report sizes the filesystem, components, apps, sandboxes and files, and is stored", async () => {
  const f = await fixture(fakeDocker("another-app-id"));
  assert.equal(await f.disk.latest(), null);
  const report = await f.disk.measure();
  assert.equal(await f.disk.measuring(), false);
  assert.deepEqual(await f.disk.latest(), report);
  assert.ok(report.filesystem && report.filesystem.totalBytes > 0);
  assert.ok(report.filesystem.availableBytes <= report.filesystem.totalBytes);

  const byId = new Map(report.components.map((c) => [c.id, c]));
  assert.equal(byId.get("deployments")?.count, 2);
  assert.ok((byId.get("deployments")?.bytes ?? 0) >= 24_576);
  assert.ok((report.orphanSnapshotBytes ?? 0) >= 16_384);
  assert.ok((report.orphanSnapshotBytes ?? 0) < (byId.get("deployments")?.bytes ?? 0));
  assert.ok((byId.get("deploy-git")?.bytes ?? 0) >= 4096);
  assert.ok((byId.get("docstore")?.bytes ?? 0) >= 4096);
  assert.equal(byId.get("workspaces")?.bytes, null);
  assert.equal(byId.get("postgres")?.bytes, null);
  assert.equal(report.postgres, null);
  assert.deepEqual(report.files, []);

  assert.equal(byId.get("images")?.bytes, 1000);
  assert.equal(byId.get("build-cache")?.bytes, 50);
  assert.equal(byId.get("sandbox-containers")?.bytes, 100);
  assert.equal(byId.get("sandbox-containers")?.note, "stopped containers hold 0.1 KB");
  assert.equal(byId.get("sandbox-volumes")?.bytes, 500);
  assert.equal(report.docker.available, true);
  assert.equal(report.docker.available && report.docker.totalBytes, 1000 + 600 + 105);

  assert.ok((report.apps[f.deployment.id]?.gitBytes ?? 0) >= 4096);
  assert.equal(report.apps[f.deployment.id]?.dataVolumeBytes, null, "the volume belongs to another app id");

  const running = report.sandboxes.find((s) => s.container === "qm-sbx-run")!;
  assert.equal(running.scopeId, scopeId("personal", "U1"));
  assert.equal(running.volume, localVolumeName(scopeId("personal", "U1")));
  assert.equal(running.volumeBytes, 300);
  assert.equal(running.running, true);
  assert.ok((running.lastUsedAt ?? 0) > Date.now() - 60_000);
  const stopped = report.sandboxes.find((s) => s.container === "qm-sbx-old")!;
  assert.equal(stopped.running, false);
  assert.equal(stopped.containerBytes, 70);
  assert.equal(stopped.lastUsedAt, Date.parse("2026-10-02T00:00:00Z"));
  const loose = report.sandboxes.find((s) => s.volume === "qm-home-orphan")!;
  assert.equal(loose.container, null);
  assert.equal(loose.scopeId, null);
  assert.equal(report.sandboxes.length, 3);
});

test("an app's data volume is attributed to that app", async () => {
  let appId = "";
  const docker: DockerApi = {
    get: async <T>(path: string) => fakeDocker(appId).get<T>(path),
    del: async () => 204,
  };
  const f = await fixture(docker);
  appId = f.deployment.id;
  const report = await f.disk.measure();
  assert.equal(report.apps[f.deployment.id]?.dataVolumeBytes, 90);
});

test("without docker the report still covers disk and says why docker is missing", async () => {
  const f = await fixture(null);
  const report = await f.disk.measure();
  assert.deepEqual(report.docker, { available: false, reason: "docker is not configured for this deployment" });
  for (const id of ["images", "sandbox-volumes", "sandbox-containers", "app-volumes", "build-cache"]) {
    assert.equal(report.components.find((c) => c.id === id)?.bytes, null, id);
  }
  assert.deepEqual(report.sandboxes, []);
  assert.ok(report.filesystem);
  assert.equal(await f.disk.removeStoppedContainer("qm-sbx-old"), "unavailable");
});

test("a docker that does not answer degrades to unavailable instead of failing the report", async () => {
  const f = await fixture({
    get: async () => {
      throw new Error("connect ENOENT /var/run/docker.sock");
    },
    del: async () => 500,
  });
  const report = await f.disk.measure();
  assert.equal(report.docker.available, false);
  assert.match(report.docker.available ? "" : report.docker.reason, /ENOENT/);
});

test("postgres sizes and files by scope come from the database, and a missing table yields no files", async () => {
  const queries: string[] = [];
  const pg = {
    q: async (text: string) => {
      queries.push(text);
      if (text.includes("pg_database_size")) return [{ bytes: "123456" }];
      if (text.includes("pg_stat_user_tables"))
        return [
          { name: "session_llm_requests", bytes: "100000" },
          { name: "session_tape", bytes: "20000" },
        ];
      throw new Error('relation "file_artifacts" does not exist');
    },
  } as unknown as PgPool;
  const f = await fixture(null, pg);
  const report = await f.disk.measure();
  assert.deepEqual(report.postgres, {
    totalBytes: 123456,
    tables: [
      { name: "session_llm_requests", bytes: 100000 },
      { name: "session_tape", bytes: 20000 },
    ],
  });
  assert.equal(report.components.find((c) => c.id === "postgres")?.bytes, 123456);
  assert.deepEqual(report.files, []);

  const withFiles = await fixture(null, {
    q: async (text: string) =>
      text.includes("file_artifacts") ? [{ owner_scope_id: SCOPE, bytes: "2048", count: "3" }] : [{ bytes: "1" }],
  } as unknown as PgPool);
  assert.deepEqual((await withFiles.disk.measure()).files, [{ scopeId: SCOPE, bytes: 2048, count: 3 }]);
});

test("measuring is single-flight and visible to every instance sharing the store", async () => {
  const f = await fixture(null);
  const other = createDiskService({
    dataDir: f.dataDir,
    deployDir: f.dataDir,
    deployGitDir: f.dataDir,
    paths: {},
    deployStore: createDeployStore(),
    docker: null,
    pg: null,
    store: f.store,
  });
  const a = f.disk.measure();
  const b = f.disk.measure();
  assert.equal(await f.disk.measuring(), true);
  assert.equal(a, b);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await other.measuring(), true, "another instance sees the measurement in progress");
  const report = await a;
  assert.equal(await f.disk.measuring(), false);
  assert.equal(await other.measuring(), false);
  assert.deepEqual(await other.latest(), report);
});

test("a measuring marker left by a crashed instance expires", async () => {
  const f = await fixture(null);
  await f.store.put("measuring", { startedAt: Date.now() - 31 * 60_000 });
  assert.equal(await f.disk.measuring(), false);
  await f.store.put("measuring", { startedAt: Date.now() - 60_000 });
  assert.equal(await f.disk.measuring(), true);
  assert.equal(await f.disk.latest(), null, "the marker is never mistaken for a report");
});

test("removing a sandbox container keeps its home volume and refuses running or foreign containers", async () => {
  const deleted: string[] = [];
  const f = await fixture(fakeDocker("x", deleted));
  await f.disk.measure();
  assert.equal(await f.disk.removeStoppedContainer("agent-deploy-abc"), "not_found");
  assert.equal(await f.disk.removeStoppedContainer("qm-sbx-run"), "running");
  assert.equal(await f.disk.removeStoppedContainer("qm-sbx-missing"), "not_found");
  assert.equal(await f.disk.removeStoppedContainer("qm-sbx-old"), "removed");
  assert.deepEqual(deleted, ["/containers/qm-sbx-old"]);
  assert.ok(deleted.every((p) => !p.includes("v=1")));
  const after = (await f.disk.latest())!;
  assert.deepEqual(
    after.sandboxes.map((r) => [r.container, r.volume]),
    [
      ["qm-sbx-run", localVolumeName(scopeId("personal", "U1"))],
      [null, "qm-home-orphan"],
    ],
    "the last report stops listing the removed container",
  );
  const containers = after.components.find((c) => c.id === "sandbox-containers");
  assert.deepEqual([containers?.bytes, containers?.count, containers?.note], [30, 1, undefined]);
});
