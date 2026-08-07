import type { ScopeId } from "../types.ts";
import type { MountStore } from "./mount-store.ts";
import type { ListingCache } from "./listing-cache.ts";
import { DriveListError, type ListFolderOptions, type Listing } from "./drive-listing.ts";
import { attachedFoldersSection, attachedFoldersUnavailableNote, type MountListing } from "./prompt-block.ts";

/**
 * Assemble the attached-folder view for one turn, for one person.
 *
 * Everything here runs as the turn's actor. A triggered run is no different:
 * it carries a real actor whose membership was already re-checked, so a cron
 * reaches exactly the folders its owner can reach.
 */

export type ListFolderFn = (accessToken: string, folderId: string, opts?: ListFolderOptions) => Promise<Listing>;

export interface ResolveDeps {
  mounts: MountStore;
  cache: ListingCache;
  listFolder: ListFolderFn;
  /** Resolves the actor's own Drive token, or null when Google is not connected. */
  tokenFor: (principalId: string) => Promise<string | null>;
  onError?: (e: { code: string; message: string; scopeLabel?: string }) => void;
}

export interface ResolveInput {
  scopeIds: readonly ScopeId[];
  principalId: string;
  nowMs: number;
  /** Ceiling on Drive round trips across every mount in this turn. */
  callBudget?: number;
}

export interface ResolvedFolders {
  /** The system-prompt section, or "" when there is nothing to say. */
  block: string;
  listings: MountListing[];
  /** Mount ids the actor could not open, for the UI's per-person no-access state. */
  inaccessibleMountIds: string[];
  callsUsed: number;
}

const DEFAULT_CALL_BUDGET = 40;

const EMPTY: ResolvedFolders = { block: "", listings: [], inaccessibleMountIds: [], callsUsed: 0 };

/** Drive says 403 for "you cannot see this" and 404 for "gone, or never visible to you". */
const isAccessError = (e: unknown): boolean => e instanceof DriveListError && (e.status === 403 || e.status === 404);

export async function resolveAttachedFolders(deps: ResolveDeps, input: ResolveInput): Promise<ResolvedFolders> {
  const mounts = await deps.mounts.forScopes(input.scopeIds);
  if (!mounts.length) return EMPTY;

  // No connected account is not an error — it is a state the agent should be
  // told about, so it can say why rather than behaving as if no folders exist.
  const token = await deps.tokenFor(input.principalId);
  if (!token) {
    return { ...EMPTY, block: attachedFoldersUnavailableNote("not-connected") };
  }

  let remaining = input.callBudget ?? DEFAULT_CALL_BUDGET;
  const listings: MountListing[] = [];
  const inaccessibleMountIds: string[] = [];
  let callsUsed = 0;

  for (const mount of mounts) {
    const cached = deps.cache.get(input.principalId, mount.id, input.nowMs);
    if (cached) {
      listings.push({ mount, listing: cached.listing, listedAt: cached.listedAt });
      continue;
    }

    if (remaining <= 0) {
      // Out of budget rather than out of access: skip silently rather than
      // claiming the folder is inaccessible, which would be a lie the UI
      // would then show as a permissions problem.
      continue;
    }

    try {
      const listing = await deps.listFolder(token, mount.externalId, { limits: { maxCalls: remaining } });
      remaining -= listing.calls;
      callsUsed += listing.calls;
      const stored = deps.cache.set(input.principalId, mount.id, listing, input.nowMs);
      listings.push({ mount, listing, listedAt: stored.listedAt });
    } catch (e) {
      if (isAccessError(e)) {
        inaccessibleMountIds.push(mount.id);
        continue;
      }
      // A transient failure must not be reported as "you lack access" — that
      // sends the person to Drive to fix a permission that is already correct.
      deps.onError?.({
        code: "drive_list_failed",
        message: e instanceof Error ? e.message : String(e),
        scopeLabel: mount.scopeId,
      });
    }
  }

  if (!listings.length) {
    return {
      block: inaccessibleMountIds.length ? attachedFoldersUnavailableNote("no-access") : "",
      listings: [],
      inaccessibleMountIds,
      callsUsed,
    };
  }

  return {
    block: attachedFoldersSection(listings, input.nowMs),
    listings,
    inaccessibleMountIds,
    callsUsed,
  };
}
