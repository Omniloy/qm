import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlService } from "../src/api/control-service.ts";
import { AdminError } from "../src/admin/admin-service.ts";
import type { App } from "../src/api/app.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import type { Grant, ScopeId } from "../src/types.ts";
import { parseScopeId, scopeId } from "../src/types.ts";
import type { ArtifactHome, ArtifactType } from "../src/api/artifact-share.ts";
import type { RecipientResolution } from "../src/directory/directory-store.ts";
import { shareArtifact as shareRoute, demoteSkill, listSkillSharing, unshareSkill } from "../src/api/routes/surface.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { splitToScope, UNATTESTED_TURN_CAUSE } from "../src/api/artifact-share.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { ManagesArtifactHome } from "../src/resolution/scope-membership.ts";
import {
  ADMIN,
  grantsOf as skillGrants,
  ORG_SCOPE as OWNER_ORG,
  ownerFixture,
  publishSkill,
} from "./support/skill-owner-fixture.ts";

const ORG = "default-org";

interface FakeState {
  artifacts: Record<string, ArtifactHome & { type: ArtifactType }>;
  scopesByPrincipal: Record<string, ScopeId[]>;
  moves: Array<{ type: ArtifactType; id: string; toScope: ScopeId; movedBy: string }>;
  promotes: Array<{ id: string; targetScopeId: ScopeId; actorId: string }>;
  demotes: Array<{ id: string; actorId: string }>;
  admins: Set<string>;
  recipients: Record<string, RecipientResolution>;
  privateChannels: Set<string>;
  acl: ReturnType<typeof createAclStore>;
}

function fakeManages(state: FakeState): ManagesArtifactHome {
  return async (homeScopeId, createdBy, principalId) => {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(homeScopeId);
    const memberManaged = kind === "group" || (kind === "channel" && state.privateChannels.has(ref));
    if (memberManaged && (state.scopesByPrincipal[principalId] ?? []).includes(homeScopeId)) return true;
    if (createdBy !== principalId) return false;
    if (kind === "personal") return ref === principalId;
    if (kind === "channel") return !state.privateChannels.has(ref);
    return false;
  };
}

function authorOfGrant(state: FakeState, ownerScopeId: ScopeId, ref: string): string | undefined {
  const { kind } = parseScopeId(ownerScopeId);
  if (kind !== "channel" && kind !== "group") return undefined;
  return Object.values(state.artifacts).find((a) => a.ownerScopeId === ownerScopeId && a.grantRef === ref)?.createdBy;
}

function fakeApp(state: FakeState): App {
  return {
    async getArtifactHome(type: ArtifactType, idOrName: string) {
      return state.artifacts[`${type}:${idOrName}`] ?? null;
    },
    async belongsToScope(principalId: string, scope: ScopeId) {
      if (parseScopeId(scope).kind === "org") return true;
      if (scope === scopeId("personal", principalId)) return true;
      const mine = state.scopesByPrincipal[principalId] ?? [scopeId("personal", principalId), scopeId("org", ORG)];
      return mine.includes(scope);
    },
    canManageArtifactHome(homeScopeId: ScopeId, createdBy: string, principalId: string) {
      return fakeManages(state)(homeScopeId, createdBy, principalId);
    },
    async getSkill(id: string) {
      const home = state.artifacts[`skill:${id}`];
      return home ? { id, scopeId: home.ownerScopeId } : null;
    },
    async canManageSkill(id: string, principalId: string) {
      const home = state.artifacts[`skill:${id}`];
      return !!home && fakeManages(state)(home.ownerScopeId, home.createdBy, principalId);
    },
    async unshareSkill({ id, scope, actorId }: { id: string; scope: ScopeId; actorId: string }) {
      const home = state.artifacts[`skill:${id}`];
      if (!home) return { ok: false, code: "not_found", message: "no such skill" };
      if (!(await fakeManages(state)(home.ownerScopeId, home.createdBy, actorId)))
        return { ok: false, code: "forbidden", message: "that skill isn't yours to share or unshare" };
      await state.acl.revoke(
        home.ownerScopeId,
        home.grantRef,
        scope,
        actorId,
        authorOfGrant(state, home.ownerScopeId, home.grantRef),
      );
      return { ok: true, skill: {} };
    },
    async grant(g: Grant) {
      await state.acl.grant(g, authorOfGrant(state, g.ownerScopeId, g.ref));
    },
    async revokeGrant(ownerScopeId: ScopeId, ref: string, granteeScopeId: ScopeId, revokedBy: string) {
      await state.acl.revoke(ownerScopeId, ref, granteeScopeId, revokedBy, authorOfGrant(state, ownerScopeId, ref));
    },
    async moveArtifactHome(type: ArtifactType, id: string, toScope: ScopeId, movedBy: string) {
      if (type !== "skill" && type !== "deploy")
        throw new Error(`moving a ${type}'s home isn't supported — share it instead (add a grant)`);
      state.moves.push({ type, id, toScope, movedBy });
    },
    async skillSharingAllows() {
      return true;
    },
    async promoteSkill(id: string, targetScopeId: ScopeId, actorId: string, liveActor: boolean) {
      if (liveActor !== true)
        throw new AdminError(
          403,
          `promoting a skill org-wide takes a live person the platform can attest is present — ${UNATTESTED_TURN_CAUSE}`,
        );
      if (!state.admins.has(actorId)) throw new AdminError(403, "only an org admin can promote a skill org-wide");
      state.promotes.push({ id, targetScopeId, actorId });
      return { id: `org-${id}` } as never;
    },
    async demoteSkill(id: string, actorId: string, liveActor: boolean) {
      if (liveActor !== true)
        throw new AdminError(
          403,
          `taking a skill back from the org takes a live person the platform can attest is present — ${UNATTESTED_TURN_CAUSE}`,
        );
      if (!state.admins.has(actorId)) throw new AdminError(403, "only an org admin can take a skill back from the org");
      state.demotes.push({ id, actorId });
    },
    async listSkillGrants(id: string) {
      const home = state.artifacts[`skill:${id}`];
      if (!home) return [];
      return (await state.acl.grantsFor(home.ownerScopeId, home.grantRef)).map((g) => ({
        granteeScopeId: g.granteeScopeId,
        permission: g.permission,
      }));
    },
    async resolveRecipient(query: string) {
      return state.recipients[query.toLowerCase()] ?? { kind: "none" };
    },
  } as unknown as App;
}

const cap = (actorId: string, scope?: ScopeId, liveActor = true): CapabilityClaims =>
  ({
    actorId,
    scopeId: scope ?? scopeId("personal", actorId),
    exp: 9_999_999_999,
    ...(liveActor ? { liveActor: true } : {}),
  }) as CapabilityClaims;

function baseState(over: Partial<FakeState> = {}): FakeState {
  const state: FakeState = {
    artifacts: {},
    scopesByPrincipal: {},
    moves: [],
    promotes: [],
    demotes: [],
    admins: new Set(),
    recipients: {},
    privateChannels: new Set(),
    acl: createAclStore(undefined, { manages: (p, s, a) => manages(s, a ?? "", p) }),
    ...over,
  };
  const manages = fakeManages(state);
  return state;
}

async function grantsOf(state: FakeState): Promise<Grant[]> {
  return [...(await state.acl.list())];
}

function ownerState(): FakeState {
  const home = (type: ArtifactType, id: string): ArtifactHome & { type: ArtifactType } => ({
    type,
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    grantRef: type === "file" ? `artifacts/${id}/doc.md` : `${type === "deploy" ? "deployment" : type}:${id}`,
  });
  return baseState({
    artifacts: {
      "file:F1": home("file", "F1"),
      "skill:S1": home("skill", "S1"),
      "deploy:D1": home("deploy", "D1"),
      "cron:K1": home("cron", "K1"),
    },
    scopesByPrincipal: {
      U1: [scopeId("personal", "U1"), scopeId("org", ORG), scopeId("channel", "C1")],
      U2: [scopeId("personal", "U2"), scopeId("org", ORG)],
    },
    recipients: { carol: { kind: "one", member: { principalId: "U-carol", displayName: "Carol", type: "internal" } } },
  });
}

test("share adds a grant for every generic artifact type — one verb, one store, uniform across file/deploy/cron", async () => {
  for (const type of ["file", "deploy", "cron"] as const) {
    const state = ownerState();
    const svc = createControlService(fakeApp(state));
    const id = { file: "F1", skill: "S1", deploy: "D1", cron: "K1" }[type];
    const r = await svc.shareArtifact({ type, id, scope: scopeId("channel", "C1") }, cap("U1"));
    assert.ok(r.ok, `${type}: ${JSON.stringify(r)}`);
    assert.equal(r.verb, "share");
    const grants = await grantsOf(state);
    assert.equal(grants.length, 1, `${type}: exactly one grant`);
    const g = grants[0]!;
    assert.equal(g.ownerScopeId, scopeId("personal", "U1"), `${type}: home scope unchanged`);
    assert.equal(g.granteeScopeId, scopeId("channel", "C1"));
    assert.equal(g.grantedBy, "U1");
    assert.equal(g.permission, "read");
    const expectedPath =
      type === "file" ? `artifacts/${id}/doc.md` : `${type === "deploy" ? "deployment" : type}:${id}`;
    assert.equal(g.ref, expectedPath, `${type}: keyed on the consumer's path`);
  }
});

test("share resolves a teammate by name → a frictionless person grant (the person-follows model, §3)", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", recipient: "carol" }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.target.scope, scopeId("personal", "U-carol"));
  assert.equal(r.target.label, "Carol");
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("personal", "U-carol"));
});

test("share into a scope you belong to is frictionless; permission:write is honored", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "deploy", id: "D1", scope: scopeId("channel", "C1"), permission: "write" },
    cap("U1"),
  );
  assert.ok(r.ok);
  assert.equal(r.permission, "write");
  assert.equal((await grantsOf(state))[0]!.permission, "write");
});

test("moving a DEPLOY to a teammate's personal scope is an ownership transfer — allowed for a live actor", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "deploy", id: "D1", recipient: "carol", move: true }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "deploy", id: "D1", toScope: scopeId("personal", "U-carol"), movedBy: "U1" }]);
  assert.equal((await grantsOf(state)).length, 0, "a move adds no grant at this layer");
});

test("a deploy ownership transfer to a person takes a LIVE actor — an autonomous trigger is refused", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "deploy", id: "D1", recipient: "carol", move: true },
    cap("U1", undefined, false),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal(state.moves.length, 0);
});

test("moving a deploy into a channel you belong to re-homes it there (group ownership)", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "deploy", id: "D1", scope: scopeId("channel", "C1"), move: true },
    cap("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "deploy", id: "D1", toScope: scopeId("channel", "C1"), movedBy: "U1" }]);
});

test("move is refused for a type whose home isn't movable (file) — directed to share", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("channel", "C1"), move: true }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "share_failed");
    assert.match(r.message, /isn't supported/);
  }
});

test("a non-member can't share into a scope they're not in (forbidden)", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("channel", "C9") }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal((await grantsOf(state)).length, 0);
});

test("only the owner may share a personal-homed artifact — a non-creator is forbidden (no transitive re-share)", async () => {
  const state = ownerState();
  state.scopesByPrincipal["U2"] = [scopeId("personal", "U2"), scopeId("org", ORG), scopeId("channel", "C1")];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("channel", "C1") }, cap("U2"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
});

test("a member of a shared home (private channel/group) can share it even if they didn't create it (PR2 manage parity)", async () => {
  const state = ownerState();
  state.privateChannels.add("C1");
  state.artifacts["cron:CS"] = {
    type: "cron",
    id: "CS",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "cron:CS",
  };
  state.scopesByPrincipal["U2"] = [
    scopeId("personal", "U2"),
    scopeId("org", ORG),
    scopeId("channel", "C1"),
    scopeId("group", "G9"),
  ];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "cron", id: "CS", scope: scopeId("group", "G9") },
    cap("U2", scopeId("channel", "C1")),
  );
  assert.ok(r.ok, JSON.stringify(r));
  const grants = await grantsOf(state);
  assert.equal(grants[0]!.granteeScopeId, scopeId("group", "G9"));
  assert.equal(grants[0]!.grantedBy, "U2", "the sharing member is recorded, not the creator");
});

test("an author who LEFT a private channel can no longer share its artifact (membership, not authorship)", async () => {
  const state = ownerState();
  state.privateChannels.add("C1");
  state.artifacts["cron:CS"] = {
    type: "cron",
    id: "CS",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "cron:CS",
  };
  state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG)];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "cron", id: "CS", scope: "org" }, cap("U1"));
  assert.equal(r.ok, false, "the ex-member author must not pass the manage check on a private channel");
  if (!r.ok) assert.equal(r.code, "forbidden");
  state.artifacts["deploy:PD"] = {
    type: "deploy",
    id: "PD",
    ownerScopeId: scopeId("channel", "C2"),
    createdBy: "U1",
    grantRef: "deployment:PD",
  };
  const pub = await svc.shareArtifact({ type: "deploy", id: "PD", scope: "org" }, cap("U1"));
  assert.ok(pub.ok, "a public-channel author still manages via the owner door");
});

test("a PUBLIC-channel artifact's author can share it end to end — both authz gates agree (#986 regression)", async () => {
  const state = ownerState();
  state.artifacts["cron:PK"] = {
    type: "cron",
    id: "PK",
    ownerScopeId: scopeId("channel", "C2"),
    createdBy: "U1",
    grantRef: "cron:PK",
  };
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "cron", id: "PK", scope: "org" }, cap("U1"));
  assert.ok(r.ok, `a public-channel author must share their own cron end to end: ${JSON.stringify(r)}`);
  const g = (await grantsOf(state)).find((x) => x.ref === "cron:PK");
  assert.ok(g, "the grant is actually persisted through the real acl guard");
  assert.equal(g!.granteeScopeId, scopeId("org", ORG));
  assert.equal(g!.grantedBy, "U1");
});

test("a non-owner non-member CANNOT share a PUBLIC-channel artifact — the author door is author-only", async () => {
  const state = ownerState();
  state.artifacts["cron:PK"] = {
    type: "cron",
    id: "PK",
    ownerScopeId: scopeId("channel", "C2"),
    createdBy: "U1",
    grantRef: "cron:PK",
  };
  state.scopesByPrincipal["U2"] = [scopeId("personal", "U2"), scopeId("org", ORG), scopeId("channel", "C2")];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "cron", id: "PK", scope: "org" }, cap("U2"));
  assert.equal(r.ok, false, "a non-author public-channel member must not share it");
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal(
    (await grantsOf(state)).find((x) => x.ref === "cron:PK"),
    undefined,
    "no grant is persisted",
  );
});

test("a non-member of a shared home cannot share it (membership-gated, not just creator-gated)", async () => {
  const state = ownerState();
  state.artifacts["cron:CS"] = {
    type: "cron",
    id: "CS",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "cron:CS",
  };
  state.scopesByPrincipal["U3"] = [scopeId("personal", "U3"), scopeId("org", ORG)];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "cron", id: "CS", scope: "org" }, cap("U3"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
});

test("an unknown artifact is a not_found; a bad scope id is a bad_request; an unknown teammate is recipient_not_found", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const missing = await svc.shareArtifact({ type: "file", id: "ghost", scope: "org" }, cap("U1"));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "not_found");

  const badScope = await svc.shareArtifact({ type: "file", id: "F1", scope: "not-a-scope" }, cap("U1"));
  assert.equal(badScope.ok, false);
  if (!badScope.ok) assert.equal(badScope.code, "bad_request");

  const noOne = await svc.shareArtifact({ type: "file", id: "F1", recipient: "nobody" }, cap("U1"));
  assert.equal(noOne.ok, false);
  if (!noOne.ok) assert.equal(noOne.code, "recipient_not_found");
});

test("sharing a non-skill to the org is a plain visibility grant (org is everyone's floor — no review)", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "deploy", id: "D1", scope: "org" }, cap("U1"));
  assert.ok(r.ok);
  assert.equal(r.target.scope, scopeId("org", ORG));
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("org", ORG));
});

test("sharing into a TEAM the actor belongs to is frictionless (team is a my_scopes context, §3)", async () => {
  const state = ownerState();
  state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG), scopeId("team", "T1")];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("team", "T1") }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("team", "T1"));
});

test("sharing into a team the actor is NOT on is forbidden", async () => {
  const state = ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("team", "T9") }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
});

test("a move records the acting principal in the audit, not the artifact's creator", async () => {
  const state = ownerState();
  state.privateChannels.add("C1");
  state.artifacts["deploy:CM"] = {
    type: "deploy",
    id: "CM",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "deployment:CM",
  };
  state.scopesByPrincipal["U2"] = [
    scopeId("personal", "U2"),
    scopeId("org", ORG),
    scopeId("channel", "C1"),
    scopeId("group", "G9"),
  ];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "deploy", id: "CM", scope: scopeId("group", "G9"), move: true },
    cap("U2", scopeId("channel", "C1")),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(state.moves[0]!.movedBy, "U2", "the mover is recorded, not the creator U1");
});

function callShareRoute(state: FakeState, capability: CapabilityClaims | null, body: unknown) {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = { res, deps: { control: createControlService(fakeApp(state)) }, body, capability } as unknown as ApiCtx;
  return shareRoute(ctx).then(() => out);
}

test("POST /v1/share: a single toScope (scope id) → 200 grant; a name → directory-resolved", async () => {
  const byScope = await callShareRoute(ownerState(), cap("U1"), {
    type: "file",
    id: "F1",
    toScope: scopeId("channel", "C1"),
  });
  assert.equal(byScope.status, 200);
  assert.equal(byScope.body.verb, "share");
  assert.equal(byScope.body.target.scope, scopeId("channel", "C1"));

  const byName = await callShareRoute(ownerState(), cap("U1"), { type: "file", id: "F1", toScope: "carol" });
  assert.equal(byName.status, 200);
  assert.equal(byName.body.target.label, "Carol");
});

test("POST /v1/share: no capability → 403; bad type/missing fields → 400", async () => {
  const state = ownerState();
  assert.equal((await callShareRoute(state, null, { type: "file", id: "F1", toScope: "org" })).status, 403);
  assert.equal((await callShareRoute(state, cap("U1"), { type: "bogus", id: "F1", toScope: "org" })).status, 400);
  assert.equal((await callShareRoute(state, cap("U1"), { type: "file", toScope: "org" })).status, 400);
  assert.equal((await callShareRoute(state, cap("U1"), { type: "file", id: "F1" })).status, 400);
});

test("splitToScope: tool and route classify identically — a real scope id vs a name (incl. a colon name)", () => {
  assert.deepEqual(splitToScope("org"), { scope: "org" });
  assert.deepEqual(splitToScope("channel:C1"), { scope: "channel:C1" });
  assert.deepEqual(splitToScope("personal:U7"), { scope: "personal:U7" });
  assert.deepEqual(
    splitToScope("not:valid"),
    { recipient: "not:valid" },
    "an invalid kind: prefix is a name, not a scope",
  );
  assert.deepEqual(splitToScope("Carol"), { recipient: "Carol" });
  assert.deepEqual(splitToScope("  Ann Lee  "), { recipient: "Ann Lee" }, "trimmed");
});

test("SkillStore.move changes the home scope in place; org move is refused (use promote)", async () => {
  const store = createSkillStore();
  const created = await store.create({
    scopeId: scopeId("personal", "U1"),
    manifest: { name: "tidy", description: "d", requiredCapabilities: [], body: "b" },
    createdBy: "U1",
  });
  const moved = await store.move(created.id, scopeId("channel", "C1"));
  assert.equal(moved.id, created.id, "same record id");
  assert.equal(moved.version, created.version, "version unchanged by a move");
  assert.equal(moved.createdBy, "U1", "creator is immutable");
  assert.equal(moved.scopeId, scopeId("channel", "C1"), "home scope changed");
  await assert.rejects(() => store.move(created.id, scopeId("org", ORG)), /admin-gated/);
});

test("SkillStore.promote supersedes an existing same-name org record instead of duplicating it", async () => {
  const store = createSkillStore();
  const src = await store.create({
    scopeId: scopeId("personal", "U1"),
    manifest: { name: "tidy", description: "d", requiredCapabilities: [], body: "b" },
    createdBy: "U1",
  });
  await store.review(src.id, "R1", []);
  await store.publish(src.id);
  const first = await store.promote(src.id, scopeId("org", ORG));
  const second = await store.promote(src.id, scopeId("org", ORG));
  assert.equal(second.id, first.id, "retry re-uses the org record");
  assert.equal(second.version, first.version + 1);
  const orgRecords = (await store.list()).filter((x) => x.scopeId === scopeId("org", ORG) && x.status === "published");
  assert.equal(orgRecords.length, 1);
});

// --- taking a share back -----------------------------------------------------
// POST /v1/grants/revoke authorizes nothing — it is a `source` route that takes
// `revokedBy` on trust because its callers have already decided. These routes
// are reachable from the web UI, so the check has to live in them.

function callSkillRoute(
  handler: (ctx: ApiCtx) => Promise<void>,
  state: FakeState,
  capability: CapabilityClaims | null,
  id: string,
  body: unknown = {},
) {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const app = fakeApp(state);
  const ctx = { res, app, deps: {}, body, capability, params: { id } } as unknown as ApiCtx;
  return handler(ctx).then(() => out);
}

test("unshare refuses someone who could not have shared it in the first place", async () => {
  const state = ownerState();
  await state.acl.grant({
    ownerScopeId: scopeId("personal", "U1"),
    ref: "skill:S1",
    granteeScopeId: scopeId("channel", "C1"),
    permission: "read",
    grantedBy: "U1",
  } as Grant);

  const stranger = await callSkillRoute(unshareSkill, state, cap("U2"), "S1", {
    scope: scopeId("channel", "C1"),
  });
  assert.equal(stranger.status, 403, "U2 does not manage U1's personal skill");
  assert.equal((await grantsOf(state)).length, 1, "the grant survives a refused revoke");

  const owner = await callSkillRoute(unshareSkill, state, cap("U1"), "S1", { scope: scopeId("channel", "C1") });
  assert.equal(owner.status, 200);
  assert.equal((await grantsOf(state)).length, 0);
});

test("unshare needs a scope, and reports a skill that isn't there as not_found", async () => {
  const state = ownerState();
  assert.equal((await callSkillRoute(unshareSkill, state, cap("U1"), "S1", {})).status, 400);
  assert.equal(
    (await callSkillRoute(unshareSkill, state, cap("U1"), "NOPE", { scope: scopeId("channel", "C1") })).status,
    404,
  );
});

test("listing who a skill is shared with is gated by the same check as sharing it", async () => {
  const state = ownerState();
  await state.acl.grant({
    ownerScopeId: scopeId("personal", "U1"),
    ref: "skill:S1",
    granteeScopeId: scopeId("channel", "C1"),
    permission: "write",
    grantedBy: "U1",
  } as Grant);

  assert.equal((await callSkillRoute(listSkillSharing, state, cap("U2"), "S1")).status, 403);
});

test("demote carries promote's gates in the other direction — admin, and a live person", async () => {
  const state = ownerState();
  state.admins.add("U-admin");

  const trigger = await callSkillRoute(demoteSkill, state, cap("U-admin", undefined, false), "S1");
  assert.equal(trigger.status, 403);
  assert.match(trigger.body.message, /live person/);

  const notAdmin = await callSkillRoute(demoteSkill, state, cap("U1"), "S1");
  assert.equal(notAdmin.status, 403);
  assert.match(notAdmin.body.message, /org admin/);

  const ok = await callSkillRoute(demoteSkill, state, cap("U-admin"), "S1");
  assert.equal(ok.status, 200);
  assert.deepEqual(state.demotes, [{ id: "S1", actorId: "U-admin" }]);
});

test("an admin cannot promote an unshared personal skill through /v1/share", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  const r = await createControlService(built.app).shareArtifact({ type: "skill", id: s.id, scope: "org" }, cap(ADMIN));
  assert.equal(r.ok, false);
  assert.deepEqual(await skillGrants(built, s.id), []);
});

test("sharing a skill to the org grants the same skill org-wide instead of copying it", async () => {
  const built = await ownerFixture();
  const svc = createControlService(built.app);
  const s = await publishSkill(built, {
    owner: "U1",
    name: "slides",
    home: scopeId("channel", "CPRIV"),
    ownerId: "U1",
  });
  const r = await svc.shareArtifact({ type: "skill", id: s.id, scope: "org" }, cap(ADMIN));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.verb, "promote");
  assert.equal(r.id, s.id, "the same id — no org copy");
  assert.equal(r.permission, "read");
  assert.deepEqual(
    (await skillGrants(built, s.id)).map((g) => g.granteeScopeId),
    [OWNER_ORG],
  );
  assert.equal((await built.skills.list()).filter((x) => x.manifest.name === "slides").length, 1);
});

test("a skill share into an audience that already sees another skill of that name is a 409 name conflict", async () => {
  const built = await ownerFixture();
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  const theirs = await publishSkill(built, { owner: "U2", name: "slides", home: scopeId("channel", "CPRIV") });
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = {
    res,
    deps: { control: createControlService(built.app) },
    body: { type: "skill", id: s.id, toScope: scopeId("channel", "CPRIV") },
    capability: cap("U1"),
  } as unknown as ApiCtx;
  await shareRoute(ctx);
  assert.equal(out.status, 409);
  assert.equal(out.body.error, "name_conflict");
  assert.equal(out.body.conflict.id, theirs.id);
  assert.equal(out.body.conflict.owner, "Person U2");
});

test("an org admin shares a channel skill without being in the channel; a trigger cannot share at all", async () => {
  const built = await ownerFixture();
  const svc = createControlService(built.app);
  const s = await publishSkill(built, {
    owner: "U1",
    name: "triage",
    home: scopeId("channel", "CPRIV"),
    ownerId: "U1",
  });
  const byAdmin = await svc.shareArtifact({ type: "skill", id: s.id, scope: scopeId("channel", "CPUB") }, cap(ADMIN));
  assert.ok(byAdmin.ok, JSON.stringify(byAdmin));
  const byTrigger = await svc.shareArtifact(
    { type: "skill", id: s.id, scope: scopeId("personal", "U4") },
    cap("U1", undefined, false),
  );
  assert.equal(!byTrigger.ok && byTrigger.code, "forbidden");
  const byOutsider = await svc.shareArtifact({ type: "skill", id: s.id, scope: scopeId("personal", "U4") }, cap("U4"));
  assert.equal(!byOutsider.ok && byOutsider.code, "forbidden");
});

test("moving a skill through /v1/share re-keys its grants and is refused into a teammate's personal space", async () => {
  const built = await ownerFixture();
  const svc = createControlService(built.app);
  const s = await publishSkill(built, { owner: "U1", name: "slides" });
  await svc.shareArtifact({ type: "skill", id: s.id, scope: scopeId("channel", "CPUB") }, cap("U1"));
  const moved = await svc.shareArtifact(
    { type: "skill", id: s.id, scope: scopeId("channel", "CPRIV"), move: true },
    cap("U1"),
  );
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.deepEqual(
    (await skillGrants(built, s.id)).map((g) => [g.ownerScopeId, g.granteeScopeId]),
    [[scopeId("channel", "CPRIV"), scopeId("channel", "CPUB")]],
  );
  const toTeammate = await svc.shareArtifact(
    { type: "skill", id: s.id, scope: scopeId("personal", "U2"), move: true },
    cap("U1"),
  );
  assert.equal(!toTeammate.ok && toTeammate.code, "forbidden");
});
