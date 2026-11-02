import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import type { DeployStore } from "../deploy/deploy-store.ts";
import { deployRepoDir } from "../deploy/deploy-git-store.ts";
import { localVolumeName } from "../sandbox/local-sandbox.ts";
import { dirBytes, fsUsage, type FsUsage } from "../util/disk-usage.ts";
import { errMessage, swallow } from "../util/errors.ts";
import type { DockerApi } from "./docker-api.ts";

type PathComponentId = "docstore" | "session-shares" | "workspaces" | "transfer";
type ComponentId =
  | "deployments"
  | "deploy-git"
  | PathComponentId
  | "postgres"
  | "sandbox-volumes"
  | "sandbox-containers"
  | "app-volumes"
  | "images"
  | "build-cache";

interface DiskComponent {
  id: ComponentId;
  label: string;
  bytes: number | null;
  count?: number;
  path?: string;
  note?: string;
}

interface DiskSandbox {
  scopeId: string | null;
  container: string | null;
  volume: string | null;
  containerBytes: number | null;
  volumeBytes: number | null;
  state: string | null;
  running: boolean;
  lastUsedAt: number | null;
}

export interface DiskReport {
  measuredAt: number;
  durationMs: number;
  filesystem: FsUsage | null;
  components: DiskComponent[];
  postgres: { totalBytes: number; tables: Array<{ name: string; bytes: number }> } | null;
  docker: { available: true; totalBytes: number } | { available: false; reason: string };
  apps: Record<string, { gitBytes: number | null; dataVolumeBytes: number | null }>;
  sandboxes: DiskSandbox[];
  files: Array<{ scopeId: string; bytes: number; count: number }>;
  orphanSnapshotBytes: number | null;
}

export interface DiskService {
  latest(): Promise<DiskReport | null>;
  measure(): Promise<DiskReport>;
  measuring(): Promise<boolean>;
  removeStoppedContainer(name: string): Promise<"removed" | "running" | "not_found" | "unavailable">;
}

export interface DiskServiceDeps {
  dataDir: string;
  deployDir: string;
  deployGitDir: string;
  paths: Partial<Record<PathComponentId, string>>;
  deployStore: DeployStore;
  docker: DockerApi | null;
  pg: PgPool | null;
  store: DurableMap<DiskRecord>;
}

export type DiskRecord = DiskReport | { startedAt: number };

interface DockerDf {
  LayersSize?: number;
  Images?: Array<{ Size?: number }> | null;
  Containers?: Array<{
    Id: string;
    Names?: string[];
    Labels?: Record<string, string> | null;
    State?: string;
    SizeRw?: number;
  }> | null;
  Volumes?: Array<{ Name: string; UsageData?: { Size?: number } | null }> | null;
  BuildCache?: Array<{ Size?: number }> | null;
}

interface DockerInspect {
  State?: { Running?: boolean; StartedAt?: string; FinishedAt?: string };
}

const LATEST = "latest";
const MEASURING = "measuring";
const MEASURE_STALE_MS = 30 * 60_000;
const SANDBOX_CONTAINER_PREFIX = "qm-sbx-";
const SANDBOX_VOLUME_PREFIX = "qm-home-";
const APP_VOLUME_PREFIX = "agent-deploy-data-";
const NO_DOCKER = "docker is not configured for this deployment";
const PATH_LABELS: Record<PathComponentId, string> = {
  docstore: "Uploaded files",
  "session-shares": "Shared conversations",
  workspaces: "Workspaces",
  transfer: "File transfers",
};

const positive = (n: number | undefined | null): number => (typeof n === "number" && n > 0 ? n : 0);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function sizeLabel(bytes: number): string {
  const power = Math.min(3, Math.max(1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024))));
  return `${(bytes / 1024 ** power).toFixed(1)} ${["KB", "MB", "GB"][power - 1]}`;
}

function timestamp(raw: string | undefined): number {
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

async function safely<T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    swallow(`disk: ${label}`, e);
    return fallback;
  }
}

export function createDiskService(deps: DiskServiceDeps): DiskService {
  let inFlight: Promise<DiskReport> | null = null;

  async function measureDeployments(): Promise<{ component: DiskComponent; orphanBytes: number | null }> {
    const entries = await readdir(deps.deployDir).catch(() => null);
    if (!entries) {
      return {
        component: { id: "deployments", label: "App copies", bytes: null, path: deps.deployDir },
        orphanBytes: null,
      };
    }
    const referenced = new Set<string>();
    for (const d of await deps.deployStore.list()) {
      for (const v of d.versions) {
        if (v.snapshotDir) referenced.add(resolve(v.snapshotDir));
        if (v.homeDir) referenced.add(resolve(v.homeDir));
      }
    }
    let total = 0;
    let orphanBytes = 0;
    for (const entry of entries) {
      const path = resolve(join(deps.deployDir, entry));
      const bytes = (await dirBytes(path)) ?? 0;
      total += bytes;
      if (!referenced.has(path)) orphanBytes += bytes;
    }
    return {
      component: {
        id: "deployments",
        label: "App copies",
        bytes: total,
        count: entries.length,
        path: deps.deployDir,
      },
      orphanBytes,
    };
  }

  async function measurePostgres(pg: PgPool): Promise<{
    postgres: DiskReport["postgres"];
    files: DiskReport["files"];
  }> {
    const postgres = await safely("postgres size", null as DiskReport["postgres"], async () => {
      const total = await pg.q("select pg_database_size(current_database())::bigint as bytes");
      const tables = await pg.q(
        "select relname as name, pg_total_relation_size(relid)::bigint as bytes from pg_stat_user_tables order by 2 desc limit 15",
      );
      return {
        totalBytes: Number(total[0]?.bytes ?? 0),
        tables: tables.map((r) => ({ name: String(r.name), bytes: Number(r.bytes) })),
      };
    });
    const files = await safely("files by scope", [] as DiskReport["files"], async () =>
      (
        await pg.q(
          "select owner_scope_id, sum(size_bytes)::bigint as bytes, count(*)::bigint as count from file_artifacts group by 1",
        )
      ).map((r) => ({ scopeId: String(r.owner_scope_id), bytes: Number(r.bytes), count: Number(r.count) })),
    );
    return { postgres, files };
  }

  async function measureDocker(
    docker: DockerApi,
    appIds: string[],
  ): Promise<{
    docker: DiskReport["docker"];
    components: DiskComponent[];
    sandboxes: DiskSandbox[];
    dataVolumes: Map<string, number>;
  }> {
    const df = await docker.get<DockerDf>("/system/df");
    const containers = df.Containers ?? [];
    const volumes = df.Volumes ?? [];
    const volumeBytes = new Map(volumes.map((v) => [v.Name, positive(v.UsageData?.Size)]));
    const sandboxContainers = containers.filter((c) => c.Labels?.["qm.sandbox"] === "1");
    const stoppedBytes = sum(sandboxContainers.filter((c) => c.State !== "running").map((c) => positive(c.SizeRw)));
    const sandboxVolumes = volumes.filter((v) => v.Name.startsWith(SANDBOX_VOLUME_PREFIX));
    const appVolumes = volumes.filter((v) => v.Name.startsWith(APP_VOLUME_PREFIX));
    const now = Date.now();
    const claimed = new Set<string>();
    const sandboxes: DiskSandbox[] = [];
    for (const c of sandboxContainers) {
      const scopeId = c.Labels?.["qm.scope"] || null;
      const volume = scopeId && volumeBytes.has(localVolumeName(scopeId)) ? localVolumeName(scopeId) : null;
      if (volume) claimed.add(volume);
      const running = c.State === "running";
      const lastUsedAt = running
        ? now
        : await safely("inspect sandbox container", null as number | null, async () => {
            const info = await docker.get<DockerInspect>(`/containers/${encodeURIComponent(c.Id)}/json`);
            return Math.max(timestamp(info.State?.StartedAt), timestamp(info.State?.FinishedAt)) || null;
          });
      sandboxes.push({
        scopeId,
        container: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
        volume,
        containerBytes: positive(c.SizeRw),
        volumeBytes: volume ? (volumeBytes.get(volume) ?? null) : null,
        state: c.State ?? null,
        running,
        lastUsedAt,
      });
    }
    for (const v of sandboxVolumes) {
      if (claimed.has(v.Name)) continue;
      sandboxes.push({
        scopeId: null,
        container: null,
        volume: v.Name,
        containerBytes: null,
        volumeBytes: positive(v.UsageData?.Size),
        state: null,
        running: false,
        lastUsedAt: null,
      });
    }
    const dataVolumes = new Map<string, number>();
    for (const id of appIds) {
      const bytes = volumeBytes.get(`${APP_VOLUME_PREFIX}${id.slice(0, 12)}`);
      if (bytes !== undefined) dataVolumes.set(id, bytes);
    }
    const allVolumeBytes = sum([...volumeBytes.values()]);
    const allContainerBytes = sum(containers.map((c) => positive(c.SizeRw)));
    return {
      docker: { available: true, totalBytes: positive(df.LayersSize) + allVolumeBytes + allContainerBytes },
      components: [
        {
          id: "sandbox-volumes",
          label: "Sandbox home volumes",
          bytes: sum(sandboxVolumes.map((v) => positive(v.UsageData?.Size))),
          count: sandboxVolumes.length,
        },
        {
          id: "sandbox-containers",
          label: "Sandbox containers",
          bytes: sum(sandboxContainers.map((c) => positive(c.SizeRw))),
          count: sandboxContainers.length,
          ...(stoppedBytes > 0 ? { note: `stopped containers hold ${sizeLabel(stoppedBytes)}` } : {}),
        },
        {
          id: "app-volumes",
          label: "App data volumes",
          bytes: sum(appVolumes.map((v) => positive(v.UsageData?.Size))),
          count: appVolumes.length,
        },
        {
          id: "images",
          label: "Docker images",
          bytes: sum((df.Images ?? []).map((i) => positive(i.Size))),
          count: (df.Images ?? []).length,
        },
        {
          id: "build-cache",
          label: "Docker build cache",
          bytes: sum((df.BuildCache ?? []).map((b) => positive(b.Size))),
        },
      ],
      sandboxes,
      dataVolumes,
    };
  }

  function dockerUnavailable(reason: string): DiskComponent[] {
    return [
      { id: "sandbox-volumes", label: "Sandbox home volumes", bytes: null, note: reason },
      { id: "sandbox-containers", label: "Sandbox containers", bytes: null, note: reason },
      { id: "app-volumes", label: "App data volumes", bytes: null, note: reason },
      { id: "images", label: "Docker images", bytes: null, note: reason },
      { id: "build-cache", label: "Docker build cache", bytes: null, note: reason },
    ];
  }

  async function run(started: number): Promise<DiskReport> {
    const deployments = await safely("list deployments", [], () => deps.deployStore.list());
    const filesystem = await fsUsage(deps.dataDir);
    const deployed = await safely(
      "app copies",
      {
        component: { id: "deployments", label: "App copies", bytes: null } as DiskComponent,
        orphanBytes: null as number | null,
      },
      measureDeployments,
    );
    const components: DiskComponent[] = [
      deployed.component,
      {
        id: "deploy-git",
        label: "App source history (git)",
        bytes: await dirBytes(deps.deployGitDir),
        path: deps.deployGitDir,
      },
    ];
    for (const [id, path] of Object.entries(deps.paths) as Array<[PathComponentId, string]>) {
      components.push({ id, label: PATH_LABELS[id], bytes: await dirBytes(path), path });
    }
    const pg = deps.pg ? await measurePostgres(deps.pg) : { postgres: null, files: [] };
    components.push({
      id: "postgres",
      label: "Database (Postgres)",
      bytes: pg.postgres?.totalBytes ?? null,
      ...(deps.pg ? {} : { note: "no database configured" }),
    });
    let docker: DiskReport["docker"] = { available: false, reason: NO_DOCKER };
    let sandboxes: DiskSandbox[] = [];
    let dataVolumes = new Map<string, number>();
    if (deps.docker) {
      try {
        const measured = await measureDocker(
          deps.docker,
          deployments.map((d) => d.id),
        );
        docker = measured.docker;
        components.push(...measured.components);
        sandboxes = measured.sandboxes;
        dataVolumes = measured.dataVolumes;
      } catch (e) {
        docker = { available: false, reason: `docker did not answer: ${errMessage(e)}` };
        components.push(...dockerUnavailable(docker.reason));
      }
    } else components.push(...dockerUnavailable(NO_DOCKER));
    const apps: DiskReport["apps"] = {};
    for (const d of deployments) {
      apps[d.id] = {
        gitBytes: await dirBytes(deployRepoDir(deps.deployGitDir, d.id)),
        dataVolumeBytes: dataVolumes.get(d.id) ?? null,
      };
    }
    return {
      measuredAt: started,
      durationMs: Date.now() - started,
      filesystem,
      components,
      postgres: pg.postgres,
      docker,
      apps,
      sandboxes,
      files: pg.files,
      orphanSnapshotBytes: deployed.orphanBytes,
    };
  }

  async function forgetContainer(name: string): Promise<void> {
    const record = await deps.store.get(LATEST);
    if (!record || !("measuredAt" in record)) return;
    const row = record.sandboxes.find((r) => r.container === name);
    if (!row) return;
    const freed = row.containerBytes ?? 0;
    await deps.store.put(LATEST, {
      ...record,
      sandboxes: record.sandboxes.flatMap((r) => {
        if (r !== row) return [r];
        return r.volume ? [{ ...r, container: null, containerBytes: null, state: null, running: false }] : [];
      }),
      components: record.components.map((c) =>
        c.id === "sandbox-containers" && c.bytes !== null
          ? { id: c.id, label: c.label, bytes: Math.max(0, c.bytes - freed), count: Math.max(0, (c.count ?? 1) - 1) }
          : c,
      ),
    });
  }

  return {
    async latest() {
      const record = await deps.store.get(LATEST);
      return record && "measuredAt" in record ? record : null;
    },
    async measuring() {
      if (inFlight) return true;
      const record = await deps.store.get(MEASURING);
      return !!record && "startedAt" in record && Date.now() - record.startedAt < MEASURE_STALE_MS;
    },
    measure() {
      inFlight ??= (async () => {
        const started = Date.now();
        try {
          await deps.store.put(MEASURING, { startedAt: started });
          const report = await run(started);
          await deps.store.put(LATEST, report);
          return report;
        } finally {
          inFlight = null;
          await deps.store.delete(MEASURING).catch((e) => swallow("disk: clear the measuring marker", e));
        }
      })();
      return inFlight;
    },
    async removeStoppedContainer(name) {
      if (!name.startsWith(SANDBOX_CONTAINER_PREFIX) || name.includes("/")) return "not_found";
      if (!deps.docker) return "unavailable";
      const path = `/containers/${encodeURIComponent(name)}`;
      let info: DockerInspect;
      try {
        info = await deps.docker.get<DockerInspect>(`${path}/json`);
      } catch {
        return "not_found";
      }
      if (info.State?.Running) return "running";
      const status = await deps.docker.del(path);
      if (status === 404) return "not_found";
      if (status === 409) return "running";
      if (status < 200 || status >= 300) throw new Error(`docker could not remove ${name} (status ${status})`);
      await forgetContainer(name).catch((e) => swallow(`disk: drop ${name} from the last report`, e));
      return "removed";
    },
  };
}
