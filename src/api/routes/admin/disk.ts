import { MAX_APP_VERSIONS } from "../../../deploy/deploy-service.ts";
import type { Deployment } from "../../../deploy/deploy-store.ts";
import type { DiskReport } from "../../../disk/disk-service.ts";
import { personIds, personKey } from "../../../directory/person.ts";
import { parseScopeId, scopeId as makeScopeId } from "../../../types.ts";
import { swallow } from "../../../util/errors.ts";
import { snapshotBytes } from "../../app-types.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { discoverScopes } from "./common.ts";

type DiskScopeKind = "personal" | "channel" | "team" | "org" | "group" | "project";

interface DiskApp {
  id: string;
  name?: string;
  displayName?: string;
  url: string;
  ownerScopeId: string;
  createdInScope?: string;
  createdBy: string;
  ownerName?: string;
  ownerEmail?: string;
  status: Deployment["status"];
  alwaysOn: boolean;
  currentVersion: number;
  appliedVersion?: number;
  versions: Array<{ version: number; createdAt: number; sizeBytes: number | null; live: boolean }>;
  snapshotBytes: number;
  gitBytes: number | null;
  dataVolumeBytes: number | null;
  totalBytes: number;
  lastUsedAt: number | null;
  lastUsedSource: "request" | "deploy";
  createdAt: number | null;
}

const ORG_WIDE = "org-wide";

async function admitted(ctx: ApiCtx, action: string, resource: string): Promise<boolean> {
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return false;
  audit(ctx.deps, { principalId: actor.id, action, resource, scopeLabel: ORG_WIDE });
  return true;
}

function appRow(d: Deployment, url: string, report: DiskReport | null, names: Map<string, string>): DiskApp {
  const live = (v: number): boolean => v === d.currentVersion || v === d.appliedVersion;
  const created = d.versions.map((v) => v.createdAt);
  const sizes = report?.apps[d.id];
  const snapshot = snapshotBytes(d);
  const gitBytes = sizes?.gitBytes ?? null;
  const dataVolumeBytes = sizes?.dataVolumeBytes ?? null;
  const ownerEmail = personIds(d.createdBy).find((x) => x.includes("@"));
  const ownerName = names.get(personKey(d.createdBy));
  const lastDeploy = created.length ? Math.max(...created) : null;
  return {
    id: d.id,
    ...(d.name ? { name: d.name } : {}),
    ...(d.displayName ? { displayName: d.displayName } : {}),
    url,
    ownerScopeId: d.ownerScopeId,
    ...(d.createdInScope ? { createdInScope: d.createdInScope } : {}),
    createdBy: d.createdBy,
    ...(ownerName ? { ownerName } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    status: d.status,
    alwaysOn: d.alwaysOn === true,
    currentVersion: d.currentVersion,
    ...(d.appliedVersion !== undefined ? { appliedVersion: d.appliedVersion } : {}),
    versions: d.versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      sizeBytes: v.sizeBytes ?? null,
      live: live(v.version),
    })),
    snapshotBytes: snapshot,
    gitBytes,
    dataVolumeBytes,
    totalBytes: snapshot + (gitBytes ?? 0) + (dataVolumeBytes ?? 0),
    lastUsedAt: d.lastAccessAt ?? lastDeploy,
    lastUsedSource: d.lastAccessAt !== undefined ? "request" : "deploy",
    createdAt: created.length ? Math.min(...created) : null,
  };
}

export async function getDisk(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  if (!(await admitted(ctx, "disk.read", "disk"))) return;
  const org = orgScope(deps);
  const [report, deployments, days] = await Promise.all([
    deps.disk?.latest() ?? null,
    app.listDeployments(),
    deps.config?.getAppIdleStopDaysDurable(org) ?? null,
  ]);
  const extra = [
    ...deployments.flatMap((d) => [d.ownerScopeId, d.createdInScope ?? "", makeScopeId("personal", d.createdBy)]),
    ...(report?.sandboxes.map((s) => s.scopeId ?? "") ?? []),
    ...(report?.files.map((f) => f.scopeId) ?? []),
  ].filter(Boolean);
  const [labels, members] = await Promise.all([discoverScopes(app, deps, extra), app.directoryMembers()]);
  const names = new Map(members.map((m) => [personKey(m.principalId), m.displayName]));
  const scopes: Array<{ id: string; label: string; kind: DiskScopeKind }> = [];
  for (const [id, label] of labels) {
    const { kind, ref } = parseScopeId(id);
    if (!kind) continue;
    if (kind === "group" && deps.projects?.recognizes(ref)) {
      const name = await deps.projects.name(ref).catch(() => undefined);
      scopes.push({ id, label: name ?? (label || ref), kind: "project" });
    } else scopes.push({ id, label: label || ref, kind });
  }
  sendJson(res, 200, {
    report,
    measuring: (await deps.disk?.measuring()) ?? false,
    orgScopeId: org,
    retention: { maxVersions: MAX_APP_VERSIONS },
    autoStop: {
      days,
      envTtlMs: deps.diskPolicy?.deployIdleTtlMs ?? null,
      managedScaleToZero: deps.diskPolicy?.managedScaleToZero ?? false,
    },
    scopes,
    apps: deployments.map((d) => appRow(d, app.deploymentUrl(d), report, names)),
  });
}

export async function measureDisk(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  if (!(await admitted(ctx, "disk.measure", "disk"))) return;
  if (!deps.disk) return sendJson(res, 503, { error: "disk_unavailable" });
  if (!(await deps.disk.measuring())) void deps.disk.measure().catch((e) => swallow("disk: measure", e));
  sendJson(res, 202, { measuring: true });
}

export async function stopDiskApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  if (!(await admitted(ctx, "disk.app_stop", params.id!))) return;
  const d = await app.getDeployment(params.id!);
  if (!d) return sendJson(res, 404, { error: "not_found" });
  sendJson(res, 200, { stopped: await app.stopDeployment(d.id) });
}

export async function deleteDiskApp(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  if (!(await admitted(ctx, "disk.app_delete", params.id!))) return;
  const d = await app.getDeployment(params.id!);
  if (!d || !(await app.deleteDeployment(d.id))) return sendJson(res, 404, { error: "not_found" });
  sendJson(res, 200, { deleted: true });
}

export async function deleteDiskAppVersion(ctx: ApiCtx): Promise<void> {
  const { res, app, params } = ctx;
  if (!(await admitted(ctx, "disk.version_delete", `${params.id!}@v${params.version!}`))) return;
  const version = Number(params.version);
  if (!/^\d+$/.test(params.version ?? "") || !Number.isSafeInteger(version))
    return sendJson(res, 400, { error: "bad_request", message: "version must be an integer" });
  const d = await app.getDeployment(params.id!);
  if (!d) return sendJson(res, 404, { error: "not_found" });
  const result = await app.deleteDeploymentVersion(d.id, version);
  if (result.status === "live") return sendJson(res, 409, { error: "version_live" });
  if (result.status === "not_found") return sendJson(res, 404, { error: "not_found" });
  sendJson(res, 200, { deleted: true, freedBytes: result.freedBytes });
}

export async function removeDiskSandboxContainer(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  if (!(await admitted(ctx, "disk.sandbox_container_remove", params.name!))) return;
  if (!deps.disk) return sendJson(res, 503, { error: "docker_unavailable" });
  const result = await deps.disk.removeStoppedContainer(params.name!);
  if (result === "removed") return sendJson(res, 200, { removed: true });
  if (result === "running") return sendJson(res, 409, { error: "container_running" });
  if (result === "not_found") return sendJson(res, 404, { error: "not_found" });
  sendJson(res, 503, { error: "docker_unavailable" });
}
