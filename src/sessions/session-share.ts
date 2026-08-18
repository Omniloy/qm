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

type ShareLookup = { ok: true; shareId: string; rec: SessionShareRecord } | { ok: false; reason: "not_found" };

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

  /**
   * Change one row without ever writing back a record read earlier.
   *
   * Revocation is the entire containment story for this feature — there is no
   * expiry — so the one outcome that must be impossible is a concurrent write
   * putting a tombstoned record back. A read-modify-write does exactly that: a
   * view that read the row before a revoke and wrote after it would carry the
   * pre-revoke record, `revokedAt` and all, back over the tombstone, and the
   * link would be live again for good. Against Postgres the gap between the read
   * and the write is a network round trip, and every reader's poll takes it.
   *
   * So: `update` when the backing has it — that is `SELECT ... FOR UPDATE` in the
   * same transaction as the write (persistence/durable-map.ts), so `step` sees
   * the row as it is at write time and a revoke that landed first is visible.
   * `update` is optional in `DurableMap`, and the fallback is deliberately not a
   * `put`: `merge` patches only the named fields and leaves every other one as
   * the row has it, so the worst a lost race can cost there is an uncounted
   * view, never a resurrected link.
   *
   * `step` returns the fields to change, or null to leave the row alone — which
   * is also how both callers express "already revoked".
   */
  async function mutate(
    shareId: string,
    step: (rec: SessionShareRecord) => Partial<SessionShareRecord> | null,
  ): Promise<boolean> {
    if (backing.update) {
      let changed = false;
      const applied = await backing.update(shareId, (rec) => {
        const patch = step(rec);
        if (!patch) return rec;
        changed = true;
        return { ...rec, ...patch };
      });
      return applied !== null && changed;
    }
    const rec = await backing.get(shareId);
    if (!rec) return false;
    const patch = step(rec);
    if (!patch) return false;
    return (await backing.merge(shareId, patch)) !== null;
  }

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
      return mutate(shareId, (rec) =>
        rec.revokedAt === undefined ? { revokedAt: now ?? clock(), revokedBy: by } : null,
      );
    },

    async forSession(sessionId) {
      const all = await backing.entries();
      return all
        .filter(([, rec]) => rec.sessionId === sessionId && rec.revokedAt === undefined)
        .map(([shareId, rec]) => ({ shareId, rec }))
        .sort((a, b) => b.rec.createdAt - a.rec.createdAt);
    },

    async noteView(shareId, now) {
      await mutate(shareId, (rec) =>
        rec.revokedAt === undefined ? { viewCount: rec.viewCount + 1, lastViewedAt: now ?? clock() } : null,
      );
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
