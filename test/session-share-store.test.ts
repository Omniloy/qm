import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
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

/**
 * A backing map that lets a test suspend one operation mid-flight.
 *
 * Concurrency here is not hypothetical: against Postgres every step of a
 * read-modify-write is a network round trip, and the feature's whole containment
 * story is "I regret this, kill it now" landing while people are reading. `hold`
 * arms the next call to `which`; the returned promise resolves once that call is
 * parked, and `release` lets it continue.
 */
function stallable(inner: DurableMap<SessionShareRecord>, which: "update" | "get") {
  let release: (() => void) | null = null;
  let parked: (() => void) | null = null;
  let armed = false;
  const wait = async (): Promise<void> => {
    if (!armed) return;
    armed = false;
    await new Promise<void>((resolve) => {
      release = resolve;
      parked?.();
    });
  };
  const map: DurableMap<SessionShareRecord> = {
    all: () => inner.all(),
    entries: () => inner.entries(),
    async get(id) {
      // Stalled AFTER the read, not before: the failure being reproduced is a
      // write built from a record that was already stale when it landed.
      const value = await inner.get(id);
      if (which === "get") await wait();
      return value;
    },
    put: (id, v) => inner.put(id, v),
    putIfAbsent: (id, v) => inner.putIfAbsent(id, v),
    merge: (id, patch) => inner.merge(id, patch),
    delete: (id) => inner.delete(id),
    take: (id) => inner.take(id),
    // `update` is optional in DurableMap, so omitting it is a shape the store has
    // to survive — that is the whole point of the second scenario below.
    ...(which === "update"
      ? {
          async update(id: string, fn: (value: SessionShareRecord) => SessionShareRecord) {
            await wait();
            return inner.update!(id, fn);
          },
        }
      : {}),
  };
  return {
    map,
    /**
     * Arm the next call and resolve once it is parked.
     *
     * Bounded rather than open-ended: if the store stops using this operation the
     * test must say so, not hang until the runner gives up on it.
     */
    hold(): Promise<void> {
      armed = true;
      const reached = new Promise<void>((resolve) => (parked = resolve));
      return Promise.race([
        reached,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`the store never called ${which}, so nothing was stalled`)), 2000).unref(),
        ),
      ]);
    },
    release(): void {
      release?.();
      release = null;
    },
  };
}

for (const which of ["update", "get"] as const) {
  test(`a view landing over a revoke cannot resurrect the link (${which}-backed)`, async () => {
    const rig = stallable(createMemoryMap<SessionShareRecord>(), which);
    const s = createSessionShareStore(rig.map);
    const { shareId } = await s.mint(base());

    // A reader's poll begins and stalls exactly where a durable round trip would.
    const parked = rig.hold();
    const viewing = s.noteView(shareId, 1000);
    await parked;

    // The sharer revokes while that view is in flight, and is told it worked.
    assert.equal(await s.revoke(shareId, "alice", 2000), true);

    // The stalled view now completes on top of the tombstone.
    rig.release();
    await viewing;

    assert.deepEqual(
      await s.get(shareId),
      { ok: false, reason: "not_found" },
      "the view wrote back the record it read, and the revocation was lost",
    );
    const raw = await rig.map.get(shareId);
    assert.equal(raw?.revokedAt, 2000, "the tombstone itself must survive, not just the read path");
    assert.equal(raw?.revokedBy, "alice");
  });
}

test("a revoke racing another revoke reports the win exactly once", async () => {
  const rig = stallable(createMemoryMap<SessionShareRecord>(), "update");
  const s = createSessionShareStore(rig.map);
  const { shareId } = await s.mint(base());

  const parked = rig.hold();
  const first = s.revoke(shareId, "alice", 1000);
  await parked;
  assert.equal(await s.revoke(shareId, "bob", 2000), true, "the one that lands first turns it off");
  rig.release();
  assert.equal(await first, false, "the loser reports no-op rather than claiming a second revocation");
  assert.equal((await rig.map.get(shareId))?.revokedBy, "bob", "and does not overwrite who did it");
});
