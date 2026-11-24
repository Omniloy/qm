import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createPostgresPortalSessions } from "../src/auth/portal-sessions.ts";

const url = process.env.DATABASE_URL;
const key = deriveConnectorKey("portal-sessions-test-key", "portal-sessions");
const day = (): number => Date.now() + 86_400_000;

test(
  "postgres portal sessions encrypt the token, lease one refresh across instances, and settle by lease",
  { skip: !url },
  async () => {
    const a = createPostgresPortalSessions(url!, key);
    const b = createPostgresPortalSessions(url!, key);
    const pool = new pg.Pool({ connectionString: url });
    const sid = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(sid).digest("hex");
    try {
      await a.start(sid, { principal: "ana@laberit.com", refreshToken: "rt-secret-1", expiresAtMs: day() });
      const stored = await pool.query("SELECT refresh_token_enc FROM portal_sessions WHERE session_hash = $1", [hash]);
      assert.equal(stored.rows.length, 1);
      assert.ok(!String(stored.rows[0].refresh_token_enc).includes("rt-secret-1"));
      assert.equal((await b.claim(sid, 60_000, 30_000)).state, "current");
      const claims = await Promise.all([a.claim(sid, 0, 30_000), b.claim(sid, 0, 30_000), a.claim(sid, 0, 30_000)]);
      const won = claims.filter((claim) => claim.state === "claimed");
      assert.equal(won.length, 1);
      assert.equal(claims.filter((claim) => claim.state === "busy").length, 2);
      const winner = won[0]!;
      assert.equal(winner.state === "claimed" && winner.refreshToken, "rt-secret-1");
      const lease = winner.state === "claimed" ? winner.lease : "";
      assert.equal(await b.settle(sid, "other-lease", { kind: "revoked" }), false);
      assert.equal(await b.settle(sid, lease, { kind: "rotated", refreshToken: "rt-secret-2", expiresAtMs: day() }), true);
      assert.equal((await a.claim(sid, 60_000, 30_000)).state, "current");
      const next = await a.claim(sid, 0, 30_000);
      assert.equal(next.state === "claimed" && next.refreshToken, "rt-secret-2");
      assert.equal(await a.settle(sid, next.state === "claimed" ? next.lease : "", { kind: "unavailable" }), true);
      await pool.query(
        "UPDATE portal_sessions SET lease_id = 'stale', lease_until = now() - interval '1 second' WHERE session_hash = $1",
        [hash],
      );
      const recovered = await b.claim(sid, 0, 30_000);
      assert.equal(recovered.state, "claimed");
      assert.equal(await b.settle(sid, recovered.state === "claimed" ? recovered.lease : "", { kind: "revoked" }), true);
      assert.equal(await a.active(sid), false);
      assert.equal((await a.claim(sid, 0, 30_000)).state, "missing");
      await a.start(sid, { principal: "ana@laberit.com", refreshToken: "rt-secret-3", expiresAtMs: day() });
      assert.equal(await b.active(sid), true);
      assert.equal(await b.end(sid), "rt-secret-3");
      assert.equal(await a.end(sid), null);
      await a.start(sid, { principal: "ana@laberit.com", refreshToken: "rt-secret-4", expiresAtMs: day() });
      await pool.query("UPDATE portal_sessions SET expires_at = now() - interval '1 second' WHERE session_hash = $1", [
        hash,
      ]);
      assert.equal(await a.active(sid), false);
      assert.equal((await a.claim(sid, 0, 30_000)).state, "missing");
      assert.equal(await a.end(sid), null);
    } finally {
      await pool.query("DELETE FROM portal_sessions WHERE session_hash = $1", [hash]);
      await pool.end();
    }
  },
);
