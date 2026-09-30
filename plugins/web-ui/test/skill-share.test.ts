import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  demoteImpact,
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
  return { id: "s1", name: "jira-triage", scope: "personal", scopeId: "personal:u1", editable: true, ...over };
}

const CONTEXTS: ShareScopeOption[] = [
  { scopeId: "personal:u1", name: "Personal — only you", kind: "personal" },
  { scopeId: "channel:C1", name: "#ops", kind: "channel" },
  { scopeId: "group:P1", name: "Launch plan", kind: "group" },
];

test("a skill you own offers sharing and its undo, promotion, moving and archiving", () => {
  const ids = skillShareActions(skill(), { isAdmin: true, archived: false }).map((a) => a.id);
  assert.deepEqual(ids, ["share", "unshare", "promote", "move", "archive"]);
});

test("an org-wide skill offers only taking it back, and only to an admin", () => {
  const org = skill({ scope: "org", scopeId: "org:omniloy", editable: false });
  assert.deepEqual(
    skillShareActions(org, { isAdmin: true, archived: false }).map((a) => a.id),
    ["demote"],
  );
  assert.deepEqual(skillShareActions(org, { isAdmin: false, archived: false }), []);
});

test("taking a skill back from the org is marked destructive", () => {
  const org = skill({ scope: "org", scopeId: "org:omniloy", editable: false });
  assert.equal(skillShareActions(org, { isAdmin: true, archived: false })[0]?.danger, true);
});

test("an already-archived org skill offers nothing — there is nothing left to take back", () => {
  const org = skill({ scope: "org", scopeId: "org:omniloy", editable: false });
  assert.deepEqual(skillShareActions(org, { isAdmin: true, archived: true }), []);
});

test("a skill you don't own offers no menu at all rather than an empty one", () => {
  assert.deepEqual(skillShareActions(skill({ editable: false }), { isAdmin: true, archived: false }), []);
  assert.deepEqual(skillShareActions(skill({ id: undefined }), { isAdmin: true, archived: false }), []);
});

test("only an admin can promote org-wide, and a non-admin is told why", () => {
  const promote = skillShareActions(skill(), { isAdmin: false, archived: false }).find((a) => a.id === "promote");
  assert.equal(promote?.disabled, true);
  assert.equal(promote?.reason, NOT_ADMIN_REASON);
  const asAdmin = skillShareActions(skill(), { isAdmin: true, archived: false }).find((a) => a.id === "promote");
  assert.equal(asAdmin?.disabled, false);
  assert.equal(asAdmin?.reason, undefined);
});

test("an archived skill can only be restored — never shared back into someone's chain", () => {
  const ids = skillShareActions(skill(), { isAdmin: true, archived: true }).map((a) => a.id);
  assert.deepEqual(ids, ["restore"]);
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

test("personal is a move destination but not a share one", () => {
  const forShare = shareTargets(CONTEXTS, skill({ scopeId: "group:P1" }), "share").map((t) => t.scopeId);
  const forMove = shareTargets(CONTEXTS, skill({ scopeId: "group:P1" }), "move").map((t) => t.scopeId);
  assert.deepEqual(forShare, ["channel:C1"]);
  assert.deepEqual(forMove, ["personal:u1", "channel:C1"]);
});

test("promotion has a fixed destination, so it offers no picker", () => {
  assert.deepEqual(shareTargets(CONTEXTS, skill(), "promote"), []);
});

test("the request body maps each mode onto what /v1/share dispatches on, and a share only ever grants use", () => {
  assert.deepEqual(shareRequest("share", "channel:C1"), { toScope: "channel:C1", permission: "read" });
  assert.deepEqual(shareRequest("move", "channel:C1"), { toScope: "channel:C1", move: true });
  assert.deepEqual(shareRequest("promote", "channel:C1"), { toScope: "org" });
});

test("share copy says a share is live — later edits reach them — and never promises re-sharing", () => {
  const share = shareImpact("share", skill(), "#ops");
  assert.match(share, /stays yours to edit/);
  assert.match(share, /always get your latest version/);
  assert.doesNotMatch(share, /not pushed|share again to update/);
});

test("move copy says it leaves its current home and that existing shares stop working", () => {
  const move = shareImpact("move", skill(), "#ops");
  assert.match(move, /stops being available where it lives now/);
  assert.match(move, /lose access/);
});

test("promote copy says the org gets a separate copy your edits don't reach, which only admins edit", () => {
  const promote = shareImpact("promote", skill(), "everyone in the organization");
  assert.match(promote, /gets a copy of \/jira-triage/);
  assert.match(promote, /edits to it don't reach the org copy/);
  assert.match(promote, /only org admins can edit/);
});

test("every mode names the skill in its heading and its confirmation", () => {
  for (const mode of ["share", "move", "promote"] as const) {
    assert.match(shareTitle(mode, "jira-triage"), /jira-triage/);
    assert.match(shareSuccessNotice(mode, "jira-triage", "#ops"), /jira-triage/);
  }
});

test("the undo copy says what is kept, so it is not mistaken for deletion", () => {
  assert.match(unshareImpact("jira-triage", "#ops"), /You keep the skill/);
  assert.match(demoteImpact("jira-triage"), /The org copy is archived; the skill it was shared from keeps working/);
});

test("an unshared skill explains what sharing would do rather than just saying none", () => {
  const empty = unshareEmptyState("jira-triage");
  assert.match(empty, /isn't shared with any context/);
  assert.match(empty, /without taking it out of yours/);
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

test("when the org lets everyone promote, a member can promote and take back their own org skill", () => {
  const promote = skillShareActions(skill(), { isAdmin: false, canPromote: true, archived: false }).find(
    (a) => a.id === "promote",
  );
  assert.equal(promote?.disabled, false);
  const own = skill({ scope: "org", scopeId: "org:omniloy", editable: false, createdByViewer: true });
  assert.deepEqual(
    skillShareActions(own, { isAdmin: false, canPromote: true, archived: false }).map((a) => a.id),
    ["demote"],
  );
  assert.deepEqual(skillShareActions(own, { isAdmin: false, canPromote: false, archived: false }), []);
  const others = skill({ scope: "org", scopeId: "org:omniloy", editable: false, createdByViewer: false });
  assert.deepEqual(skillShareActions(others, { isAdmin: false, canPromote: true, archived: false }), []);
});

test("the share dialog offers no edit permission, since write grants are not enforced", () => {
  const source = readFileSync(new URL("../src/skills.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Use and edit it|skill-share-permission|Can use and edit it/);
});
