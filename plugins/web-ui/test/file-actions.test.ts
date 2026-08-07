import { test } from "node:test";
import assert from "node:assert/strict";
import { fileActions, type FileActionRow } from "../src/file-actions.ts";

const row = (over: Partial<FileActionRow> = {}): FileActionRow => ({
  id: "f1",
  name: "contract.pdf",
  createdBy: "ada@example.com",
  openable: true,
  ...over,
});

const byId = (r: FileActionRow, me: string, personal?: string | null) =>
  Object.fromEntries(fileActions(r, me, personal).map((a) => [a.id, a]));

test("only the uploader is offered a working delete", () => {
  // Core refuses it either way, but a button that always fails reads as a bug
  // rather than as a rule.
  assert.equal(byId(row(), "ada@example.com").delete?.disabled, false);
  const theirs = byId(row(), "sam@example.com").delete;
  assert.equal(theirs?.disabled, true);
  assert.ok(theirs?.reason, "a refused action has to say why");
});

test("delete is marked destructive so it renders apart", () => {
  assert.equal(byId(row(), "ada@example.com").delete?.danger, true);
});

test("a file with no stored bytes cannot be downloaded", () => {
  assert.equal(byId(row(), "ada@example.com").download?.disabled, false);
  const gone = byId(row({ openable: false }), "ada@example.com").download;
  assert.equal(gone?.disabled, true);
  assert.ok(gone?.reason);
});

test("an unknown uploader is treated as not-mine rather than mine", () => {
  // Older rows predate createdBy reaching the page. Defaulting to "mine"
  // would offer a delete that fails; defaulting to "theirs" merely withholds
  // an action, which is the safe direction for something irreversible.
  assert.equal(byId(row({ createdBy: undefined }), "ada@example.com").delete?.disabled, true);
});

const PERSONAL = "personal:ada@example.com";

test("taking a file back out of a project is only offered when it is in one", () => {
  const inProject = byId(row({ createdInScope: "project:sofia" }), "ada@example.com", PERSONAL);
  assert.ok(inProject.unshare, "a file in a project can be taken back out");

  const personal = byId(row({ createdInScope: PERSONAL }), "ada@example.com", PERSONAL);
  assert.equal(personal.unshare, undefined, "a file already in your own space has nowhere to go");
});

test("changing context is the owner's alone, like deleting", () => {
  assert.equal(byId(row(), "ada@example.com", PERSONAL).move?.disabled, false);
  const theirs = byId(row(), "sam@example.com", PERSONAL).move;
  assert.equal(theirs?.disabled, true);
  assert.ok(theirs?.reason);
});

test("without a known personal scope, no unshare entry is invented", () => {
  // The contexts list can still be loading. Offering a move whose destination
  // is unknown would produce a request with an empty scope.
  const actions = byId(row({ createdInScope: "project:sofia" }), "ada@example.com", null);
  assert.equal(actions.unshare, undefined);
});
