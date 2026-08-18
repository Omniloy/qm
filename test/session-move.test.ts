import "./support/auto-fake-sprites.ts";

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInsecureTestServer } from "../src/api/server.ts";
import { projectGroupRef, projectScopeId } from "../src/projects/project-store.ts";
import { isUnclassifiedWrite, isUserScoped, userScopedField } from "../src/api/user-scoped-routes.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { scopeId, type ScopeId, type Session } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

interface Rig {
  built: BuiltApp;
  base: string;
}

async function rig(t: TestContext, name: string): Promise<Rig> {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), `${name}-`)) }));
  const server = createInsecureTestServer(built.app, {});
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
  ]);
  return { built, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function move(
  base: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; session?: Session; error?: string }> {
  const r = await fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await r.json()) as { session?: Session; error?: string };
  return { status: r.status, ...parsed };
}

function personalTurn(built: BuiltApp, actor: string, threadRef: string, text: string): Promise<{ status: string }> {
  return built.app.turn({
    surface: "web",
    actor: { externalId: actor },
    conversation: { kind: "dm", threadRef },
    text,
  });
}

function projectTurn(
  built: BuiltApp,
  actor: string,
  threadRef: string,
  projectId: string,
  text: string,
): Promise<{ status: string }> {
  return built.app.turn({
    surface: "web",
    actor: { externalId: actor },
    conversation: { kind: "group", channelRef: projectGroupRef(projectId), threadRef, audience: [] },
    text,
  });
}

async function seen(built: BuiltApp, sessionId: string, principalId: string): Promise<string> {
  return JSON.stringify(await built.sessions.visibleEntries(sessionId, principalId));
}

async function moves(built: BuiltApp): Promise<Array<{ resource: string; scopeLabel: string }>> {
  return (await built.auditLog.events())
    .filter((e) => e.action === "session.move")
    .map((e) => ({ resource: e.resource, scopeLabel: e.scopeLabel }));
}

test("moving a conversation into a Project hands the whole history to its members, and back out takes it away", async (t) => {
  const { built, base } = await rig(t, "session-move-roundtrip");
  const project = await built.app.createProject("owner", "Launch Cohort");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const scope = projectScopeId(project.id);

  const threadRef = "web:owner:roundtrip";
  assert.equal((await personalTurn(built, "owner", threadRef, "PERSONAL_SECRET")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  assert.equal(await seen(built, session.id, "member"), "[]", "the project cannot see it before the move");

  const moved = await move(base, session.id, { principalId: "owner", scopeId: scope });
  assert.equal(moved.status, 200);
  assert.equal(moved.session?.scopeId, scope);
  assert.equal(moved.session?.type, "group");
  assert.equal(moved.session?.channelName, "Launch Cohort");
  const inProject = await built.sessions.get(session.id);
  assert.equal(inProject?.scopeId, scope);
  assert.equal(inProject?.type, "group");
  assert.equal(inProject?.channelName, "Launch Cohort");
  assert.equal(inProject?.threadRef, threadRef, "the thread and its transcript stay put");
  assert.match(await seen(built, session.id, "member"), /PERSONAL_SECRET/, "joiners get the history");

  assert.equal((await projectTurn(built, "owner", threadRef, project.id, "WHILE_SHARED")).status, "ok");
  assert.match(await seen(built, session.id, "member"), /WHILE_SHARED/);

  const back = await move(base, session.id, { principalId: "owner", scopeId: scopeId("personal", "owner") });
  assert.equal(back.status, 200);
  assert.equal(back.session?.scopeId, scopeId("personal", "owner"));
  assert.equal(back.session?.type, "dm");
  assert.equal(back.session?.channelName, undefined);

  assert.equal((await personalTurn(built, "owner", threadRef, "AFTER_MOVE_BACK")).status, "ok");
  const afterward = await seen(built, session.id, "member");
  assert.match(afterward, /WHILE_SHARED/, "what they saw while it was shared stays theirs");
  assert.doesNotMatch(afterward, /AFTER_MOVE_BACK/, "the leaver's window closed at the move");
  assert.match(await seen(built, session.id, "owner"), /AFTER_MOVE_BACK/, "the mover keeps the conversation");

  assert.deepEqual(await moves(built), [
    { resource: session.id, scopeLabel: `${scopeId("personal", "owner")} -> ${scope}` },
    { resource: session.id, scopeLabel: `${scope} -> ${scopeId("personal", "owner")}` },
  ]);
});

test("moving between Projects swaps one roster for the other", async (t) => {
  const { built, base } = await rig(t, "session-move-project-to-project");
  const from = await built.app.createProject("owner", "From");
  const to = await built.app.createProject("owner", "To");
  assert.ok(from && to);
  assert.equal((await built.app.addProjectMember(from.id, "owner", "member")).status, "ok");
  assert.equal((await built.app.addProjectMember(to.id, "owner", "outsider")).status, "ok");

  const threadRef = "web:owner:swap";
  assert.equal((await projectTurn(built, "owner", threadRef, from.id, "IN_FIRST_PROJECT")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);

  const moved = await move(base, session.id, { principalId: "owner", scopeId: projectScopeId(to.id) });
  assert.equal(moved.status, 200);
  assert.equal(moved.session?.scopeId, projectScopeId(to.id));
  assert.equal(moved.session?.channelName, "To");
  assert.match(await seen(built, session.id, "outsider"), /IN_FIRST_PROJECT/, "the new roster gets the history");
  assert.equal(await built.app.getSessionForViewer(session.id, "member"), null, "the old roster loses it entirely");
  assert.ok(await built.app.getSessionForViewer(session.id, "owner"));
});

test("a Project-to-Project move never holds two roster locks at once", async (t) => {
  const { built, base } = await rig(t, "session-move-lock-depth");
  const from = await built.app.createProject("owner", "From");
  const to = await built.app.createProject("owner", "To");
  assert.ok(from && to);

  const inner = built.projects.withRosterLock.bind(built.projects);
  let held = 0;
  let deepest = 0;
  built.projects.withRosterLock = (id, fn) =>
    inner(id, async (project) => {
      deepest = Math.max(deepest, ++held);
      try {
        return await fn(project);
      } finally {
        held--;
      }
    });

  const threadRef = "web:owner:lock-depth";
  assert.equal((await projectTurn(built, "owner", threadRef, from.id, "hello")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);

  const moved = await move(base, session.id, { principalId: "owner", scopeId: projectScopeId(to.id) });
  assert.equal(moved.status, 200);
  assert.equal(deepest, 1, "a nested roster lock pins two pool clients and can deadlock the instance");
});

test("moving out closes every participant's window, not only the roster the session is leaving", async (t) => {
  const { built, base } = await rig(t, "session-move-strays");
  const project = await built.app.createProject("owner", "Strays");
  assert.ok(project);

  const threadRef = "web:owner:strays";
  assert.equal((await projectTurn(built, "owner", threadRef, project.id, "BEFORE_MOVE")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  await built.sessions.addParticipant(session.id, "outsider", undefined, { includeHistory: true });
  assert.match(await seen(built, session.id, "outsider"), /BEFORE_MOVE/);

  const moved = await move(base, session.id, { principalId: "owner", scopeId: scopeId("personal", "owner") });
  assert.equal(moved.status, 200);
  assert.equal((await personalTurn(built, "owner", threadRef, "AFTER_MOVE")).status, "ok");
  const stray = await seen(built, session.id, "outsider");
  assert.match(stray, /BEFORE_MOVE/);
  assert.doesNotMatch(stray, /AFTER_MOVE/, "a participant no roster accounts for is cut off all the same");
});

test("moving a conversation is refused for anyone but a mover who can continue it, and for any other destination", async (t) => {
  const { built, base } = await rig(t, "session-move-authz");
  const project = await built.app.createProject("owner", "Members Only");
  const foreign = await built.app.createProject("outsider", "Not Yours");
  assert.ok(project && foreign);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const threadRef = "web:owner:authz";
  assert.equal((await personalTurn(built, "owner", threadRef, "hello")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);

  const stranger = await move(base, session.id, { principalId: "outsider", scopeId: projectScopeId(foreign.id) });
  assert.equal(stranger.status, 404, "a non-participant learns nothing, not even that it exists");

  const foreignDestination = await move(base, session.id, {
    principalId: "owner",
    scopeId: projectScopeId(foreign.id),
  });
  assert.equal(foreignDestination.status, 403, "a project the mover does not belong to is not a destination");

  const channelDestination = await move(base, session.id, {
    principalId: "owner",
    scopeId: scopeId("channel", "C123"),
  });
  assert.equal(channelDestination.status, 403, "a Slack channel is not a destination");

  const someoneElsesPersonal = await move(base, session.id, {
    principalId: "owner",
    scopeId: scopeId("personal", "member"),
  });
  assert.equal(someoneElsesPersonal.status, 403, "a conversation cannot be pushed into another person's context");

  const caseVariantPersonal = await move(base, session.id, {
    principalId: "owner",
    scopeId: scopeId("personal", "OWNER"),
  });
  assert.equal(caseVariantPersonal.status, 403, "a personal scope no other path spells is not a destination");

  assert.equal((await move(base, session.id, { principalId: "owner" })).status, 400);
  assert.equal((await move(base, session.id, { scopeId: projectScopeId(project.id) })).status, 400);
  assert.equal(
    (await move(base, "no-such-session", { principalId: "owner", scopeId: projectScopeId(project.id) })).status,
    404,
  );

  assert.equal((await built.sessions.get(session.id))?.scopeId, scopeId("personal", "owner"), "nothing moved");
});

test("a Project conversation is the author's to file, not every member's", async (t) => {
  const { built, base } = await rig(t, "session-move-peer");
  const shared = await built.app.createProject("owner", "Shared");
  const peers = await built.app.createProject("member", "Peer's Own");
  assert.ok(shared && peers);
  assert.equal((await built.app.addProjectMember(shared.id, "owner", "member")).status, "ok");

  const threadRef = "web:owner:peer";
  assert.equal((await projectTurn(built, "owner", threadRef, shared.id, "TEAM_SECRET")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  assert.match(await seen(built, session.id, "member"), /TEAM_SECRET/, "a member reads it where it lives");

  const toOwnPersonal = await move(base, session.id, { principalId: "member", scopeId: scopeId("personal", "member") });
  assert.equal(toOwnPersonal.status, 403, "a peer cannot take a shared conversation private and evict the rest");

  const toOwnProject = await move(base, session.id, { principalId: "member", scopeId: projectScopeId(peers.id) });
  assert.equal(toOwnProject.status, 403, "a peer cannot export it to a roster that never had it");

  assert.equal((await built.sessions.get(session.id))?.scopeId, projectScopeId(shared.id), "nothing moved");
  assert.ok(await built.app.getSessionForViewer(session.id, "owner"), "the author still has it");
  assert.deepEqual(await moves(built), []);
});

test("losing the context a conversation lives in ends the right to move it out", async (t) => {
  const { built, base } = await rig(t, "session-move-evicted");
  const project = await built.app.createProject("owner", "Landing Pad");
  assert.ok(project);
  await built.app.upsertChannels(
    [{ channelId: "C-secret", name: "secret", isPrivate: true }],
    [
      { channelId: "C-secret", principalId: "owner" },
      { channelId: "C-secret", principalId: "member" },
    ],
  );

  const threadRef = "web:owner:evicted";
  assert.equal(
    (
      await built.app.turn({
        surface: "web",
        actor: { externalId: "owner" },
        conversation: { kind: "channel", channelRef: "C-secret", threadRef, audience: [] },
        text: "PRIVATE_CHANNEL_SECRET",
      })
    ).status,
    "ok",
  );
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  assert.equal(session.scopeId, scopeId("channel", "C-secret"));

  await built.app.upsertChannels([{ channelId: "C-secret", name: "secret", isPrivate: true }], []);
  const minted = await built.app.createSessionShare(session.id, "owner");
  assert.equal(minted.ok, false, "the share path already refuses an evicted sharer");

  const smuggled = await move(base, session.id, { principalId: "owner", scopeId: projectScopeId(project.id) });
  assert.equal(smuggled.status, 403, "a stale participant row is not a licence to relocate the transcript");
  assert.equal((await built.sessions.get(session.id))?.scopeId, scopeId("channel", "C-secret"));
  assert.equal(await seen(built, session.id, "outsider"), "[]", "nobody outside the channel gained the history");
});

test("a turn queued before a move cannot restore the roster the conversation left", async (t) => {
  const { built, base } = await rig(t, "session-move-inflight");
  const project = await built.app.createProject("owner", "In Flight");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const threadRef = "web:owner:inflight";
  assert.equal((await projectTurn(built, "owner", threadRef, project.id, "SHARED_LINE")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);

  const queued = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: { kind: "group", channelRef: projectGroupRef(project.id), threadRef, audience: [] },
    text: "queued while it was still shared",
    async: true,
  });
  assert.equal(queued.status, "queued");

  const moved = await move(base, session.id, { principalId: "owner", scopeId: scopeId("personal", "owner") });
  assert.equal(moved.status, 200);

  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(queued.runId!, 5_000);
    assert.equal(finished.result?.status, "refused");
    assert.match(finished.result?.reason ?? "", /different context/);
  } finally {
    await built.runtime.stop();
  }

  assert.equal((await personalTurn(built, "owner", threadRef, "AFTER_MOVE")).status, "ok");
  const stale = await seen(built, session.id, "member");
  assert.match(stale, /SHARED_LINE/);
  assert.doesNotMatch(stale, /AFTER_MOVE/, "the stale run did not re-admit the roster the move closed");
});

test("a Slack conversation cannot be moved: its scope is recomputed from every inbound turn", async (t) => {
  const { built, base } = await rig(t, "session-move-slack");
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);

  const threadRef = "dm:owner:slack-thread";
  assert.equal(
    (
      await built.app.turn({
        surface: "slack",
        actor: { externalId: "owner" },
        conversation: { kind: "dm", threadRef },
        text: "hello from slack",
      })
    ).status,
    "ok",
  );
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);
  assert.equal(session.surface, "slack");

  const refused = await move(base, session.id, { principalId: "owner", scopeId: projectScopeId(project.id) });
  assert.equal(refused.status, 403);
  assert.equal((await built.sessions.get(session.id))?.scopeId, scopeId("personal", "owner"));
});

test("moving a conversation to the context it already lives in changes nothing", async (t) => {
  const { built, base } = await rig(t, "session-move-noop");
  const threadRef = "web:owner:noop";
  assert.equal((await personalTurn(built, "owner", threadRef, "hello")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);

  const noop = await move(base, session.id, { principalId: "owner", scopeId: scopeId("personal", "owner") });
  assert.equal(noop.status, 200);
  assert.equal(noop.session?.scopeId, scopeId("personal", "owner"));
  assert.equal(noop.session?.type, "dm");
  assert.deepEqual(await moves(built), [], "a move that did not happen is not audited");
});

test("a share link minted before a move stops resolving after it", async (t) => {
  const { built, base } = await rig(t, "session-move-share");
  const project = await built.app.createProject("owner", "Launch");
  assert.ok(project);

  const threadRef = "web:owner:share";
  assert.equal((await personalTurn(built, "owner", threadRef, "PUBLISHED_LINE")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);

  const minted = await built.app.createSessionShare(session.id, "owner");
  assert.ok(minted.ok);
  assert.ok(await built.app.resolveSharedTranscript(minted.shareId, null), "the link resolves before the move");

  const moved = await move(base, session.id, { principalId: "owner", scopeId: projectScopeId(project.id) });
  assert.equal(moved.status, 200);
  assert.equal(
    await built.app.resolveSharedTranscript(minted.shareId, null),
    null,
    "the audience the sharer consented to is gone, so the link is too",
  );
});

test("POST /v1/sessions/:id/move is registered as user-scoped on principalId", () => {
  const path = "/v1/sessions/abc/move";
  assert.equal(isUserScoped("POST", path), true);
  assert.deepEqual(userScopedField("POST", path), { in: "body", name: "principalId" });
  assert.equal(isUnclassifiedWrite("POST", path), false);
});

test("moveSessionForViewer is the only writer of a session's scope", async (t) => {
  const { built } = await rig(t, "session-move-store");
  const threadRef = "web:owner:store";
  assert.equal((await personalTurn(built, "owner", threadRef, "hello")).status, "ok");
  const session = await built.sessions.getByThread(threadRef);
  assert.ok(session);

  const target: ScopeId = scopeId("group", "web-project-direct");
  await built.sessions.updateScope(session.id, { scopeId: target, type: "group", channelName: "Direct" });
  const after = await built.sessions.get(session.id);
  assert.equal(after?.scopeId, target);
  assert.equal(after?.type, "group");
  assert.equal(after?.channelName, "Direct");

  await built.sessions.updateScope(session.id, {
    scopeId: scopeId("personal", "owner"),
    type: "dm",
    channelName: null,
  });
  const cleared = await built.sessions.get(session.id);
  assert.equal(cleared?.scopeId, scopeId("personal", "owner"));
  assert.equal(cleared?.type, "dm");
  assert.equal(cleared?.channelName, undefined, "a personal conversation carries no channel name");
});
