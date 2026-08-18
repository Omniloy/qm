import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";

/**
 * A public read link over one conversation.
 *
 * Stored rather than stateless on purpose. A signed token that carried its own
 * authority could not be revoked, and its payload is readable by anyone holding
 * the URL — which would publish the sharer's principal id and personal scope to
 * every stranger who opened it. A row can be killed, and it can be counted.
 */
export interface SessionShareRecord {
  sessionId: string;
  scopeId: ScopeId;
  sharerId: string;
  orgId?: string;
  createdAt: number;
  /** Soft tombstone: a revoked share and a share that never existed must look identical. */
  revokedAt?: number;
  revokedBy?: string;
  viewCount: number;
  lastViewedAt?: number;
}

export type ShareLookup = { ok: true; shareId: string; rec: SessionShareRecord } | { ok: false; reason: "not_found" };

export interface SessionShareStore {
  mint(rec: Omit<SessionShareRecord, "createdAt" | "viewCount">, now?: number): Promise<{ shareId: string }>;
  get(shareId: string, now?: number): Promise<ShareLookup>;
  /** Idempotent. Revoking twice, or revoking nothing, is not an error. */
  revoke(shareId: string, by: string, now?: number): Promise<boolean>;
  forSession(sessionId: string): Promise<Array<{ shareId: string; rec: SessionShareRecord }>>;
  noteView(shareId: string, now?: number): Promise<void>;
  /** Drop tombstones past the grace period so the table does not grow forever. */
  sweep(graceMs: number, now?: number): Promise<number>;
}

export const SHARE_TOMBSTONE_GRACE_MS = 30 * 24 * 60 * 60_000;

export function createSessionShareStore(
  backing: DurableMap<SessionShareRecord>,
  opts: { now?: () => number } = {},
): SessionShareStore {
  const clock = opts.now ?? (() => Date.now());
  return {
    async mint(rec, now) {
      // Same generator as secret-drop: two UUIDs of entropy, so the id is the
      // secret and enumeration is hopeless.
      const shareId = `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
      await backing.put(shareId, { ...rec, createdAt: now ?? clock(), viewCount: 0 });
      return { shareId };
    },

    async get(shareId) {
      const rec = await backing.get(shareId);
      // A tombstone and a miss collapse to one answer, so a revoked link cannot
      // be distinguished from one that never existed.
      if (!rec || rec.revokedAt !== undefined) return { ok: false, reason: "not_found" };
      return { ok: true, shareId, rec };
    },

    async revoke(shareId, by, now) {
      const rec = await backing.get(shareId);
      if (!rec || rec.revokedAt !== undefined) return false;
      await backing.put(shareId, { ...rec, revokedAt: now ?? clock(), revokedBy: by });
      return true;
    },

    async forSession(sessionId) {
      const all = await backing.entries();
      return all
        .filter(([, rec]) => rec.sessionId === sessionId && rec.revokedAt === undefined)
        .map(([shareId, rec]) => ({ shareId, rec }))
        .sort((a, b) => b.rec.createdAt - a.rec.createdAt);
    },

    async noteView(shareId, now) {
      const rec = await backing.get(shareId);
      if (!rec || rec.revokedAt !== undefined) return;
      await backing.put(shareId, { ...rec, viewCount: rec.viewCount + 1, lastViewedAt: now ?? clock() });
    },

    async sweep(graceMs, now) {
      const at = now ?? clock();
      const all = await backing.entries();
      let removed = 0;
      for (const [shareId, rec] of all) {
        if (rec.revokedAt !== undefined && at - rec.revokedAt > graceMs) {
          await backing.delete(shareId);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
