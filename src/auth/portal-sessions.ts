import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import { createPgPool } from "../persistence/pg-pool.ts";

interface PortalSessionGrant {
  principal: string;
  refreshToken: string;
  expiresAtMs: number;
}

type PortalSessionClaim =
  | { state: "missing" }
  | { state: "current" | "busy"; principal: string; expiresAtMs: number }
  | { state: "claimed"; principal: string; expiresAtMs: number; lease: string; refreshToken: string };

type PortalSessionOutcome =
  { kind: "rotated"; refreshToken: string; expiresAtMs: number } | { kind: "revoked" } | { kind: "unavailable" };

export interface PortalSessionStore {
  readonly durable: boolean;
  start(sessionId: string, grant: PortalSessionGrant): Promise<void>;
  claim(sessionId: string, staleAfterMs: number, leaseMs: number): Promise<PortalSessionClaim>;
  settle(sessionId: string, lease: string, outcome: PortalSessionOutcome): Promise<boolean>;
  active(sessionId: string): Promise<boolean>;
  end(sessionId: string): Promise<string | null>;
}

const keyOf = (sessionId: string): string => createHash("sha256").update(sessionId).digest("hex");
const newLease = (): string => randomBytes(18).toString("base64url");

interface MemoryRecord {
  principal: string;
  refreshToken: string;
  expiresAtMs: number;
  checkedAtMs: number;
  lease?: string;
  leaseUntilMs?: number;
}

export function createMemoryPortalSessions(now: () => number = Date.now): PortalSessionStore {
  const records = new Map<string, MemoryRecord>();
  const live = (sessionId: string): MemoryRecord | undefined => {
    const key = keyOf(sessionId);
    const record = records.get(key);
    if (record && record.expiresAtMs <= now()) records.delete(key);
    return records.get(key);
  };
  return {
    durable: false,
    async start(sessionId, grant) {
      const t = now();
      for (const [key, record] of records) if (record.expiresAtMs <= t) records.delete(key);
      records.set(keyOf(sessionId), { ...grant, checkedAtMs: t });
    },
    async claim(sessionId, staleAfterMs, leaseMs) {
      const record = live(sessionId);
      if (!record) return { state: "missing" };
      const t = now();
      const view = { principal: record.principal, expiresAtMs: record.expiresAtMs };
      if (record.checkedAtMs > t - staleAfterMs) return { state: "current", ...view };
      if (record.leaseUntilMs !== undefined && record.leaseUntilMs > t) return { state: "busy", ...view };
      record.lease = newLease();
      record.leaseUntilMs = t + leaseMs;
      return { state: "claimed", ...view, lease: record.lease, refreshToken: record.refreshToken };
    },
    async settle(sessionId, lease, outcome) {
      const record = live(sessionId);
      if (!record || record.lease !== lease) return false;
      if (outcome.kind === "revoked") return records.delete(keyOf(sessionId));
      delete record.lease;
      delete record.leaseUntilMs;
      if (outcome.kind === "rotated") {
        record.refreshToken = outcome.refreshToken;
        record.expiresAtMs = outcome.expiresAtMs;
        record.checkedAtMs = now();
      }
      return true;
    },
    async active(sessionId) {
      return live(sessionId) !== undefined;
    },
    async end(sessionId) {
      const record = live(sessionId);
      records.delete(keyOf(sessionId));
      return record?.refreshToken ?? null;
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS portal_sessions (
    session_hash TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_id TEXT,
    lease_until TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS portal_sessions_expiry ON portal_sessions (expires_at)`,
];

export function createPostgresPortalSessions(connectionString: string, key: SecretKey): PortalSessionStore {
  const pg = createPgPool(connectionString, "auth/portal-sessions/0001", SCHEMA);
  const view = (row: Record<string, unknown>) => ({
    principal: String(row.principal),
    expiresAtMs: new Date(String(row.expires_at)).getTime(),
  });
  return {
    durable: true,
    async start(sessionId, grant) {
      await pg.query("DELETE FROM portal_sessions WHERE expires_at <= now()");
      await pg.query(
        `INSERT INTO portal_sessions (session_hash, principal, refresh_token_enc, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
         ON CONFLICT (session_hash) DO UPDATE SET principal = EXCLUDED.principal,
           refresh_token_enc = EXCLUDED.refresh_token_enc, expires_at = EXCLUDED.expires_at,
           checked_at = now(), lease_id = NULL, lease_until = NULL`,
        [keyOf(sessionId), grant.principal, encryptSecret(grant.refreshToken, key), grant.expiresAtMs],
      );
    },
    async claim(sessionId, staleAfterMs, leaseMs) {
      const lease = newLease();
      const claimed = await pg.query(
        `UPDATE portal_sessions SET lease_id = $2, lease_until = now() + $3 * interval '1 millisecond'
         WHERE session_hash = $1 AND expires_at > now()
           AND checked_at <= now() - $4 * interval '1 millisecond'
           AND (lease_until IS NULL OR lease_until <= now())
         RETURNING principal, expires_at, refresh_token_enc`,
        [keyOf(sessionId), lease, leaseMs, staleAfterMs],
      );
      const row = claimed.rows[0];
      if (row) {
        return {
          state: "claimed",
          ...view(row),
          lease,
          refreshToken: decryptSecret(String(row.refresh_token_enc), key),
        };
      }
      const current = await pg.query(
        `SELECT principal, expires_at,
           checked_at > now() - $2 * interval '1 millisecond' AS fresh
         FROM portal_sessions WHERE session_hash = $1 AND expires_at > now()`,
        [keyOf(sessionId), staleAfterMs],
      );
      const found = current.rows[0];
      if (!found) return { state: "missing" };
      return { state: found.fresh === true ? "current" : "busy", ...view(found) };
    },
    async settle(sessionId, lease, outcome) {
      const params = [keyOf(sessionId), lease];
      if (outcome.kind === "revoked") {
        const deleted = await pg.query("DELETE FROM portal_sessions WHERE session_hash = $1 AND lease_id = $2", params);
        return deleted.rowCount === 1;
      }
      if (outcome.kind === "unavailable") {
        const released = await pg.query(
          "UPDATE portal_sessions SET lease_id = NULL, lease_until = NULL WHERE session_hash = $1 AND lease_id = $2",
          params,
        );
        return released.rowCount === 1;
      }
      const rotated = await pg.query(
        `UPDATE portal_sessions SET refresh_token_enc = $3, expires_at = to_timestamp($4 / 1000.0),
           checked_at = now(), lease_id = NULL, lease_until = NULL
         WHERE session_hash = $1 AND lease_id = $2`,
        [...params, encryptSecret(outcome.refreshToken, key), outcome.expiresAtMs],
      );
      return rotated.rowCount === 1;
    },
    async active(sessionId) {
      const result = await pg.query("SELECT 1 FROM portal_sessions WHERE session_hash = $1 AND expires_at > now()", [
        keyOf(sessionId),
      ]);
      return result.rows.length === 1;
    },
    async end(sessionId) {
      const result = await pg.query(
        "DELETE FROM portal_sessions WHERE session_hash = $1 RETURNING refresh_token_enc, expires_at > now() AS live",
        [keyOf(sessionId)],
      );
      const row = result.rows[0];
      return row && row.live === true ? decryptSecret(String(row.refresh_token_enc), key) : null;
    },
  };
}
