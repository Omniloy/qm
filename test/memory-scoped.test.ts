import "./support/auto-fake-sprites.ts";

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import type { MemoryRevision, MemoryService } from "../src/memory/memory-service.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const PID = "portal-only-identity-secret-for-tests-01";

interface Rig {
  built: BuiltApp;
  base: string;
  project: ScopeId;
}

function versionedMemory(built: BuiltApp): MemoryService {
  const revisions = new Map<ScopeId, MemoryRevision[]>();
  return {
    ...built.memory,
    async replace(scope, content, author) {
      await built.memory.replace(scope, content, author);
      const history = revisions.get(scope) ?? [];
      history.push({
        revision: String(history.length + 1),
        content: await built.memory.read(scope),
        operation: "replace",
        ...(author ? { author } : {}),
        at: Date.now(),
      });
      revisions.set(scope, history);
    },
    async history(scope, limit = 30) {
      return (revisions.get(scope) ?? []).toReversed().slice(0, limit);
    },
    async restore(scope, revision, expectedRevision, author) {
      const history = revisions.get(scope) ?? [];
      if (String(history.length) !== expectedRevision) return false;
      const target = history.find((entry) => entry.revision === revision);
      if (!target) return false;
      await this.replace(scope, target.content, author);
      return true;
    },
  };
}

async function rig(t: TestContext, name: string): Promise<Rig> {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), `${name}-`)) }));
  const server = createInsecureTestServer(built.app, {
    auditLog: built.auditLog,
    memory: versionedMemory(built),
    portalIdentitySecret: PID,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Launch Cohort");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  return { built, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project: projectScopeId(project.id) };
}

const token = (p: string) => mintSignedPayload({ p, exp: Date.now() + 60_000 }, PID);
const json = async (r: Response): Promise<any> => r.json();

function getMemory(base: string, principalId: string, scope?: ScopeId): Promise<Response> {
  const q = scope === undefined ? "" : `&scopeId=${encodeURIComponent(scope)}`;
  return fetch(`${base}/v1/memory?principalId=${encodeURIComponent(principalId)}${q}`);
}

function putMemory(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getHistory(base: string, principalId: string, scope?: ScopeId): Promise<Response> {
  const q = scope === undefined ? "" : `&scopeId=${encodeURIComponent(scope)}`;
  return fetch(`${base}/v1/memory/history?principalId=${encodeURIComponent(principalId)}${q}`, {
    headers: { "x-portal-identity": await token(principalId) },
  });
}

async function restoreMemory(base: string, principalId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/memory/restore`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-portal-identity": await token(principalId) },
    body: JSON.stringify({ principalId, ...body }),
  });
}

test("project members share the project notebook through scopeId; personal stays the default", async (t) => {
  const { built, base, project } = await rig(t, "memory-scoped-members");

  const empty = await getMemory(base, "member", project);
  assert.equal(empty.status, 200);
  assert.equal((await json(empty)).content, "", "an untouched project notebook reads empty");

  const put = await putMemory(base, { principalId: "member", content: "# Memory\n\n- Ship Friday\n", scopeId: project });
  assert.equal(put.status, 200);
  assert.equal(
    (await json(await getMemory(base, "owner", project))).content,
    "# Memory\n\n- Ship Friday\n",
    "every member sees the same project notebook",
  );

  assert.equal(
    (await json(await getMemory(base, "member"))).content,
    "",
    "omitting scopeId still reads the personal notebook",
  );
  assert.equal(await built.memory.read(scopeId("personal", "member")), "", "the project write never touches personal");

  const own = await getMemory(base, "member", scopeId("personal", "member"));
  assert.equal(own.status, 200, "naming your own personal scope explicitly is allowed");

  const audited = (await built.auditLog.events()).filter((e) => e.principalId === "member").map((e) => e.scopeLabel);
  assert.ok(audited.includes(project), "audit records carry the scope actually used");
});

test("non-members and strangers' personal notebooks are invisible (404), and writes are refused", async (t) => {
  const { built, base, project } = await rig(t, "memory-scoped-outsiders");

  const denied = await getMemory(base, "outsider", project);
  assert.equal(denied.status, 404);
  assert.deepEqual(await json(denied), { error: "not_found", message: "not a context you can see" });

  const write = await putMemory(base, { principalId: "outsider", content: "# Memory\n\n- sneak\n", scopeId: project });
  assert.equal(write.status, 404);
  assert.equal(await built.memory.read(project), "", "a denied write leaves the notebook untouched");

  assert.equal((await getMemory(base, "member", scopeId("personal", "owner"))).status, 404);
  assert.equal(
    (await putMemory(base, { principalId: "member", content: "x", scopeId: scopeId("personal", "owner") })).status,
    404,
    "another person's personal notebook stays theirs",
  );

  assert.equal((await putMemory(base, { principalId: "member", content: "x", scopeId: 42 })).status, 400);
});

test("the org notebook stays closed to scoped self routes for every internal user", async (t) => {
  const { built, base } = await rig(t, "memory-scoped-org");
  const org = scopeId("org", "default-org");

  assert.equal((await getMemory(base, "member", org)).status, 404);
  assert.equal((await getHistory(base, "member", org)).status, 404);
  assert.equal((await putMemory(base, { principalId: "member", content: "# pwned\n", scopeId: org })).status, 404);
  assert.equal((await restoreMemory(base, "member", { revision: "1", expectedRevision: "1", scopeId: org })).status, 404);
  assert.equal(await built.memory.read(org), "", "the org notebook is untouched");
});

test("a public channel's notebook belongs to its members, not to every internal user", async (t) => {
  const { built, base } = await rig(t, "memory-scoped-public-channel");
  const channel = scopeId("channel", "C-pub");
  await built.directory.replaceChannels(
    [{ channelId: "C-pub", name: "town-square", isPrivate: false }],
    [{ channelId: "C-pub", principalId: "member" }],
  );

  const memberWrite = await putMemory(base, { principalId: "member", content: "# Memory\n\n- ours\n", scopeId: channel });
  assert.equal(memberWrite.status, 200, "a channel member edits the channel notebook");

  assert.equal((await getMemory(base, "outsider", channel)).status, 404);
  assert.equal((await getHistory(base, "outsider", channel)).status, 404);
  assert.equal(
    (await putMemory(base, { principalId: "outsider", content: "# poisoned\n", scopeId: channel })).status,
    404,
  );
  assert.equal(
    (await restoreMemory(base, "outsider", { revision: "1", expectedRevision: "1", scopeId: channel })).status,
    404,
  );
  assert.equal(await built.memory.read(channel), "# Memory\n\n- ours\n", "non-members leave the notebook untouched");
});

test("revisioned saves on a project notebook still reject stale editors", async (t) => {
  const { base, project } = await rig(t, "memory-scoped-conflict");

  const head = await json(await getMemory(base, "member", project));
  const first = await putMemory(base, {
    principalId: "member",
    content: "# Memory\n\n- first\n",
    revision: head.revision,
    scopeId: project,
  });
  assert.equal(first.status, 200);

  const stale = await putMemory(base, {
    principalId: "owner",
    content: "# Memory\n\n- stale\n",
    revision: head.revision,
    scopeId: project,
  });
  assert.equal(stale.status, 409);
  assert.match((await json(stale)).content, /first/, "the conflict response carries the winning content");
});

test("history and restore follow scopeId for members and 404 for everyone else", async (t) => {
  const { built, base, project } = await rig(t, "memory-scoped-history");

  await putMemory(base, { principalId: "member", content: "# Memory\n\n- v1\n", scopeId: project });
  await putMemory(base, { principalId: "member", content: "# Memory\n\n- v2\n", scopeId: project });

  const history = await getHistory(base, "member", project);
  assert.equal(history.status, 200);
  const revisions = (await json(history)).revisions;
  assert.equal(revisions.length, 2);
  assert.match(revisions[0].content, /v2/);

  assert.equal((await getHistory(base, "member")).status, 200, "history without scopeId still answers for personal");

  assert.equal((await getHistory(base, "outsider", project)).status, 404);
  assert.equal((await getHistory(base, "member", scopeId("personal", "owner"))).status, 404);

  const restored = await restoreMemory(base, "member", { revision: "1", expectedRevision: "2", scopeId: project });
  assert.equal(restored.status, 200);
  assert.match(await built.memory.read(project), /v1/, "restore rewinds the project notebook");

  assert.equal(
    (await restoreMemory(base, "outsider", { revision: "1", expectedRevision: "3", scopeId: project })).status,
    404,
  );
  assert.equal(
    (await restoreMemory(base, "member", { revision: "1", expectedRevision: "3", scopeId: scopeId("personal", "owner") }))
      .status,
    404,
  );

  const restores = (await built.auditLog.events()).filter((e) => e.action === "memory.self.restore");
  assert.deepEqual(
    restores.map((e) => e.scopeLabel),
    [project],
    "only the member's restore lands, audited under the project scope",
  );
});
