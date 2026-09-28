export interface MountRow {
  id: string;
  name: string;
  externalId?: string;
  displayPath?: string;
  mode: "ro" | "rw";
  enabled?: boolean;
  listedAt?: number;
  itemCount?: number;
  inaccessible?: boolean;
  webViewLink?: string;
  createdBy?: string;
}

export interface ConnectorState {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
}

export type BandState = "not-configured" | "not-connected" | "needs-reconnect" | "empty" | "populated";

export function bandState(connector: ConnectorState, mounts: readonly MountRow[]): BandState {
  if (!connector.configured) return "not-configured";
  if (!connector.connected) return "not-connected";
  if (connector.needsReconnect) return "needs-reconnect";
  return mounts.length ? "populated" : "empty";
}

export function canAttach(state: BandState): boolean {
  return state === "empty" || state === "populated";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function listedAgo(listedAt: number | undefined, nowMs: number): string {
  if (listedAt === undefined) return "not listed yet";
  const delta = Math.max(0, nowMs - listedAt);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

export const accessLabel = (mode: "ro" | "rw"): string => (mode === "rw" ? "Read & write" : "Read only");

export const driveFolderUrl = (externalId: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(externalId)}`;

export function requestAccessUrl(row: Pick<MountRow, "webViewLink" | "externalId">): string | null {
  if (row.webViewLink) return row.webViewLink;
  return row.externalId ? driveFolderUrl(row.externalId) : null;
}

export function rowStatus(row: MountRow, state: BandState): string | null {
  if (state === "not-connected") return "Not connected";
  if (state === "needs-reconnect") return "Paused";
  if (row.enabled === false) return "Off";
  if (row.inaccessible) return "No access";
  if (row.listedAt === undefined) return "Opens when the agent needs it";
  return null;
}

export function rowTitle(row: MountRow, nowMs: number): string {
  const parts: string[] = [row.displayPath ?? "Google Drive"];
  if (row.listedAt !== undefined) parts.push(`listed ${listedAgo(row.listedAt, nowMs)}`);
  if (row.createdBy) parts.push(`attached by ${row.createdBy}`);
  return parts.join(" · ");
}

export function rowIsInert(row: MountRow, state: BandState): boolean {
  return state !== "populated" || Boolean(row.inaccessible);
}

export interface RowActionSpec {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  reason?: string;
}

export function folderActions(row: MountRow, state: BandState): RowActionSpec[] {
  const off = row.enabled === false;
  const actions: RowActionSpec[] = [{ id: "open", label: "Open in Drive" }];

  const listable = state === "populated" && !off && !row.inaccessible;
  actions.push({
    id: "refresh",
    label: "Refresh listing",
    disabled: !listable,
    ...(listable
      ? {}
      : { reason: off ? "This folder is off" : "This folder cannot be listed with your account right now" }),
  });

  actions.push({ id: "move", label: "Change context…" });
  actions.push({ id: off ? "enable" : "disable", label: off ? "Turn on" : "Turn off" });

  actions.push({ id: "remove", label: "Remove…", danger: true });
  return actions;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function mountNameError(name: string): string | null {
  return NAME_RE.test(name)
    ? null
    : "use lowercase letters, numbers and hyphens, starting with a letter or number (max 32)";
}

export function slugFromFolderName(folderName: string): string {
  return folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

export function parseDriveFolderId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) return null;

  const fromPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  if (fromPath) return fromPath;

  const fromQuery = url.searchParams.get("id");
  if (fromQuery && /^[A-Za-z0-9_-]{10,}$/.test(fromQuery)) return fromQuery;

  return null;
}
