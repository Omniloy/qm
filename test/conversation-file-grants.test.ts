import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const actor = { externalId: "U1" };

test("a file the agent posts in a web group conversation is readable by the conversation scope", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "web-group-files-")) }));
  const { app, acl } = built;
  await app.upsertDirectory([
    { principalId: "U1", displayName: "One", type: "internal" },
    { principalId: "U2", displayName: "Two", type: "internal" },
  ]);
  const project = await app.createProject("U1", "Files");
  assert.ok(project);
  assert.equal((await app.addProjectMember(project.id, "U1", "U2")).status, "ok");
  const ref = project.scopeId.slice("group:".length);
  const scopeVersion = await built.projects.version(ref);
  const conversation = {
    kind: "group" as const,
    threadRef: "web:U1:group-files",
    channelRef: ref,
    audience: [actor, { externalId: "U2" }],
  };
  const turn = (text: string): TurnRequest => ({
    surface: "web",
    actor,
    conversation,
    text,
    surfaceTools: true,
    deliveryTarget: conversation.threadRef,
    ...(scopeVersion ? { scopeVersion } : {}),
  });
  await app.turn(turn("!run printf FLAG > chart.png"));
  const posted = await app.turn(turn("!postfiles chart.png here it is"));
  assert.notEqual(posted.status, "error");
  const handle = (await acl.handlesFor([project.scopeId])).find((h) => h.ownerPath.endsWith("/chart.png"));
  assert.ok(handle, "the posted file is granted to the group scope");
  assert.equal(handle.ownerScopeId, scopeId("personal", "U1"));
});
