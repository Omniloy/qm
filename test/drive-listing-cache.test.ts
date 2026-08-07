import assert from "node:assert/strict";
import test from "node:test";
import { createListingCache } from "../src/mounts/listing-cache.ts";
import type { Listing } from "../src/mounts/drive-listing.ts";

const listing = (name: string): Listing => ({
  entries: [{ id: `id-${name}`, name, mimeType: "text/plain", dir: "" }],
  truncated: false,
  calls: 1,
});

test("a listing is scoped to the person who made it", () => {
  const c = createListingCache();
  c.set("ada@example.com", "mount-1", listing("ada-view.txt"), 1_000);

  assert.equal(c.get("ada@example.com", "mount-1", 1_000)?.listing.entries[0]!.name, "ada-view.txt");
  assert.equal(c.get("grace@example.com", "mount-1", 1_000), null, "another person must not read Ada's listing");
});

test("entries expire once the TTL has elapsed", () => {
  const c = createListingCache({ ttlMs: 60_000 });
  c.set("ada", "m1", listing("a.txt"), 1_000);

  assert.ok(c.get("ada", "m1", 60_000), "still fresh just under the TTL");
  assert.equal(c.get("ada", "m1", 61_000), null, "expired exactly at the TTL");
  assert.equal(c.size(), 0, "an expired entry is dropped, not merely hidden");
});

test("listedAt is preserved so the prompt block can state when it was listed", () => {
  const c = createListingCache();
  const stored = c.set("ada", "m1", listing("a.txt"), 1_700_000_000_000);
  assert.equal(stored.listedAt, 1_700_000_000_000);
  assert.equal(c.get("ada", "m1", 1_700_000_010_000)?.listedAt, 1_700_000_000_000);
});

test("invalidate busts one person's view only", () => {
  const c = createListingCache();
  c.set("ada", "m1", listing("a.txt"), 1_000);
  c.set("grace", "m1", listing("g.txt"), 1_000);

  c.invalidate("ada", "m1");

  assert.equal(c.get("ada", "m1", 1_000), null, "the caller's entry is gone");
  assert.ok(c.get("grace", "m1", 1_000), "a teammate's listing is untouched by my refresh");
});

test("invalidateMount clears every viewer, for detach", () => {
  const c = createListingCache();
  c.set("ada", "m1", listing("a.txt"), 1_000);
  c.set("grace", "m1", listing("g.txt"), 1_000);
  c.set("ada", "m2", listing("other.txt"), 1_000);

  c.invalidateMount("m1");

  assert.equal(c.get("ada", "m1", 1_000), null);
  assert.equal(c.get("grace", "m1", 1_000), null);
  assert.ok(c.get("ada", "m2", 1_000), "an unrelated mount survives");
});

test("invalidateMount does not match a mount id that is only a suffix of another", () => {
  const c = createListingCache();
  c.set("ada", "m1", listing("a.txt"), 1_000);
  c.set("ada", "xxm1", listing("b.txt"), 1_000);

  c.invalidateMount("m1");

  assert.equal(c.get("ada", "m1", 1_000), null);
  assert.ok(c.get("ada", "xxm1", 1_000), "a longer id ending in the same characters is a different mount");
});

test("the cache is bounded and evicts least-recently-used", () => {
  const c = createListingCache({ maxEntries: 2 });
  c.set("p1", "m", listing("1"), 1_000);
  c.set("p2", "m", listing("2"), 1_000);

  // Touch p1 so p2 becomes the least recently used.
  assert.ok(c.get("p1", "m", 1_000));

  c.set("p3", "m", listing("3"), 1_000);

  assert.equal(c.size(), 2);
  assert.ok(c.get("p1", "m", 1_000), "recently read entry survives");
  assert.equal(c.get("p2", "m", 1_000), null, "least recently used was evicted");
  assert.ok(c.get("p3", "m", 1_000), "the new entry is present");
});

test("re-setting a key replaces rather than duplicates", () => {
  const c = createListingCache();
  c.set("ada", "m1", listing("old.txt"), 1_000);
  c.set("ada", "m1", listing("new.txt"), 2_000);

  assert.equal(c.size(), 1);
  assert.equal(c.get("ada", "m1", 2_000)?.listing.entries[0]!.name, "new.txt");
});
