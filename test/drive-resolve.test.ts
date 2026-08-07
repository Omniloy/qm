import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMountStore, type DriveMount } from "../src/mounts/mount-store.ts";
import { createListingCache } from "../src/mounts/listing-cache.ts";
import { DriveListError, type Listing } from "../src/mounts/drive-listing.ts";
import { resolveAttachedFolders, type ResolveDeps } from "../src/mounts/resolve.ts";

const NOW = 1_700_000_000_000;
const SCOPE = "project:acme";

const listing = (names: string[], calls = 1): Listing => ({
  entries: names.map((n) => ({ id: `id-${n}`, name: n, mimeType: "text/plain", dir: "" })),
  truncated: false,
  calls,
});

async function harness(
  over: Partial<ResolveDeps> = {},
  mountSpecs: Array<{ name: string; externalId: string }> = [{ name: "specs", externalId: "folder-1" }],
) {
  const store = createMountStore(createMemoryMap<DriveMount>());
  for (const m of mountSpecs) {
    await store.attach({ scopeId: SCOPE, externalId: m.externalId, name: m.name, mode: "rw", createdBy: "ada" }, NOW);
  }
  const cache = createListingCache();
  const calls: string[] = [];
  const deps: ResolveDeps = {
    mounts: store,
    cache,
    tokenFor: async () => "tok",
    listFolder: async (_t, folderId) => {
      calls.push(folderId);
      return listing([`${folderId}.txt`]);
    },
    ...over,
  };
  return { deps, cache, store, calls };
}

const run = (deps: ResolveDeps, over: Partial<Parameters<typeof resolveAttachedFolders>[1]> = {}) =>
  resolveAttachedFolders(deps, { scopeIds: [SCOPE], principalId: "ada@example.com", nowMs: NOW, ...over });

test("no mounts produces no block and no Drive calls", async () => {
  const { deps, calls } = await harness({}, []);
  const out = await run(deps);
  assert.equal(out.block, "");
  assert.deepEqual(calls, []);
});

test("a connected actor gets the folder listing", async () => {
  const { deps } = await harness();
  const out = await run(deps);
  assert.match(out.block, /## Attached folders/);
  assert.match(out.block, /folder-1\.txt/);
  assert.equal(out.listings.length, 1);
});

test("no connected Google account explains itself instead of showing nothing", async () => {
  const { deps, calls } = await harness({ tokenFor: async () => null });
  const out = await run(deps);
  assert.match(out.block, /not connected/i);
  assert.match(out.block, /connect Google Workspace/i);
  assert.deepEqual(calls, [], "no Drive call is attempted without a token");
  assert.equal(out.listings.length, 0);
});

test("a 403 on every mount reports lack of access, not an empty folder list", async () => {
  const { deps } = await harness({
    listFolder: async () => {
      throw new DriveListError(403, "forbidden");
    },
  });
  const out = await run(deps);
  assert.match(out.block, /cannot open them/i);
  assert.match(out.block, /access granted in Drive/i);
  assert.equal(out.inaccessibleMountIds.length, 1);
});

test("404 counts as no access — the folder may simply never have been visible", async () => {
  const { deps } = await harness({
    listFolder: async () => {
      throw new DriveListError(404, "not found");
    },
  });
  const out = await run(deps);
  assert.equal(out.inaccessibleMountIds.length, 1);
  assert.match(out.block, /cannot open them/i);
});

test("one inaccessible folder does not hide the ones that work", async () => {
  const { deps } = await harness(
    {
      listFolder: async (_t, folderId) => {
        if (folderId === "folder-2") throw new DriveListError(403, "forbidden");
        return listing([`${folderId}.txt`]);
      },
    },
    [
      { name: "specs", externalId: "folder-1" },
      { name: "research", externalId: "folder-2" },
    ],
  );
  const out = await run(deps);
  assert.match(out.block, /folder-1\.txt/);
  assert.equal(out.listings.length, 1);
  assert.equal(out.inaccessibleMountIds.length, 1, "the unreachable one is reported for the UI");
});

test("a transient failure is not reported to the person as a permissions problem", async () => {
  const seen: string[] = [];
  const { deps } = await harness({
    listFolder: async () => {
      throw new DriveListError(500, "drive is unwell");
    },
    onError: (e) => seen.push(e.code),
  });
  const out = await run(deps);
  assert.deepEqual(out.inaccessibleMountIds, [], "500 is not a permissions verdict");
  assert.equal(out.block, "", "no misleading block is rendered");
  assert.deepEqual(seen, ["drive_list_failed"], "but it is recorded");
});

test("a cached listing is reused instead of re-listing", async () => {
  const { deps, calls } = await harness();
  await run(deps);
  await run(deps);
  assert.deepEqual(calls, ["folder-1"], "second turn inside the TTL makes no Drive call");
});

test("the cache is per person — a teammate's turn lists for themselves", async () => {
  const { deps, calls } = await harness();
  await run(deps, { principalId: "ada@example.com" });
  await run(deps, { principalId: "grace@example.com" });
  assert.deepEqual(calls, ["folder-1", "folder-1"], "Grace must not read Ada's listing");
});

test("the per-turn call budget is shared across mounts and stops further listings", async () => {
  const listed: string[] = [];
  const { deps } = await harness(
    {
      listFolder: async (_t, id) => {
        listed.push(id);
        return listing([`${id}.txt`], 3);
      },
    },
    [
      { name: "a", externalId: "f1" },
      { name: "b", externalId: "f2" },
      { name: "c", externalId: "f3" },
    ],
  );

  const out = await run(deps, { callBudget: 6 });

  assert.deepEqual(listed, ["f1", "f2"], "the third mount is not listed once the budget is spent");
  assert.equal(out.callsUsed, 6);
  assert.equal(out.listings.length, 2);
  assert.deepEqual(out.inaccessibleMountIds, [], "running out of budget is not a permissions problem");
});

test("mounts across several scopes are gathered together", async () => {
  const store = createMountStore(createMemoryMap<DriveMount>());
  await store.attach({ scopeId: "project:a", externalId: "f1", name: "one", mode: "rw", createdBy: "ada" }, NOW);
  await store.attach({ scopeId: "project:b", externalId: "f2", name: "two", mode: "rw", createdBy: "ada" }, NOW);
  const deps: ResolveDeps = {
    mounts: store,
    cache: createListingCache(),
    tokenFor: async () => "tok",
    listFolder: async (_t, id) => listing([`${id}.txt`]),
  };

  const out = await resolveAttachedFolders(deps, {
    scopeIds: ["project:a", "project:b"],
    principalId: "ada@example.com",
    nowMs: NOW,
  });

  assert.equal(out.listings.length, 2);
  assert.match(out.block, /### one/);
  assert.match(out.block, /### two/);
});

test("a folder that is off never reaches the agent's prompt", async () => {
  // The end of the chain the store test starts: off has to mean the agent
  // cannot see the folder, and cannot spend a Drive call discovering that.
  const { deps, store, calls } = await harness({}, [
    { name: "specs", externalId: "folder-1" },
    { name: "archive", externalId: "folder-2" },
  ]);
  const archive = (await store.forScope(SCOPE)).find((m) => m.name === "archive")!;
  await store.setEnabled(archive.id, false, NOW);

  const out = await run(deps);
  assert.match(out.block, /### specs/);
  assert.doesNotMatch(out.block, /### archive/, "an off folder must not appear in the block");
  assert.deepEqual(calls, ["folder-1"], "and must not cost a Drive call");
  assert.equal(out.listings.length, 1);
});

test("turning every folder off is the same as having none", async () => {
  const { deps, store, calls } = await harness();
  const only = (await store.forScope(SCOPE))[0]!;
  await store.setEnabled(only.id, false, NOW);

  const out = await run(deps);
  assert.equal(out.block, "", "no section at all, rather than an empty heading");
  assert.deepEqual(calls, []);
});
