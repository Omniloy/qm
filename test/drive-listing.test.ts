import assert from "node:assert/strict";
import test from "node:test";
import {
  listFolder,
  isNativeGoogleType,
  DriveListError,
  FOLDER_MIME,
  SHORTCUT_MIME,
} from "../src/mounts/drive-listing.ts";

type Child = { id: string; name: string; mimeType: string; size?: string };

/** A fake Drive that answers `'<id>' in parents` from a tree, with optional paging. */
function fakeDrive(tree: Record<string, Child[]>, opts: { pageSize?: number; incompleteFor?: string } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    const q = u.searchParams.get("q") ?? "";
    const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? "";
    calls.push(parent);

    assert.match(q, /trashed = false/, "every listing must exclude trashed files");
    assert.equal(u.searchParams.get("corpora"), "allDrives");
    assert.equal(u.searchParams.get("includeItemsFromAllDrives"), "true");
    assert.equal(u.searchParams.get("supportsAllDrives"), "true");

    const all = tree[parent] ?? [];
    const size = opts.pageSize ?? (all.length || 1);
    const offset = Number(u.searchParams.get("pageToken") ?? "0");
    const page = all.slice(offset, offset + size);
    const nextOffset = offset + size;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        files: page,
        ...(nextOffset < all.length ? { nextPageToken: String(nextOffset) } : {}),
        ...(opts.incompleteFor === parent ? { incompleteSearch: true } : {}),
      }),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const file = (id: string, name: string, mimeType = "text/plain"): Child => ({ id, name, mimeType });
const folder = (id: string, name: string): Child => ({ id, name, mimeType: FOLDER_MIME });

test("walks nested folders and records each file's directory", async () => {
  const { fetchImpl } = fakeDrive({
    root: [file("f1", "readme.md"), folder("sub", "Specs")],
    sub: [file("f2", "roadmap.md"), folder("deep", "Q4")],
    deep: [file("f3", "budget.csv")],
  });

  const listing = await listFolder("tok", "root", { fetchImpl });

  assert.deepEqual(
    listing.entries.map((e) => (e.dir ? `${e.dir}/${e.name}` : e.name)),
    ["readme.md", "Specs/roadmap.md", "Specs/Q4/budget.csv"],
  );
  assert.equal(listing.truncated, false);
});

test("shortcuts are never presented as folder contents", async () => {
  const { fetchImpl } = fakeDrive({
    root: [file("f1", "real.md"), { id: "s1", name: "elsewhere", mimeType: SHORTCUT_MIME }],
  });
  const listing = await listFolder("tok", "root", { fetchImpl });
  assert.deepEqual(
    listing.entries.map((e) => e.name),
    ["real.md"],
  );
});

test("pagination is drained", async () => {
  const many = Array.from({ length: 7 }, (_, i) => file(`f${i}`, `file-${i}.txt`));
  const { fetchImpl, calls } = fakeDrive({ root: many }, { pageSize: 3 });

  const listing = await listFolder("tok", "root", { fetchImpl });

  assert.equal(listing.entries.length, 7);
  assert.equal(calls.length, 3, "three pages");
});

test("depth limit truncates and says so", async () => {
  const { fetchImpl } = fakeDrive({
    root: [folder("a", "A")],
    a: [folder("b", "B"), file("fa", "a.txt")],
    b: [file("fb", "b.txt")],
  });

  const listing = await listFolder("tok", "root", { fetchImpl, limits: { maxDepth: 1 } });

  assert.deepEqual(
    listing.entries.map((e) => e.name),
    ["a.txt"],
    "the too-deep folder is not descended into",
  );
  assert.equal(listing.truncated, true);
  assert.equal(listing.truncatedReason, "depth");
});

test("entry cap truncates and says so", async () => {
  const many = Array.from({ length: 10 }, (_, i) => file(`f${i}`, `file-${i}.txt`));
  const { fetchImpl } = fakeDrive({ root: many });

  const listing = await listFolder("tok", "root", { fetchImpl, limits: { maxEntries: 4 } });

  assert.equal(listing.entries.length, 4);
  assert.equal(listing.truncated, true);
  assert.equal(listing.truncatedReason, "entries");
});

test("call budget bounds a wide tree", async () => {
  const tree: Record<string, Child[]> = { root: Array.from({ length: 20 }, (_, i) => folder(`d${i}`, `dir-${i}`)) };
  for (let i = 0; i < 20; i++) tree[`d${i}`] = [file(`f${i}`, `file-${i}.txt`)];
  const { fetchImpl, calls } = fakeDrive(tree);

  const listing = await listFolder("tok", "root", { fetchImpl, limits: { maxCalls: 5 } });

  assert.equal(calls.length, 5);
  assert.equal(listing.calls, 5);
  assert.equal(listing.truncated, true);
  assert.equal(listing.truncatedReason, "calls");
});

test("Drive's own incompleteSearch marks the listing truncated", async () => {
  const { fetchImpl } = fakeDrive({ root: [file("f1", "a.txt")] }, { incompleteFor: "root" });
  const listing = await listFolder("tok", "root", { fetchImpl });
  assert.equal(listing.entries.length, 1, "results are still returned");
  assert.equal(listing.truncated, true);
  assert.equal(listing.truncatedReason, "incomplete-search");
});

test("breadth-first, so a budget cut keeps the top of the tree", async () => {
  const { fetchImpl } = fakeDrive({
    root: [folder("a", "A"), folder("b", "B")],
    a: [file("fa", "a.txt")],
    b: [file("fb", "b.txt")],
  });
  const { calls } = fakeDrive({});
  void calls;

  const listing = await listFolder("tok", "root", { fetchImpl, limits: { maxCalls: 2 } });

  // root then A — never A's children before B has been seen.
  assert.equal(listing.truncated, true);
  assert.deepEqual(
    listing.entries.map((e) => e.name),
    ["a.txt"],
  );
});

test("an API error surfaces its status rather than an empty folder", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(
    () => listFolder("tok", "root", { fetchImpl }),
    (e: unknown) => e instanceof DriveListError && e.status === 403,
  );
});

test("native Google types are identified for read-only handling", () => {
  assert.equal(isNativeGoogleType("application/vnd.google-apps.document"), true);
  assert.equal(isNativeGoogleType("application/vnd.google-apps.spreadsheet"), true);
  assert.equal(isNativeGoogleType("text/markdown"), false);
  assert.equal(isNativeGoogleType("application/pdf"), false);
});
