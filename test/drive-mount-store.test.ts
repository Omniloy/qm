import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMountStore,
  mountId,
  mountNameError,
  slugFromFolderName,
  MountNameInUseError,
  type DriveMount,
} from "../src/mounts/mount-store.ts";

const store = () => createMountStore(createMemoryMap<DriveMount>());

const attach = (over: Partial<Parameters<ReturnType<typeof store>["attach"]>[0]> = {}) => ({
  scopeId: "project:acme",
  externalId: "folder-1",
  name: "specs",
  mode: "rw" as const,
  createdBy: "ada@example.com",
  ...over,
});

test("mount identity is (scopeId, name), not the folder id", () => {
  assert.equal(mountId("project:acme", "specs"), mountId("project:acme", "specs"));
  assert.notEqual(mountId("project:acme", "specs"), mountId("project:other", "specs"));
  assert.notEqual(mountId("project:acme", "specs"), mountId("project:acme", "research"));
});

test("re-attaching the same folder under the same name updates in place", async () => {
  const s = store();
  const first = await s.attach(attach(), 1_000);
  const second = await s.attach(attach({ mode: "ro" }), 2_000);

  assert.equal(second.id, first.id);
  assert.equal(second.mode, "ro");
  assert.equal(second.createdAt, 1_000, "createdAt is preserved across re-attach");
  assert.equal(second.updatedAt, 2_000);
  assert.equal((await s.forScope("project:acme")).length, 1, "no duplicate row");
});

test("the original attacher is preserved when someone else re-attaches", async () => {
  const s = store();
  await s.attach(attach(), 1_000);
  const again = await s.attach(attach({ createdBy: "grace@example.com" }), 2_000);
  assert.equal(again.createdBy, "ada@example.com");
});

test("a name already pointing at a different folder is refused, not repointed", async () => {
  const s = store();
  await s.attach(attach(), 1_000);
  await assert.rejects(
    () => s.attach(attach({ externalId: "folder-2" }), 2_000),
    (e: unknown) => e instanceof MountNameInUseError,
  );
  const [only] = await s.forScope("project:acme");
  assert.equal(only!.externalId, "folder-1", "the existing mount is untouched");
});

test("the same folder can be attached to different scopes independently", async () => {
  const s = store();
  await s.attach(attach(), 1_000);
  await s.attach(attach({ scopeId: "personal:ada@example.com" }), 1_000);
  assert.equal((await s.forScope("project:acme")).length, 1);
  assert.equal((await s.forScope("personal:ada@example.com")).length, 1);
});

test("detached mounts disappear from every read path", async () => {
  const s = store();
  const m = await s.attach(attach(), 1_000);
  await s.detach(m.id);
  assert.equal(await s.get(m.id), null);
  assert.deepEqual(await s.forScope("project:acme"), []);
  assert.deepEqual(await s.forScopes(["project:acme"]), []);
});

test("a detached name is free to reuse for a different folder", async () => {
  const s = store();
  const m = await s.attach(attach(), 1_000);
  await s.detach(m.id);
  const reused = await s.attach(attach({ externalId: "folder-2" }), 3_000);
  assert.equal(reused.externalId, "folder-2");
  assert.equal(reused.createdAt, 3_000, "a reused name starts a fresh mount");
});

test("forScopes returns only the requested scopes, in a stable order", async () => {
  const s = store();
  await s.attach(attach({ scopeId: "project:b", name: "zed" }), 1);
  await s.attach(attach({ scopeId: "project:a", name: "beta" }), 1);
  await s.attach(attach({ scopeId: "project:a", name: "alpha" }), 1);
  await s.attach(attach({ scopeId: "project:c", name: "gamma" }), 1);

  const got = await s.forScopes(["project:a", "project:b"]);
  assert.deepEqual(
    got.map((m) => `${m.scopeId}/${m.name}`),
    ["project:a/alpha", "project:a/beta", "project:b/zed"],
  );
  assert.deepEqual(await s.forScopes([]), []);
});

test("mount names are validated at the store, not only at the route", async () => {
  const s = store();
  for (const bad of [
    "",
    "-leading",
    "Upper",
    "has space",
    "trailing-".padEnd(40, "x"),
    "dots.not.allowed",
    "..",
    "a/b",
  ]) {
    assert.ok(mountNameError(bad), `expected ${JSON.stringify(bad)} to be rejected`);
    await assert.rejects(() => s.attach(attach({ name: bad }), 1), `store accepted ${JSON.stringify(bad)}`);
  }
  for (const ok of ["a", "specs", "q4-planning", "2026-roadmap", "x".repeat(32)]) {
    assert.equal(mountNameError(ok), null, `expected ${JSON.stringify(ok)} to be accepted`);
  }
});

test("slugFromFolderName produces names the store accepts", () => {
  const cases: Array<[string, string]> = [
    ["Product Specs", "product-specs"],
    ["  Q4 / Planning  ", "q4-planning"],
    ["Ünïcødé Nãmes", "n-c-d-n-mes"],
    ["...", ""],
    ["A".repeat(64), "a".repeat(32)],
  ];
  for (const [input, expected] of cases) {
    const slug = slugFromFolderName(input);
    assert.equal(slug, expected, `slug for ${JSON.stringify(input)}`);
    if (slug) assert.equal(mountNameError(slug), null, `slug ${JSON.stringify(slug)} must be storable`);
  }
});
