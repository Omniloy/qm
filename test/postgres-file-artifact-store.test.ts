import { assertDocumentListing } from "./support/file-document-listing.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { ORPHANED_BLOB_GRACE_MS, fileArtifactId, type PutFileInput } from "../src/files/file-artifact-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres file-artifact-store tests";

const owner = scopeId("channel", "C1");
const other = scopeId("personal", "U9");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query("DROP TABLE IF EXISTS file_artifacts CASCADE");
  await p.query("DROP TABLE IF EXISTS file_artifact_deletions CASCADE");
  await p.query("DROP TABLE IF EXISTS file_blob_orphans CASCADE");
  await p.end();
});

function put(over: Partial<PutFileInput> = {}): PutFileInput {
  return {
    id: fileArtifactId("run-1", "out", 0),
    ownerScopeId: owner,
    createdBy: "U1",
    name: "flag.png",
    path: "artifacts/flag.png",
    mimetype: "image/png",
    data: PNG,
    direction: "out",
    createdInScope: owner,
    createdAt: 1000,
    ...over,
  };
}

test("pg put is an idempotent upsert by deterministic id (no dup, no byte re-store)", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  let putCount = 0;
  const counting = {
    put: (s: never, o: never) => {
      putCount++;
      return bytes.put(s, o);
    },
    open: bytes.open,
    delete: bytes.delete,
  };
  const store = createPostgresFileArtifactStore(URL!, counting as never);

  const first = await store.put(put());
  assert.equal(first.created, true);
  const second = await store.put(put({ name: "renamed.png" }));
  assert.equal(second.created, false);
  assert.equal(second.artifact.name, "flag.png", "existing row returned unchanged");
  assert.equal(putCount, 1, "no byte re-store on requeue");
  assert.equal((await store.listOwnedByScopes([owner])).files.length, 1);
});

test("pg listOwnedByScopes: recency DESC, scope-filtered, keyset-paginated", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdAt: 300 }));
  await store.put(put({ id: "z", ownerScopeId: other, path: "p/z", data: Buffer.from("z"), createdAt: 999 }));

  assert.deepEqual(
    (await store.listOwnedByScopes([owner])).files.map((f) => f.id),
    ["c", "b", "a"],
  );
  const p1 = await store.listOwnedByScopes([owner], { limit: 2 });
  assert.deepEqual(
    p1.files.map((f) => f.id),
    ["c", "b"],
  );
  assert.ok(p1.nextCursor);
  const p2 = await store.listOwnedByScopes([owner], { limit: 2, cursor: p1.nextCursor! });
  assert.deepEqual(
    p2.files.map((f) => f.id),
    ["a"],
  );
  assert.equal(p2.nextCursor, undefined);
});

test("pg listOwnedByScopes: created-scope and enabled filters compose", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", ownerScopeId: other, path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdInScope: other, createdAt: 300 }));
  await store.put(put({ id: "d", ownerScopeId: other, path: "p/d", data: Buffer.from("d"), createdAt: 400 }));
  await store.setEnabled("d", false);

  const visible = await store.listOwnedByScopes([owner, other], { createdInScope: owner });
  assert.deepEqual(
    visible.files.map((f) => f.id),
    ["b", "a"],
  );
  const all = await store.listOwnedByScopes([owner, other], { createdInScope: owner, includeDisabled: true });
  assert.deepEqual(
    all.files.map((f) => f.id),
    ["d", "b", "a"],
  );
});

test("pg listOwnedByScopes: nameQuery is case-insensitive and treats wildcards as literals", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "a", name: "Quarterly Report.pdf", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", name: "notes.txt", path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", name: "report-draft.txt", path: "p/c", data: Buffer.from("c"), createdAt: 300 }));
  await store.put(put({ id: "d", name: "100%_done.txt", path: "p/d", data: Buffer.from("d"), createdAt: 400 }));
  await store.put(put({ id: "e", name: "dir\\file.txt", path: "p/e", data: Buffer.from("e"), createdAt: 500 }));

  const hit = await store.listOwnedByScopes([owner], { nameQuery: "REPORT" });
  assert.deepEqual(
    hit.files.map((f) => f.id),
    ["c", "a"],
  );
  const literal = await store.listOwnedByScopes([owner], { nameQuery: "%_" });
  assert.deepEqual(
    literal.files.map((f) => f.id),
    ["d"],
    "% and _ match only themselves, not as SQL wildcards",
  );
  const backslash = await store.listOwnedByScopes([owner], { nameQuery: "dir\\file" });
  assert.deepEqual(
    backslash.files.map((f) => f.id),
    ["e"],
    "a literal backslash in the query matches itself",
  );
  assert.equal((await store.listOwnedByScopes([owner], { nameQuery: "missing" })).files.length, 0);
});

test("pg scoped file pages have a matching enabled recency index", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.listOwnedByScopes([owner], { createdInScope: owner });
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const result = await raw.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'file_artifacts_scope_created'");
    assert.match(
      result.rows[0]?.indexdef ?? "",
      /\(created_in_scope, created_at DESC, id DESC\).*WHERE \(enabled = true\)/,
    );
  } finally {
    await raw.end();
  }
});

test("pg resolveByOwnerPaths returns the shared set; disabled excluded", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "r1", path: "p/r1", data: Buffer.from("1") }));
  await store.put(put({ id: "r2", path: "p/r2", data: Buffer.from("2") }));

  assert.deepEqual(
    (await store.resolveByOwnerPaths([{ ownerScopeId: owner, path: "p/r1" }])).map((f) => f.id),
    ["r1"],
  );
  await store.setEnabled("r1", false);
  assert.equal((await store.resolveByOwnerPaths([{ ownerScopeId: owner, path: "p/r1" }])).length, 0);
});

test("pg open round-trips bytes; delete removes the ROW only", { skip }, async () => {
  const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await store.put(put({ id: "o1", direction: "out", path: "p/o1", data: PNG }));
  await store.put(put({ id: "i1", direction: "in", path: "p/i1", data: PNG }));

  const opened = await store.open("o1");
  assert.ok(opened);
  const chunks: Buffer[] = [];
  for await (const c of opened!.stream) chunks.push(c as Buffer);
  assert.deepEqual(Buffer.concat(chunks), PNG);

  await store.delete("o1");
  assert.equal(await store.get("o1"), null, "row gone");
  assert.ok(await store.open("i1"), "shared bytes survive (no inline byte delete)");
  assert.equal(await store.sweepOrphanedBlobs(Date.now() + ORPHANED_BLOB_GRACE_MS + 1), 0);
  assert.ok(await store.open("i1"), "the sweep never reclaims bytes a row still points at");
});

test(
  "pg orphan sweep reclaims the last reference's bytes after the grace, never a re-uploaded blob",
  { skip },
  async () => {
    const bytes = createMemoryDurableByteStore();
    const store = createPostgresFileArtifactStore(URL!, bytes);
    const gone = await store.put(put({ id: "gone", path: "p/gone", data: Buffer.from("only once") }));
    const raced = await store.put(put({ id: "raced", path: "p/raced", data: PNG }));
    await store.delete("gone");
    await store.delete("raced");
    const again = await store.put(put({ id: "again", path: "p/again", data: PNG }));
    assert.equal(again.artifact.blobKey, raced.artifact.blobKey);

    assert.equal(await store.sweepOrphanedBlobs(), 0, "inside the grace nothing is reclaimed");
    assert.equal(await store.sweepOrphanedBlobs(Date.now() + ORPHANED_BLOB_GRACE_MS + 1), 1);
    assert.equal(await bytes.open(gone.artifact.blobKey!), null);
    assert.ok(await store.open("again"), "an identical upload racing the delete is never left dangling");
    assert.equal(await store.sweepOrphanedBlobs(Date.now() + ORPHANED_BLOB_GRACE_MS + 1), 0);
  },
);

test(
  "pg: an identical upload landing while the sweep deletes that blob waits for it and keeps its bytes",
  { skip },
  async () => {
    const bytes = createMemoryDurableByteStore();
    let deleteStarted!: () => void;
    const started = new Promise<void>((resolve) => (deleteStarted = resolve));
    let finishDelete!: () => void;
    const gate = new Promise<void>((resolve) => (finishDelete = resolve));
    const store = createPostgresFileArtifactStore(URL!, {
      ...bytes,
      delete: async (blobKey) => {
        deleteStarted();
        await gate;
        await bytes.delete(blobKey);
      },
    });
    await store.put(put({ id: "first", path: "p/first" }));
    await store.delete("first");
    const sweep = store.sweepOrphanedBlobs(Date.now() + ORPHANED_BLOB_GRACE_MS + 1);
    await started;
    const again = store.put(put({ id: "again", path: "p/again" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    finishDelete();
    assert.equal(await sweep, 1);
    await again;
    assert.ok(await store.open("again"), "the new row is never left dangling");
  },
);

test("pg bytes stored for an upload that never publishes are reclaimed by the sweep", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  const store = createPostgresFileArtifactStore(URL!, bytes);
  await store.delete("ghost");
  await assert.rejects(store.put(put({ id: "ghost", data: Buffer.from("never published") })), /deleted/);
  assert.equal(await store.sweepOrphanedBlobs(), 0, "inside the grace nothing is reclaimed");
  assert.equal(await store.sweepOrphanedBlobs(Date.now() + ORPHANED_BLOB_GRACE_MS + 1), 1);
});

test("pg re-uploading orphaned bytes refreshes the orphan so a sweep mid-upload keeps them", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  let written!: () => void;
  const paused = new Promise<void>((resolve) => (written = resolve));
  let release!: () => void;
  const publishing = new Promise<void>((resolve) => (release = resolve));
  let gated = false;
  const store = createPostgresFileArtifactStore(URL!, {
    ...bytes,
    put: async (source, opts) => {
      const stored = await bytes.put(source, opts);
      if (gated) {
        written();
        await publishing;
      }
      return stored;
    },
  });
  await store.put(put({ id: "first", path: "p/first" }));
  await store.delete("first");
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    assert.equal((await p.query("UPDATE file_blob_orphans SET orphaned_at = 0")).rowCount, 1);
  } finally {
    await p.end();
  }
  gated = true;
  const again = store.put(put({ id: "again", path: "p/again" }));
  await paused;
  try {
    assert.equal(await store.sweepOrphanedBlobs(), 0, "a reserved upload's bytes are not due");
  } finally {
    release();
  }
  await again;
  assert.ok(await store.open("again"), "the new row opens after publish");
});

test("pg uploads in flight hold no pooled connection while their bytes transfer", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  let release!: () => void;
  const transferring = new Promise<void>((resolve) => (release = resolve));
  let reserved = 0;
  const store = createPostgresFileArtifactStore(URL!, {
    ...bytes,
    put: (source, opts) =>
      bytes.put(source, {
        ...opts,
        beforeCommit: async (blobKey) => {
          await opts?.beforeCommit?.(blobKey);
          reserved += 1;
          await transferring;
        },
      }),
  });
  const uploads = Array.from({ length: 12 }, (_, i) =>
    store.put(put({ id: `slow-${i}`, path: `p/slow-${i}`, data: Buffer.from(`slow ${i}`) })),
  );
  try {
    for (let waited = 0; reserved < uploads.length && waited < 3000; waited += 10)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reserved, uploads.length, "every upload reaches its byte transfer at once");
    const unrelated = await Promise.race([
      store.get("missing").then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("starved"), 3000)),
    ]);
    assert.equal(unrelated, "answered");
  } finally {
    release();
  }
  assert.ok((await Promise.all(uploads)).every((result) => result.created));
});

test("pg rows survive across store instances (no per-process cache to diverge)", { skip }, async () => {
  const writer = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  await writer.put(put({ id: "across", path: "p/across", data: Buffer.from("x"), createdAt: 5 }));
  const reader = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
  assert.ok(await reader.get("across"));
});

test("pg document listing groups authorized copies before pagination", { skip }, async () => {
  await assertDocumentListing(createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore()));
});

test(
  "pg document listing keeps unknown hashes separate and picks deterministic representatives",
  { skip },
  async () => {
    const store = createPostgresFileArtifactStore(URL!, createMemoryDurableByteStore());
    for (const id of ["b", "a", "unknown-1", "unknown-2"]) await store.put(put({ id, path: id, createdAt: 100 }));
    const pg = (await import("pg")).default;
    const raw = new pg.Pool({ connectionString: URL });
    try {
      await raw.query("UPDATE file_artifacts SET sha256 = NULL WHERE id = ANY($1::text[])", [
        ["unknown-1", "unknown-2"],
      ]);
      assert.deepEqual(
        (await store.listDocuments([owner], [])).files.map((f) => f.id),
        ["unknown-2", "unknown-1", "a"],
      );
    } finally {
      await raw.end();
    }
  },
);
test("pg deletion fences recovery publication across fresh store instances", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  const first = createPostgresFileArtifactStore(URL!, bytes);
  const second = createPostgresFileArtifactStore(URL!, bytes);
  const { artifact } = await first.put(put());
  await second.delete(artifact.id);
  await assert.rejects(
    first.publish({ ...put(), blobKey: artifact.blobKey!, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 }),
    /deleted/,
  );
  assert.equal(await first.get(artifact.id, { includeDisabled: true }), null);
  assert.deepEqual((await first.listOwnedByScopes([owner])).files, []);
});

test("pg concurrent deletion and recovery publication always leave the file deleted", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  const first = createPostgresFileArtifactStore(URL!, bytes);
  const second = createPostgresFileArtifactStore(URL!, bytes);
  const { artifact } = await first.put(put());
  await Promise.allSettled([
    first.publish({ ...put(), blobKey: artifact.blobKey!, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 }),
    second.delete(artifact.id),
  ]);
  assert.equal(await first.get(artifact.id, { includeDisabled: true }), null);
});

test("pg concurrent first shares reuse one path generation and republish after deletion", { skip }, async () => {
  const bytes = createMemoryDurableByteStore();
  const first = createPostgresFileArtifactStore(URL!, bytes);
  const second = createPostgresFileArtifactStore(URL!, bytes);
  const input = { ...put(), reuseExistingPath: true };
  const initial = await Promise.all([
    first.put({ ...input, id: "share-one" }),
    second.put({ ...input, id: "share-two" }),
  ]);
  assert.equal(initial[0].artifact.id, initial[1].artifact.id);
  assert.equal(initial.filter((result) => result.created).length, 1);
  await first.delete(initial[0].artifact.id);
  const current = await second.put({ ...input, id: "share-three", data: Buffer.from("new content") });
  assert.equal(current.created, true);
  assert.equal(current.artifact.id, "share-three");
  assert.equal((await first.resolveByOwnerPaths([{ ownerScopeId: owner, path: input.path }])).length, 1);
});
