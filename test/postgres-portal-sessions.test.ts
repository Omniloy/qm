import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createPostgresPortalSessions } from "../src/auth/portal-sessions.ts";

const url = process.env.DATABASE_URL;
const key = deriveConnectorKey("portal-sessions-test-key", "portal-sessions");
const grant = (refreshToken: string) => ({
  principal: "ana@laberit.com",
  refreshToken,
  expiresAtMs: Date.now() + 86_400_000,
  refreshAfterMs: 60_000,
});

test(
  "postgres portal sessions encrypt the token, lease one refresh across instances, back off, and settle by lease",
  { skip: !url },
  async () => {
    const a = createPostgresPortalSessions(url!, key);
    const b = createPostgresPortalSessions(url!, key);
    const pool = new pg.Pool({ connectionString: url });
    const sid = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(sid).digest("hex");
    const age = (seconds: number) =>
      pool.query(
        "UPDATE portal_sessions SET checked_at = now() - $2 * interval '1 second', retry_at = NULL WHERE session_hash = $1",
        [hash, seconds],
      );
    try {
      await a.start(sid, grant("rt-secret-1"));
      const stored = await pool.query("SELECT refresh_token_enc FROM portal_sessions WHERE session_hash = $1", [hash]);
      assert.equal(stored.rows.length, 1);
      assert.ok(!String(stored.rows[0].refresh_token_enc).includes("rt-secret-1"));
      assert.equal((await b.claim(sid, 30_000)).state, "current");
      assert.equal(await a.active(sid), true);
      await age(61);
      const claims = await Promise.all([a.claim(sid, 30_000), b.claim(sid, 30_000), a.claim(sid, 30_000)]);
      const won = claims.filter((claim) => claim.state === "claimed");
      assert.equal(won.length, 1);
      assert.equal(claims.filter((claim) => claim.state === "busy").length, 2);
      const winner = won[0]!;
      assert.equal(winner.state === "claimed" && winner.refreshToken, "rt-secret-1");
      const lease = winner.state === "claimed" ? winner.lease : "";
      assert.equal(await b.settle(sid, "other-lease", { kind: "revoked" }), false);
      assert.equal(
        await b.settle(sid, lease, {
          kind: "rotated",
          refreshToken: "rt-secret-2",
          expiresAtMs: Date.now() + 86_400_000,
        }),
        true,
      );
      assert.equal((await a.claim(sid, 30_000)).state, "current");
      await age(61);
      const next = await a.claim(sid, 30_000);
      assert.equal(next.state === "claimed" && next.refreshToken, "rt-secret-2");
      assert.equal(
        await a.settle(sid, next.state === "claimed" ? next.lease : "", { kind: "unavailable", retryAfterMs: 60_000 }),
        true,
      );
      assert.equal((await b.claim(sid, 30_000)).state, "current");
      await pool.query(
        "UPDATE portal_sessions SET checked_at = now() - interval '200 seconds' WHERE session_hash = $1",
        [hash],
      );
      assert.equal(await a.active(sid), true);
      await age(121);
      assert.equal(await a.active(sid), false);
      await pool.query(
        "UPDATE portal_sessions SET lease_id = 'stale', lease_until = now() - interval '1 second' WHERE session_hash = $1",
        [hash],
      );
      const recovered = await b.claim(sid, 30_000);
      assert.equal(recovered.state, "claimed");
      assert.equal(
        await b.settle(sid, recovered.state === "claimed" ? recovered.lease : "", { kind: "revoked" }),
        true,
      );
      assert.equal((await a.claim(sid, 30_000)).state, "missing");
      await a.start(sid, grant("rt-secret-3"));
      assert.equal(await b.end(sid), "rt-secret-3");
      assert.equal(await a.end(sid), null);
      await a.start(sid, grant("rt-secret-4"));
      await pool.query("UPDATE portal_sessions SET expires_at = now() - interval '1 second' WHERE session_hash = $1", [
        hash,
      ]);
      assert.equal(await a.active(sid), false);
      assert.equal((await a.claim(sid, 30_000)).state, "missing");
      assert.equal(await a.end(sid), null);
    } finally {
      await pool.query("DELETE FROM portal_sessions WHERE session_hash = $1", [hash]);
      await pool.end();
    }
  },
);
