/**
 * Listing a Drive folder, and shaping the result into the bounded tree that
 * goes into the system prompt.
 *
 * Every call here runs as one person. A listing is never shared between
 * viewers: two members of a scope see the files their own Google account can
 * open, and nothing else. Sharing one listing would leak file *names* to
 * people who cannot open them, and names carry information.
 */

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";

const LIST_FIELDS = "nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,webViewLink)";

/** Drive returns 100 by default and allows 1000; larger pages mean fewer round trips. */
const PAGE_SIZE = 1000;

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/** Google's own editor types. Readable, but only editable through their structured APIs. */
export const isNativeGoogleType = (mimeType: string): boolean => mimeType.startsWith("application/vnd.google-apps.");

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  /** Relative to the mount root, POSIX-style. "" for entries directly in the root. */
  dir: string;
  sizeBytes?: number;
  modifiedTime?: string;
  webViewLink?: string;
}

interface ListingLimits {
  /** Stop descending past this many levels below the mount root. */
  maxDepth: number;
  /** Stop after this many files, whether or not the tree is exhausted. */
  maxEntries: number;
  /** Hard ceiling on Drive round trips, so one listing cannot consume a turn's budget. */
  maxCalls: number;
}

const DEFAULT_LIMITS: ListingLimits = { maxDepth: 4, maxEntries: 500, maxCalls: 25 };

export interface Listing {
  entries: DriveEntry[];
  /**
   * True when the tree was cut short — by depth, entry count, call budget, or
   * Drive's own `incompleteSearch`. The prompt block must say so, or the agent
   * will read a partial tree as a complete one and conclude a file is absent.
   */
  truncated: boolean;
  /** Why it was cut short, for the UI and the prompt block. */
  truncatedReason?: "depth" | "entries" | "calls" | "incomplete-search";
  calls: number;
}

export interface ListFolderOptions {
  fetchImpl?: typeof fetch;
  limits?: Partial<ListingLimits>;
  signal?: AbortSignal;
}

interface DriveListResponse {
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
    modifiedTime?: string;
    webViewLink?: string;
  }>;
  nextPageToken?: string;
  incompleteSearch?: boolean;
}

export class DriveListError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const joinDir = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * Breadth-first walk of a folder, as the given person.
 *
 * Breadth-first rather than depth-first on purpose: when the budget runs out,
 * what survives is the top of the tree, which is the part a person is most
 * likely to name. A depth-first cut leaves one deep branch and nothing else.
 */
export async function listFolder(
  accessToken: string,
  rootFolderId: string,
  opts: ListFolderOptions = {},
): Promise<Listing> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };

  const entries: DriveEntry[] = [];
  let calls = 0;
  let truncated = false;
  let truncatedReason: Listing["truncatedReason"];

  const cut = (reason: NonNullable<Listing["truncatedReason"]>): void => {
    truncated = true;
    truncatedReason ??= reason;
  };

  let frontier: Array<{ id: string; dir: string; depth: number }> = [{ id: rootFolderId, dir: "", depth: 0 }];

  while (frontier.length) {
    const next: typeof frontier = [];

    for (const folder of frontier) {
      let pageToken: string | undefined;

      do {
        if (calls >= limits.maxCalls) {
          cut("calls");
          return { entries, truncated, ...(truncatedReason ? { truncatedReason } : {}), calls };
        }

        const params = new URLSearchParams({
          q: `'${folder.id}' in parents and trashed = false`,
          fields: LIST_FIELDS,
          pageSize: String(PAGE_SIZE),
          corpora: "allDrives",
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
        });
        if (pageToken) params.set("pageToken", pageToken);

        calls++;
        const res = await fetchImpl(`${DRIVE_FILES}?${params}`, {
          headers: { authorization: `Bearer ${accessToken}` },
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!res.ok) {
          throw new DriveListError(res.status, `drive files.list failed (${res.status})`);
        }
        const body = (await res.json()) as DriveListResponse;

        // Drive warns that a wide corpora search may return partial results.
        // Without this the agent cannot tell a truncated folder from an empty one.
        if (body.incompleteSearch) cut("incomplete-search");

        for (const f of body.files ?? []) {
          if (!f.id || !f.name || !f.mimeType) continue;

          if (f.mimeType === FOLDER_MIME) {
            if (folder.depth + 1 > limits.maxDepth) {
              cut("depth");
              continue;
            }
            next.push({ id: f.id, dir: joinDir(folder.dir, f.name), depth: folder.depth + 1 });
            continue;
          }

          // A shortcut's target lives wherever its owner put it, which may be
          // outside the mount entirely. Never present one as folder content.
          if (f.mimeType === SHORTCUT_MIME) continue;

          if (entries.length >= limits.maxEntries) {
            cut("entries");
            return { entries, truncated, ...(truncatedReason ? { truncatedReason } : {}), calls };
          }

          const size = f.size ? Number(f.size) : undefined;
          entries.push({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            dir: folder.dir,
            ...(size !== undefined && Number.isFinite(size) ? { sizeBytes: size } : {}),
            ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}),
            ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
          });
        }

        pageToken = body.nextPageToken;
      } while (pageToken);
    }

    frontier = next;
  }

  return { entries, truncated, ...(truncatedReason ? { truncatedReason } : {}), calls };
}
