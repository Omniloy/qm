import { test } from "node:test";
import assert from "node:assert/strict";
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
  // Core reports an org skill as nobody's to edit, including the promoter's, so
  // this is the one action a row offers without being editable.
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
  // Core refuses this too — the menu only avoids offering a certain failure.
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
  // Sharing a skill back to yourself grants you what you already have.
  assert.deepEqual(forShare, ["channel:C1"]);
  // Moving it there is how you take one back out of a project.
  assert.deepEqual(forMove, ["personal:u1", "channel:C1"]);
});

test("promotion has a fixed destination, so it offers no picker", () => {
  assert.deepEqual(shareTargets(CONTEXTS, skill(), "promote"), []);
});

test("the request body maps each mode onto what /v1/share dispatches on", () => {
  assert.deepEqual(shareRequest("share", "channel:C1", "write"), { toScope: "channel:C1", permission: "write" });
  assert.deepEqual(shareRequest("move", "channel:C1", "write"), { toScope: "channel:C1", move: true });
  // Core turns "org" into the org scope itself, and promotion carries no
  // permission — the whole org gets it on core's terms, not the sharer's.
  assert.deepEqual(shareRequest("promote", "channel:C1", "write"), { toScope: "org" });
});

test("share says the copy is kept; move says it is not", () => {
  assert.match(shareImpact("share", skill(), "#ops"), /You keep it/);
  assert.match(shareImpact("move", skill(), "#ops"), /stops being available where it lives now/);
  assert.match(shareImpact("promote", skill(), "everyone in the organization"), /You keep your own copy/);
});

test("every mode names the skill in its heading and its confirmation", () => {
  for (const mode of ["share", "move", "promote"] as const) {
    assert.match(shareTitle(mode, "jira-triage"), /jira-triage/);
    assert.match(shareSuccessNotice(mode, "jira-triage", "#ops"), /jira-triage/);
  }
});

test("the undo copy says what is kept, so it is not mistaken for deletion", () => {
  assert.match(unshareImpact("jira-triage", "#ops"), /You keep the skill/);
  // Demoting archives the org copy; anyone who took their own keeps it.
  assert.match(demoteImpact("jira-triage"), /Anyone who kept their own copy still has it/);
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
  // "organisation" as a channel name must not read as the org scope.
  assert.equal(isOrgScoped(skill({ scope: "channel", scopeId: "channel:organisation" })), false);
});

test("a busy dialog says so on its confirm button whichever mode it is in", () => {
  for (const mode of ["share", "move", "promote"] as const) {
    assert.equal(shareConfirmLabel(mode, true), "Working…");
    assert.notEqual(shareConfirmLabel(mode, false), "Working…");
  }
});
