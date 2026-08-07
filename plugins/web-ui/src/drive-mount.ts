/**
 * DOM-free helpers for the Drive folders band.
 *
 * The band has four genuinely different things to say, and they are easy to
 * conflate: the org has not configured Google at all, this person has not
 * connected it, their token has expired, or they simply have no folders yet.
 * Choosing between them is logic, so it lives here with tests rather than
 * inside a template.
 */

export interface MountRow {
  id: string;
  name: string;
  /** Drive folder id. Every folder URL is derived from this. */
  externalId?: string;
  displayPath?: string;
  mode: "ro" | "rw";
  /** False once someone turns the folder off. Absent on older rows, which are on. */
  enabled?: boolean;
  /** When this person last listed the folder. Absent until they have. */
  listedAt?: number;
  /** How many files that listing found, when there is one. */
  itemCount?: number;
  /** Set when this person's own Google account cannot open the folder. */
  inaccessible?: boolean;
  webViewLink?: string;
  createdBy?: string;
}

export interface ConnectorState {
  /** The provider exists in /api/connectors — i.e. an admin configured it. */
  configured: boolean;
  /** This person has completed OAuth. */
  connected: boolean;
  /** Their token failed to refresh. */
  needsReconnect: boolean;
}

export type BandState = "not-configured" | "not-connected" | "needs-reconnect" | "empty" | "populated";

/**
 * Order matters. "Not configured" outranks everything because nothing the
 * person does can fix it, so offering them a Connect button would be a dead
 * end. "Needs reconnect" outranks "populated" because the rows are inert
 * until the token works again, and showing them as normal would imply the
 * agent can use them.
 */
export function bandState(connector: ConnectorState, mounts: readonly MountRow[]): BandState {
  if (!connector.configured) return "not-configured";
  if (!connector.connected) return "not-connected";
  if (connector.needsReconnect) return "needs-reconnect";
  return mounts.length ? "populated" : "empty";
}

/** Whether the band should offer an Attach button in this state. */
export function canAttach(state: BandState): boolean {
  return state === "empty" || state === "populated";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How stale this person's listing is. Deliberately coarse — the exact second
 * is noise, and the number exists to answer "should I refresh?".
 */
export function listedAgo(listedAt: number | undefined, nowMs: number): string {
  if (listedAt === undefined) return "not listed yet";
  const delta = Math.max(0, nowMs - listedAt);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

export const accessLabel = (mode: "ro" | "rw"): string => (mode === "rw" ? "Read & write" : "Read only");

/**
 * The canonical Drive URL for a folder, derived from the id the row already
 * carries. No API call and nothing to keep in sync — Drive resolves the id.
 */
export const driveFolderUrl = (externalId: string): string =>
  `https://drive.google.com/drive/folders/${encodeURIComponent(externalId)}`;

/**
 * Where "Open" and "Request access" send someone. QM cannot grant Drive
 * access, so the only honest action for someone locked out is to open the
 * folder in Drive and let Google run its own request flow.
 *
 * Drive's own `webViewLink` is preferred when a listing supplied one, but it
 * usually has not, which is why the derived URL matters: without it the
 * no-access state offers a link that never renders.
 */
export function requestAccessUrl(row: Pick<MountRow, "webViewLink" | "externalId">): string | null {
  if (row.webViewLink) return row.webViewLink;
  return row.externalId ? driveFolderUrl(row.externalId) : null;
}

/**
 * Per-row status, or null when the row has nothing worth saying.
 *
 * A healthy folder used to report `Listed 4m ago` forever. Nobody acts on that
 * number, and it occupied a column that then squeezed the row's actions at
 * narrow widths. Silence is the correct output for the common case; the age
 * survives in the row's tooltip (see rowTitle).
 */
export function rowStatus(row: MountRow, state: BandState, nowMs: number): string | null {
  if (state === "not-connected") return "Not connected";
  if (state === "needs-reconnect") return "Paused";
  // Off outranks no-access: a folder that is off is never listed, so any
  // inaccessible flag on it is left over from before it was turned off.
  if (row.enabled === false) return "Off";
  if (row.inaccessible) return "No access";
  // Nothing lists a folder until a conversation needs it, so a freshly
  // attached folder has no timestamp. Say what will happen rather than
  // reporting an absence the person cannot act on.
  if (row.listedAt === undefined) return "Opens when the agent needs it";
  return null;
}

/**
 * The row's tooltip: everything true about the folder that the row itself no
 * longer has room to say. This is where the listing age went.
 */
export function rowTitle(row: MountRow, nowMs: number): string {
  const parts: string[] = [row.displayPath ?? "Google Drive"];
  if (row.listedAt !== undefined) parts.push(`listed ${listedAgo(row.listedAt, nowMs)}`);
  if (row.createdBy) parts.push(`attached by ${row.createdBy}`);
  return parts.join(" · ");
}

/** A row is interactive only when this person could actually open the folder. */
export function rowIsInert(row: MountRow, state: BandState): boolean {
  return state !== "populated" || Boolean(row.inaccessible);
}

/**
 * One entry in a row's overflow menu. Carries no handler: which actions a row
 * offers is a decision, and lives here where it can be tested; what they *do*
 * is wiring, and lives in the view.
 */
export interface RowActionSpec {
  id: string;
  label: string;
  /** Destructive — rendered apart from the rest and in the warning tone. */
  danger?: boolean;
  /** Shown, but refused, with the reason in the title. */
  disabled?: boolean;
  reason?: string;
}

/**
 * What a Drive folder row offers behind its overflow menu.
 *
 * Actions that cannot work are shown disabled rather than hidden: a menu whose
 * contents change between rows is harder to learn than one where an entry is
 * present and explains itself.
 */
export function folderActions(row: MountRow, state: BandState): RowActionSpec[] {
  const off = row.enabled === false;
  // Opening in Drive is the one action that always works — it is just a link,
  // and it is the whole point of the row for someone who lacks access.
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

  actions.push({ id: "remove", label: "Remove…", danger: true });
  return actions;
}

/**
 * Mount-name rule, mirroring the one core enforces at the store. Duplicated
 * deliberately: the browser must be able to reject a name before a round
 * trip, and core must never trust the browser to have done so.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function mountNameError(name: string): string | null {
  return NAME_RE.test(name)
    ? null
    : "use lowercase letters, numbers and hyphens, starting with a letter or number (max 32)";
}

/** Suggest a mount name from a Drive folder title. May be empty. */
export function slugFromFolderName(folderName: string): string {
  return folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/**
 * Pull a folder id out of whatever someone pastes.
 *
 * People copy the browser URL, the "Get link" share URL, or occasionally the
 * bare id. All three should work — asking someone to extract an id by hand is
 * the kind of small cruelty that makes a feature feel unfinished.
 */
export function parseDriveFolderId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // A bare id: Drive ids are opaque but always URL-safe and reasonably long.
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) return null;

  // https://drive.google.com/drive/folders/<id>  (optionally /u/0/ before it)
  const fromPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
  if (fromPath) return fromPath;

  // https://drive.google.com/open?id=<id>
  const fromQuery = url.searchParams.get("id");
  if (fromQuery && /^[A-Za-z0-9_-]{10,}$/.test(fromQuery)) return fromQuery;

  return null;
}
