import { test } from "node:test";
import assert from "node:assert/strict";
import {
  grantBlockedReason,
  grantConfirmLabel,
  grantImpact,
  grantRequest,
  grantSuccessNotice,
  grantTargets,
  type ExistingGrant,
  type GrantScopeOption,
} from "../src/keychain-grant.ts";

const PERSONAL = "personal:u1";

const CONTEXTS: GrantScopeOption[] = [
  { scopeId: "channel:C1", name: "#ops", kind: "channel" },
  { scopeId: "group:P1", name: "Partnerships", kind: "group" },
];

function grant(over: Partial<ExistingGrant> = {}): ExistingGrant {
  return { credentialId: "c1", audienceScopeId: "channel:C1", status: "active", ...over };
}

test("a context that already holds an active grant is not offered again", () => {
  const targets = grantTargets(CONTEXTS, "c1", [grant()], PERSONAL).map((t) => t.scopeId);
  assert.deepEqual(targets, ["group:P1"]);
});

test("a revoked or expired grant frees the context up again", () => {
  const revoked = grantTargets(CONTEXTS, "c1", [grant({ status: "revoked" })], PERSONAL).map((t) => t.scopeId);
  assert.deepEqual(revoked, ["channel:C1", "group:P1"]);
  const lapsed = grantTargets(CONTEXTS, "c1", [grant({ expiresAt: 500 })], PERSONAL, 1000).map((t) => t.scopeId);
  assert.deepEqual(lapsed, ["channel:C1", "group:P1"]);
});

test("a grant on a different credential does not block this one", () => {
  const targets = grantTargets(CONTEXTS, "c2", [grant({ credentialId: "c1" })], PERSONAL).map((t) => t.scopeId);
  assert.deepEqual(targets, ["channel:C1", "group:P1"]);
});

test("your own personal scope is never a destination", () => {
  const withPersonal = [...CONTEXTS, { scopeId: PERSONAL, name: "You", kind: "personal" as const }];
  const targets = grantTargets(withPersonal, "c1", [], PERSONAL).map((t) => t.scopeId);
  // Lending a credential to your own chats is what owning it already means.
  assert.ok(!targets.includes(PERSONAL));
});

test("an expired credential is refused before a grant is ever recorded", () => {
  const reason = grantBlockedReason({ id: "c1", service: "stripe", expiresAt: 500 }, CONTEXTS, 1000);
  assert.match(reason ?? "", /expired/);
});

test("an expiry on a file credential is not treated as staleness", () => {
  // A file has no notion of expiry the way a token does; the field means
  // something else there.
  const reason = grantBlockedReason({ id: "c1", service: "cert", kind: "file", expiresAt: 500 }, CONTEXTS, 1000);
  assert.equal(reason, null);
});

test("with nowhere left to lend it, the action says so instead of opening an empty picker", () => {
  const reason = grantBlockedReason({ id: "c1", service: "stripe" }, [], 1000);
  assert.match(reason ?? "", /already has this one/);
});

test("a healthy credential with somewhere to go is not blocked", () => {
  assert.equal(grantBlockedReason({ id: "c1", service: "stripe" }, CONTEXTS), null);
});

test("standing access says it lasts; one-time says it does not", () => {
  const c = { id: "c1", service: "Stripe" };
  assert.match(grantImpact("standing", c, "#ops"), /from now on/);
  assert.match(grantImpact("once", c, "#ops"), /once/);
  // Both must say the secret stays server-side — it is the thing people worry
  // about, and it is true of every grant.
  for (const mode of ["standing", "once"] as const) {
    assert.match(grantImpact(mode, c, "#ops"), /never leaves the server/);
    assert.match(grantImpact(mode, c, "#ops"), /audited/);
  }
});

test("an unwritten purpose still records where the grant came from", () => {
  assert.equal(grantRequest("c1", "channel:C1", "standing", "   ").purpose, "Given from the keychain page");
  assert.equal(grantRequest("c1", "channel:C1", "standing", " for expenses ").purpose, "for expenses");
});

test("the request names the audience explicitly rather than leaning on the capability", () => {
  const body = grantRequest("c1", "group:P1", "once", "x");
  assert.equal(body.audienceScopeId, "group:P1");
  assert.equal(body.credential, "c1");
  assert.equal(body.mode, "once");
});

test("a busy dialog says so, and each mode has its own verb otherwise", () => {
  assert.equal(grantConfirmLabel("standing", true), "Working…");
  assert.equal(grantConfirmLabel("once", true), "Working…");
  assert.notEqual(grantConfirmLabel("standing", false), grantConfirmLabel("once", false));
});

test("the confirmation names the credential and where it went", () => {
  for (const mode of ["standing", "once"] as const) {
    const notice = grantSuccessNotice(mode, "Stripe", "#ops");
    assert.match(notice, /Stripe/);
    assert.match(notice, /#ops/);
  }
});
