import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_ADMIN_REASON,
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

test("a skill you own offers sharing, promotion, moving and archiving", () => {
  const ids = skillShareActions(skill(), { isAdmin: true, archived: false }).map((a) => a.id);
  assert.deepEqual(ids, ["share", "promote", "move", "archive"]);
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

test("a busy dialog says so on its confirm button whichever mode it is in", () => {
  for (const mode of ["share", "move", "promote"] as const) {
    assert.equal(shareConfirmLabel(mode, true), "Working…");
    assert.notEqual(shareConfirmLabel(mode, false), "Working…");
  }
});
