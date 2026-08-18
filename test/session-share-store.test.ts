import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSessionShareStore, type SessionShareRecord } from "../src/sessions/session-share.ts";
import { scopeId } from "../src/types.ts";

const base = () => ({
  sessionId: "s1",
  scopeId: scopeId("group", "p1"),
  sharerId: "alice",
});

function store(now?: () => number) {
  return createSessionShareStore(createMemoryMap<SessionShareRecord>(), now ? { now } : {});
}

test("a share id is long, opaque and never repeats", async () => {
  const s = store();
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const { shareId } = await s.mint(base());
    assert.ok(shareId.length >= 60, "the id is the secret, so it carries real entropy");
    assert.ok(!seen.has(shareId));
    seen.add(shareId);
  }
});

test("a revoked share is indistinguishable from one that never existed", async () => {
  const s = store();
  const { shareId } = await s.mint(base());
  assert.equal((await s.get(shareId)).ok, true);
  assert.equal(await s.revoke(shareId, "alice"), true);
  assert.deepEqual(await s.get(shareId), { ok: false, reason: "not_found" });
  assert.deepEqual(await s.get("never-existed"), { ok: false, reason: "not_found" });
});

test("revoking twice is not an error", async () => {
  const s = store();
  const { shareId } = await s.mint(base());
  assert.equal(await s.revoke(shareId, "alice"), true);
  assert.equal(await s.revoke(shareId, "alice"), false, "second revoke is a no-op, not a throw");
});

test("listing a session shows only its own live shares", async () => {
  const s = store();
  const a = await s.mint(base());
  const b = await s.mint({ ...base(), sessionId: "s2" });
  await s.mint(base()).then((m) => s.revoke(m.shareId, "alice"));
  const forS1 = await s.forSession("s1");
  assert.deepEqual(
    forS1.map((x) => x.shareId),
    [a.shareId],
  );
  assert.deepEqual(
    (await s.forSession("s2")).map((x) => x.shareId),
    [b.shareId],
  );
});

test("views are counted, which is the compensating control for having no expiry", async () => {
  const s = store();
  const { shareId } = await s.mint(base());
  await s.noteView(shareId, 1000);
  await s.noteView(shareId, 2000);
  const got = await s.get(shareId);
  assert.ok(got.ok);
  assert.equal(got.rec.viewCount, 2);
  assert.equal(got.rec.lastViewedAt, 2000);
});

test("a revoked share stops counting views", async () => {
  const s = store();
  const { shareId } = await s.mint(base());
  await s.revoke(shareId, "alice");
  await s.noteView(shareId, 5000);
  assert.equal((await s.get(shareId)).ok, false);
});

test("the sweeper clears old tombstones and leaves live shares alone", async () => {
  const s = store();
  const live = await s.mint(base());
  const dead = await s.mint(base());
  await s.revoke(dead.shareId, "alice", 1000);
  assert.equal(await s.sweep(500, 2000), 1, "past grace");
  assert.equal((await s.get(live.shareId)).ok, true, "the live one survives");
  const fresh = await s.mint(base());
  await s.revoke(fresh.shareId, "alice", 1000);
  assert.equal(await s.sweep(10_000, 2000), 0, "within grace, kept so revocation stays sticky");
});
