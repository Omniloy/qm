import type { Listing } from "./drive-listing.ts";

/**
 * Cached folder listings, keyed on (principal, mount).
 *
 * The principal is part of the key and not an optimisation detail: a listing
 * is made with one person's Google token and shows only what that person can
 * open. Sharing an entry between viewers would hand someone the names of files
 * they have no access to.
 */

interface CachedListing {
  listing: Listing;
  /** When the listing was made, in ms. Rendered into the prompt block verbatim. */
  listedAt: number;
}

export interface ListingCache {
  get(principalId: string, mountId: string, nowMs: number): CachedListing | null;
  set(principalId: string, mountId: string, listing: Listing, nowMs: number): CachedListing;
  /** Drop one person's view of one mount — what the Refresh button does. */
  invalidate(principalId: string, mountId: string): void;
  /** Drop every viewer's copy of a mount — for detach, or a mode change. */
  invalidateMount(mountId: string): void;
  size(): number;
}

export interface ListingCacheOptions {
  ttlMs?: number;
  /**
   * Cap on retained entries. A busy org has (people × mounts) possible keys,
   * and an unbounded map here would hold every listing any member ever made.
   */
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

// A NUL separator cannot occur in a principal id or a mount id, so no two
// different pairs can concatenate into the same key — and invalidateMount can
// match on the separator rather than on a bare id suffix.
const keyOf = (principalId: string, mountId: string): string => `${principalId}\u0000${mountId}`;

export function createListingCache(opts: ListingCacheOptions = {}): ListingCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

  // Insertion-ordered, and re-inserted on read, so the oldest key is the
  // least recently used one.
  const entries = new Map<string, CachedListing>();

  const evictIfNeeded = (): void => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  };

  return {
    get(principalId, mountId, nowMs) {
      const key = keyOf(principalId, mountId);
      const hit = entries.get(key);
      if (!hit) return null;
      if (nowMs - hit.listedAt >= ttlMs) {
        entries.delete(key);
        return null;
      }
      // Refresh recency so an actively used listing is not evicted first.
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },

    set(principalId, mountId, listing, nowMs) {
      const key = keyOf(principalId, mountId);
      const value: CachedListing = { listing, listedAt: nowMs };
      entries.delete(key);
      entries.set(key, value);
      evictIfNeeded();
      return value;
    },

    invalidate(principalId, mountId) {
      entries.delete(keyOf(principalId, mountId));
    },

    invalidateMount(mountId) {
      const suffix = `\u0000${mountId}`;
      for (const key of entries.keys()) {
        if (key.endsWith(suffix)) entries.delete(key);
      }
    },

    size() {
      return entries.size;
    },
  };
}
