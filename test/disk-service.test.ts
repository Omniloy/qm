import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskService, distinctFilesystems, rootOverlayUnder, type DiskRecord } from "../src/disk/disk-service.ts";
import { createDockerApi, type DockerApi } from "../src/disk/docker-api.ts";
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

async function fixture(docker: DockerApi | null, pg: PgPool | null = null, mountinfo?: string) {
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
    ...(mountinfo === undefined ? {} : { mountinfoPath: writeMountinfo(dataDir, mountinfo) }),
  });
  return { disk, store, dataDir, deployment: d };
}

function writeMountinfo(dir: string, content: string): string {
  const path = join(dir, "mountinfo");
  writeFileSync(path, content);
  return path;
}

const CONTAINER_ROOT =
  "5984 4105 0:808 / / rw,relatime master:1395 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/C5LH:/var/lib/docker/overlay2/l/AMVP,upperdir=/var/lib/docker/overlay2/2129170c/diff,workdir=/var/lib/docker/overlay2/2129170c/work,nouserxattr";
const DATA_BIND = "6020 5984 8:1 /opt/qm/data /opt/qm/data rw,relatime - ext4 /dev/sda1 rw,discard,errors=remount-ro";
const HOST_ROOT = "29 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,discard,errors=remount-ro";

function fakeDocker(appId: string, deleted: string[] = []): DockerApi {
  const scope = scopeId("personal", "U1");
  return {
    async get<T>(path: string): Promise<T> {
      if (path === "/info") return { DockerRootDir: "/var/lib/docker" } as T;
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

test("a report sizes components, apps, sandboxes and files, and is stored", async () => {
  const f = await fixture(fakeDocker("another-app-id"));
  assert.equal(await f.disk.latest(), null);
  const report = await f.disk.measure();
  assert.equal(await f.disk.measuring(), false);
  assert.deepEqual(await f.disk.latest(), report);

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
  const filesystems = await f.disk.filesystems();
  assert.deepEqual(
    filesystems.map((fs) => fs.holds),
    [[{ role: "data", path: f.dataDir }]],
  );
  assert.ok(filesystems[0]!.totalBytes > 0);
  assert.ok(filesystems[0]!.availableBytes <= filesystems[0]!.totalBytes);
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

test("Docker's disk is measured through core's own container root when that overlay lives under Docker's root", async () => {
  const f = await fixture(fakeDocker("x"), null, `${CONTAINER_ROOT}\n${DATA_BIND}\n`);
  const holds = (await f.disk.filesystems()).flatMap((fs) => fs.holds);
  assert.deepEqual(
    holds.sort((a, b) => a.role.localeCompare(b.role)),
    [
      { role: "data", path: f.dataDir },
      { role: "docker", path: "/var/lib/docker" },
    ],
  );
});

test("Docker's disk is left unmeasured when core does not run as a container of that Docker", async () => {
  const roles = async (mountinfo: string, docker: DockerApi = fakeDocker("x")) =>
    (await (await fixture(docker, null, mountinfo)).disk.filesystems()).flatMap((fs) => fs.holds.map((h) => h.role));
  assert.deepEqual(await roles(HOST_ROOT), ["data"], "core on the host, not in a container");
  assert.deepEqual(
    await roles(CONTAINER_ROOT.replaceAll("/var/lib/docker/", "/var/lib/containerd/")),
    ["data"],
    "a container root kept outside Docker's root",
  );
  assert.deepEqual(
    await roles(CONTAINER_ROOT, {
      get: async () => {
        throw new Error("connect ENOENT /var/run/docker.sock");
      },
      del: async () => 500,
    }),
    ["data"],
    "docker does not answer",
  );
});

test("the container root is matched on its upper directory under exactly Docker's root", () => {
  assert.equal(rootOverlayUnder(`${CONTAINER_ROOT}\n${DATA_BIND}`, "/var/lib/docker"), true);
  assert.equal(rootOverlayUnder(CONTAINER_ROOT, "/var/lib/docker/"), true);
  assert.equal(rootOverlayUnder(CONTAINER_ROOT, "/var/lib/dock"), false);
  assert.equal(rootOverlayUnder(CONTAINER_ROOT, "/mnt/HC_Volume_107339617/docker"), false);
  assert.equal(rootOverlayUnder(`${CONTAINER_ROOT}\n${HOST_ROOT}`, "/var/lib/docker"), false, "the last / mount wins");
  assert.equal(rootOverlayUnder("garbage / / without a separator", "/var/lib/docker"), false);
  assert.equal(rootOverlayUnder("", "/var/lib/docker"), false);
});

test("two paths on one filesystem become one entry, and used percent leaves out space reserved for root", () => {
  const GB = 1024 ** 3;
  const usage = (path: string, totalBytes: number, usedBytes: number, availableBytes: number) => ({
    path,
    totalBytes,
    usedBytes,
    availableBytes,
  });
  const [shared] = distinctFilesystems([
    { role: "data", usage: usage("/opt/qm/data", 225 * GB, 208 * GB, 8 * GB) },
    { role: "docker", usage: usage("/var/lib/docker", 225 * GB, 208.1 * GB, 7.9 * GB) },
  ]);
  assert.deepEqual(shared!.holds, [
    { role: "data", path: "/opt/qm/data" },
    { role: "docker", path: "/var/lib/docker" },
  ]);
  assert.equal(Math.round(shared!.usedPercent * 10) / 10, 96.3);

  const split = distinctFilesystems([
    { role: "data", usage: usage("/opt/qm/data", 225 * GB, 45 * GB, 168 * GB) },
    { role: "docker", usage: usage("/var/lib/docker", 455 * GB, 165 * GB, 290 * GB) },
  ]);
  assert.deepEqual(
    split.map((fs) => [fs.holds.map((h) => h.role), Math.round(fs.usedPercent)]),
    [
      [["data"], 21],
      [["docker"], 36],
    ],
  );
  const twins = distinctFilesystems([
    { role: "data", usage: usage("/a", 100 * GB, 10 * GB, 90 * GB) },
    { role: "docker", usage: usage("/b", 100 * GB, 60 * GB, 40 * GB) },
  ]);
  assert.equal(twins.length, 2, "same size but different free space are two disks");
  assert.equal(distinctFilesystems([{ role: "data", usage: usage("/x", 0, 0, 0) }])[0]!.usedPercent, 0);
});

test("a Docker daemon that accepts but never answers /info gives up after the short timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docker-sock-"));
  const socketPath = join(dir, "d.sock");
  const held: Socket[] = [];
  const server = createServer((socket) => {
    held.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const started = Date.now();
    await assert.rejects(createDockerApi(socketPath).get("/info", 100), /timed out/);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
