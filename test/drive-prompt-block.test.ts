import assert from "node:assert/strict";
import test from "node:test";
import { attachedFoldersSection, attachedFoldersUnavailableNote } from "../src/mounts/prompt-block.ts";
import type { MountListing } from "../src/mounts/prompt-block.ts";
import type { DriveMount } from "../src/mounts/mount-store.ts";
import type { DriveEntry, Listing } from "../src/mounts/drive-listing.ts";

const NOW = 1_700_000_000_000;

const mount = (over: Partial<DriveMount> = {}): DriveMount => ({
  id: "m1",
  scopeId: "project:acme",
  provider: "google",
  externalId: "folder-1",
  name: "specs",
  mode: "rw",
  createdBy: "ada@example.com",
  createdAt: NOW,
  updatedAt: NOW,
  enabled: true,
  ...over,
});

const entry = (name: string, dir = "", mimeType = "text/plain"): DriveEntry => ({
  id: `id-${dir}-${name}`,
  name,
  mimeType,
  dir,
});

const listing = (entries: DriveEntry[], over: Partial<Listing> = {}): Listing => ({
  entries,
  truncated: false,
  calls: 1,
  ...over,
});

const one = (over: Partial<MountListing> = {}): MountListing => ({
  mount: mount(),
  listing: listing([entry("roadmap.md"), entry("budget.csv", "Q4")]),
  listedAt: NOW,
  ...over,
});

test("no mounts renders nothing at all", () => {
  assert.equal(attachedFoldersSection([], NOW), "");
});

test("files are listed by path under the mount, not by Drive id", () => {
  const out = attachedFoldersSection([one()], NOW);
  assert.match(out, /^## Attached folders$/m);
  assert.match(out, /^### specs$/m);
  assert.match(out, /^- roadmap\.md$/m);
  assert.match(out, /^- Q4\/budget\.csv$/m);
  assert.doesNotMatch(out, /id-/, "internal Drive ids must not leak into the prompt");
});

test("the block says it is a snapshot and tells the agent to re-list", () => {
  const out = attachedFoldersSection([one()], NOW);
  assert.match(out, /point-in-time snapshot/i);
  assert.match(out, /list the folder again before concluding it is not there/i);
});

test("the listing age is stated, and moves with the clock", () => {
  assert.match(attachedFoldersSection([one()], NOW), /listed just now/);
  assert.match(attachedFoldersSection([one()], NOW + 60_000), /listed 1 minute ago/);
  assert.match(attachedFoldersSection([one()], NOW + 7 * 60_000), /listed 7 minutes ago/);
});

test("a truncated listing is marked, with the reason and what to do instead", () => {
  const out = attachedFoldersSection(
    [one({ listing: listing([entry("a.txt")], { truncated: true, truncatedReason: "depth" }) })],
    NOW,
  );
  assert.match(out, /INCOMPLETE/);
  assert.match(out, /only the top levels are listed/);
  assert.match(out, /Search the folder rather than assuming a file is missing/i);
});

test("every truncation reason produces a distinct explanation", () => {
  const reasons = ["depth", "entries", "calls", "incomplete-search"] as const;
  const notes = reasons.map((r) => {
    const out = attachedFoldersSection(
      [one({ listing: listing([entry("a.txt")], { truncated: true, truncatedReason: r }) })],
      NOW,
    );
    return /INCOMPLETE — (.*?)\. Search/.exec(out)?.[1];
  });
  assert.equal(new Set(notes).size, reasons.length, "each reason needs its own wording");
  assert.ok(notes.every(Boolean));
});

test("an untruncated listing carries no incomplete marker", () => {
  assert.doesNotMatch(attachedFoldersSection([one()], NOW), /INCOMPLETE/);
});

test("native Google files are flagged as edit-in-place", () => {
  const out = attachedFoldersSection(
    [
      one({
        listing: listing([
          entry("Launch Plan", "", "application/vnd.google-apps.document"),
          entry("notes.md", "", "text/markdown"),
        ]),
      }),
    ],
    NOW,
  );
  assert.match(out, /- Launch Plan \[Google file — edit in place, do not download and replace\]/);
  assert.match(out, /^- notes\.md$/m, "non-native files carry no marker");
});

test("read-only mounts say so in the heading", () => {
  const out = attachedFoldersSection([one({ mount: mount({ mode: "ro" }) })], NOW);
  assert.match(out, /^### specs \(read-only\)$/m);
});

test("an empty folder is distinguished from an inaccessible one", () => {
  const out = attachedFoldersSection([one({ listing: listing([]) })], NOW);
  assert.match(out, /\(empty, or nothing you have access to\)/);
});

test("several mounts each get their own section", () => {
  const out = attachedFoldersSection(
    [
      one(),
      one({
        mount: mount({ id: "m2", name: "research", displayPath: "Shared drives/Research" }),
        listing: listing([entry("interview.md")]),
      }),
    ],
    NOW,
  );
  assert.match(out, /^### specs$/m);
  assert.match(out, /^### research$/m);
  assert.match(out, /Drive location: Shared drives\/Research/);
  assert.equal(out.match(/^## Attached folders$/gm)?.length, 1, "one heading for the whole block");
});

test("the block states the agent acts as itself, inside these folders only", () => {
  const out = attachedFoldersSection([one()], NOW);
  assert.match(out, /as yourself/i);
  assert.match(out, /only inside these folders/i);
});

test("unavailable notes explain why there are no folders, and what to do", () => {
  const notConnected = attachedFoldersUnavailableNote("not-connected");
  assert.match(notConnected, /not connected/i);
  assert.match(notConnected, /connect Google Workspace/i);

  const noAccess = attachedFoldersUnavailableNote("no-access");
  assert.match(noAccess, /cannot open them/i);
  assert.match(noAccess, /access granted in Drive/i);

  assert.notEqual(notConnected, noAccess);
});
