import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  conflictFrom,
  demoteImpact,
  nameConflictMessage,
  permissionLabel,
  transferImpact,
  demoteSuccessNotice,
  isOrgScoped,
  NOT_ADMIN_REASON,
  unshareEmptyState,
  unshareImpact,
  unshareSuccessNotice,
  shareConfirmLabel,
  shareImpact,
  shareRequest,
  shareSuccessNotice,
  shareTargets,
  shareTitle,
  skillShareActions,
  type ShareScopeOption,
  type SkillShareRow,
} from "../src/skill-share.ts";

function skill(over: Partial<SkillShareRow> = {}): SkillShareRow {
  return {
    id: "s1",
    name: "jira-triage",
    scope: "personal",
    scopeId: "personal:u1",
    editable: true,
    ownedByViewer: true,
    canManage: true,
    canMoveOrTransfer: true,
    ...over,
  };
}

const CONTEXTS: ShareScopeOption[] = [
  { scopeId: "personal:u1", name: "Personal — only you", kind: "personal" },
  { scopeId: "channel:C1", name: "#ops", kind: "channel" },
  { scopeId: "group:P1", name: "Launch plan", kind: "group" },
];

const ids = (row: SkillShareRow, opts: { isAdmin: boolean; canPromote?: boolean; archived?: boolean }) =>
  skillShareActions(row, { archived: false, ...opts }).map((a) => a.id);

test("the owner gets sharing, the org toggle, moving, transferring and archiving", () => {
  assert.deepEqual(ids(skill(), { isAdmin: true }), ["share", "unshare", "promote", "move", "transfer", "archive"]);
});

test("an org-wide skill offers stopping org-wide sharing instead of promoting it", () => {
  const actions = ids(skill({ orgWide: true }), { isAdmin: false });
  assert.ok(actions.includes("demote"));
  assert.ok(!actions.includes("promote"));
});

test("a home member who isn't the owner can share and archive, but not toggle org-wide, move or transfer", () => {
  const member = skill({ ownedByViewer: false, canMoveOrTransfer: false, scopeId: "channel:C1", scope: "channel" });
  assert.deepEqual(ids(member, { isAdmin: false }), ["share", "unshare", "archive"]);
});

test("a viewer with a grant, or a write grantee, gets no menu", () => {
  assert.deepEqual(
    ids(skill({ canManage: false, canMoveOrTransfer: false, ownedByViewer: false }), { isAdmin: true }),
    [],
  );
  assert.deepEqual(ids(skill({ id: undefined }), { isAdmin: true }), []);
});

test("a legacy org copy offers only taking it back, to an admin or to its owner when the org allows it", () => {
  const org = skill({ scope: "org", scopeId: "org:omniloy", editable: false, canManage: false });
  assert.deepEqual(ids(org, { isAdmin: true }), ["demote"]);
  assert.equal(skillShareActions(org, { isAdmin: true, archived: false })[0]?.danger, true);
  assert.deepEqual(ids(org, { isAdmin: false, canPromote: true }), ["demote"]);
  assert.deepEqual(ids(org, { isAdmin: false }), []);
  assert.deepEqual(ids({ ...org, ownedByViewer: false }, { isAdmin: false, canPromote: true }), []);
});

test("only an admin, or the owner when the org lets members, can make a skill available to everyone", () => {
  const promote = skillShareActions(skill(), { isAdmin: false, archived: false }).find((a) => a.id === "promote");
  assert.equal(promote?.disabled, true);
  assert.equal(promote?.reason, NOT_ADMIN_REASON);
  const member = skillShareActions(skill(), { isAdmin: false, canPromote: true, archived: false }).find(
    (a) => a.id === "promote",
  );
  assert.equal(member?.disabled, false);
  const asAdmin = skillShareActions(skill(), { isAdmin: true, archived: false }).find((a) => a.id === "promote");
  assert.equal(asAdmin?.disabled, false);
  assert.equal(asAdmin?.reason, undefined);
});

test("an archived skill can only be restored, and only by someone who manages it", () => {
  assert.deepEqual(ids(skill(), { isAdmin: true, archived: true }), ["restore"]);
  assert.deepEqual(ids(skill({ canManage: false }), { isAdmin: true, archived: true }), []);
});

test("archiving is the one destructive item and is marked as such", () => {
  const actions = skillShareActions(skill(), { isAdmin: true, archived: false });
  assert.deepEqual(
    actions.filter((a) => a.danger).map((a) => a.id),
    ["archive"],
  );
});

test("a skill's own home is never offered as a destination", () => {
  const targets = shareTargets(CONTEXTS, skill({ scopeId: "channel:C1" }), "share").map((t) => t.scopeId);
  assert.ok(!targets.includes("channel:C1"));
});

test("personal is a move destination only for the owner, and never a share one", () => {
  const forShare = shareTargets(CONTEXTS, skill({ scopeId: "group:P1" }), "share").map((t) => t.scopeId);
  const forMove = shareTargets(CONTEXTS, skill({ scopeId: "group:P1" }), "move").map((t) => t.scopeId);
  const forAdminMove = shareTargets(CONTEXTS, skill({ scopeId: "group:P1", ownedByViewer: false }), "move").map(
    (t) => t.scopeId,
  );
  assert.deepEqual(forShare, ["channel:C1"]);
  assert.deepEqual(forMove, ["personal:u1", "channel:C1"]);
  assert.deepEqual(forAdminMove, ["channel:C1"]);
});

test("promotion has a fixed destination, so it offers no picker", () => {
  assert.deepEqual(shareTargets(CONTEXTS, skill(), "promote"), []);
});

test("the request body maps each mode onto what /v1/share dispatches on, and a share carries its access", () => {
  assert.deepEqual(shareRequest("share", "channel:C1"), { toScope: "channel:C1", permission: "read" });
  assert.deepEqual(shareRequest("share", "channel:C1", "write"), { toScope: "channel:C1", permission: "write" });
  assert.deepEqual(shareRequest("move", "channel:C1"), { toScope: "channel:C1", move: true });
  assert.deepEqual(shareRequest("promote", "channel:C1"), { toScope: "org" });
});

test("share copy says edits reach them, and a write share says they can edit too", () => {
  const share = shareImpact("share", skill(), "#ops");
  assert.equal(share, "#ops can use /jira-triage. Edits you make reach them automatically.");
  assert.match(shareImpact("share", skill(), "#ops", "write"), /can also edit the instructions/);
});

test("move copy says grants move with it and the current home loses access", () => {
  const move = shareImpact("move", skill(), "#ops");
  assert.match(move, /moves to #ops/);
  assert.match(move, /Grants move with it/);
  assert.match(move, /lose access unless it's shared with them/);
});

test("org-wide copy says it stays one skill whose edits reach everyone", () => {
  const promote = shareImpact("promote", skill(), "everyone in the organization");
  assert.match(promote, /Everyone in the organization can use \/jira-triage/);
  assert.match(promote, /It stays one skill/);
  assert.doesNotMatch(promote, /copy/);
});

test("every mode names the skill in its heading and its confirmation", () => {
  for (const mode of ["share", "move", "promote"] as const) {
    assert.match(shareTitle(mode, "jira-triage"), /jira-triage/);
    assert.match(shareSuccessNotice(mode, "jira-triage", "#ops"), /jira-triage/);
  }
});

test("the undo copy says what is kept, so it is not mistaken for deletion", () => {
  assert.match(unshareImpact("jira-triage", "#ops"), /It stays in its home/);
  assert.match(
    demoteImpact("jira-triage"),
    /stops being available org-wide. It stays in its home and its other shares/,
  );
  assert.match(demoteImpact("jira-triage", true), /This org copy is archived/);
});

test("an unshared skill explains what sharing would do rather than just saying none", () => {
  const empty = unshareEmptyState("jira-triage");
  assert.match(empty, /isn't shared with any context/);
  assert.match(empty, /without taking it out of its home/);
});

test("every undo notice names the skill, and unsharing names the context too", () => {
  assert.match(unshareSuccessNotice("jira-triage", "#ops"), /jira-triage/);
  assert.match(unshareSuccessNotice("jira-triage", "#ops"), /#ops/);
  assert.match(demoteSuccessNotice("jira-triage"), /jira-triage/);
});

test("org detection reads either the scope word or the scope id", () => {
  assert.equal(isOrgScoped(skill({ scope: "org", scopeId: undefined })), true);
  assert.equal(isOrgScoped(skill({ scope: "personal", scopeId: "org:omniloy" })), true);
  assert.equal(isOrgScoped(skill()), false);
  assert.equal(isOrgScoped(skill({ scope: "channel", scopeId: "channel:organisation" })), false);
});

test("a busy dialog says so on its confirm button whichever mode it is in", () => {
  for (const mode of ["share", "move", "promote"] as const) {
    assert.equal(shareConfirmLabel(mode, true), "Working…");
    assert.notEqual(shareConfirmLabel(mode, false), "Working…");
  }
});

test("the share dialog offers a write option now that write grants are honored", () => {
  const source = readFileSync(new URL("../src/skills.ts", import.meta.url), "utf8");
  assert.match(source, /Use and edit it/);
  assert.equal(permissionLabel("write"), "Can use and edit it");
  assert.equal(permissionLabel("read"), "Can use it");
});

test("a name clash names the other skill's owner and home and suggests renaming or merging", () => {
  const conflict = conflictFrom({ conflict: { id: "x", name: "jira-triage", home: "org:omniloy", owner: "Noé" } });
  assert.ok(conflict);
  assert.equal(
    nameConflictMessage("jira-triage", "everyone in the organization", conflict),
    "Everyone already sees a different /jira-triage (owner Noé, home org:omniloy). Rename yours, or ask an admin to merge.",
  );
  assert.equal(conflictFrom({ error: "forbidden" }), null);
});

test("transfer copy says what the new owner can do and where a personal skill will live", () => {
  const personal = transferImpact("jira-triage", "Ana", true, "Ana's personal skills");
  assert.match(personal, /Ana becomes the owner of \/jira-triage and can edit, share, move or transfer it/);
  assert.match(personal, /It will live in Ana's personal skills/);
  assert.doesNotMatch(transferImpact("jira-triage", "Ana", false, "#ops"), /It will live/);
});
