import type { InviteMailer } from "../admin/invite-email.ts";
import { escapeHtml } from "../api/http.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { personIds, personKey } from "../directory/person.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { principalDestination } from "../reach/reach.ts";
import { adminDiskUrl } from "../util/admin-links.ts";
import { swallowAs } from "../util/errors.ts";
import { sizeLabel, type DiskFilesystem, type FilesystemRole } from "./disk-service.ts";

export const DISK_ALERT_LEVELS = [85, 90, 95] as const;
const REARM_BELOW_PERCENT = 80;
const ROLE_LABELS: Record<FilesystemRole, string> = { data: "QM data", docker: "Docker" };

export interface DiskAlertRecord {
  level: number;
  since: number;
}

export interface DiskAlertDeps {
  filesystems(): Promise<DiskFilesystem[]>;
  admins(): Promise<string[]>;
  store: DurableMap<DiskAlertRecord>;
  deliveries: Pick<DeliveryStore, "enqueue">;
  mailer?: InviteMailer;
  orgId: string;
  publicWebUrl?: string;
  now?: () => number;
}

type Instance = Pick<DiskAlertDeps, "orgId" | "publicWebUrl">;

function instanceName(deps: Instance): string {
  try {
    return deps.publicWebUrl ? new URL(deps.publicWebUrl).host : deps.orgId;
  } catch {
    return deps.orgId;
  }
}

function diskAlertMessage(fs: DiskFilesystem, deps: Instance): { subject: string; text: string; html: string } {
  const instance = instanceName(deps);
  const percent = Math.floor(fs.usedPercent);
  const holds = fs.holds.map((h) => ROLE_LABELS[h.role]).join(" and ");
  const paths = fs.holds.map((h) => h.path).join(", ");
  const url = deps.publicWebUrl ? adminDiskUrl(deps.publicWebUrl) : null;
  const lines = [
    `Disk alert on ${instance}: the disk holding ${holds} (${paths}) is ${percent}% full, with ${sizeLabel(fs.availableBytes)} free of ${sizeLabel(fs.totalBytes)}.`,
    "When it fills up, QM stops working.",
    url
      ? `See what is using it and free space in the Disk tab: ${url}`
      : "See what is using it and free space in the admin Disk tab.",
  ];
  return {
    subject: `Disk ${percent}% full on ${instance}`,
    text: lines.join("\n"),
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
  };
}

async function notifyAdmins(deps: DiskAlertDeps, fs: DiskFilesystem, level: number, episode: number): Promise<boolean> {
  const message = diskAlertMessage(fs, deps);
  const key = fs.holds.map((h) => h.role).join("+");
  const admins = new Map<string, string>();
  for (const id of await deps.admins()) {
    const person = personKey(id);
    if (person && !admins.has(person)) admins.set(person, personIds(id)[0] ?? id);
  }
  let told = false;
  for (const [person, id] of admins) {
    const queued = await deps.deliveries
      .enqueue({
        destination: principalDestination(id, id),
        text: message.text,
        idempotencyKey: `disk-alert:${key}:${level}:${episode}:${person}`,
      })
      .then(() => true, swallowAs(`disk alert: message ${id}`, false));
    const email = personIds(id).find((x) => x.includes("@"));
    if (!deps.mailer || !email) {
      told ||= queued;
      continue;
    }
    const sent = await deps.mailer
      .send({ to: email, subject: message.subject, text: message.text, html: message.html })
      .then(() => true, swallowAs(`disk alert: email ${email}`, false));
    told ||= sent;
  }
  return told;
}

export async function checkDiskAlerts(deps: DiskAlertDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  for (const fs of await deps.filesystems()) {
    const roles = fs.holds.map((h) => h.role);
    const records = await Promise.all(roles.map((role) => deps.store.get(role)));
    if (fs.usedPercent < REARM_BELOW_PERCENT) {
      await Promise.all(roles.filter((_, i) => records[i]).map((role) => deps.store.delete(role)));
      continue;
    }
    const started = Math.min(...records.map((r) => r?.since ?? Infinity));
    const episode = Number.isFinite(started) ? started : now();
    const alerted = Math.max(...records.map((r) => r?.level ?? 0));
    const level = DISK_ALERT_LEVELS.findLast((l) => fs.usedPercent >= l) ?? 0;
    const reached = level > alerted && (await notifyAdmins(deps, fs, level, episode));
    if (!reached && records.every(Boolean)) continue;
    await Promise.all(roles.map((role) => deps.store.put(role, { level: reached ? level : alerted, since: episode })));
  }
}
