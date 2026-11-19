import "./support/auto-fake-sprites.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { filterHistoryForAudience } from "../src/resolution/context-filter.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import type { BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

let executions = 0;
let observedRelease = "";
let failRelease = false;
const SHARED_SKILL = "teammate-crm-fixture";

function fixtureCall(input: string): { tool: string; args: unknown } {
  if (input.includes("skill")) return { tool: "skills", args: { action: "read", name: SHARED_SKILL } };
  if (input.includes("shared")) return { tool: "files", args: { action: "read", path: "private.txt" } };
  return { tool: "execute", args: { command: "printf SCREENING_FIXTURE_BLOCK" } };
}
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    createMockHarness() {
      const harness = createMockHarness();
      const run = harness.turns.runTurn;
      harness.turns.runTurn = async (turn: HarnessTurnInput) => {
        if (turn.input.startsWith("The human released quarantined")) {
          const held = turn.history.findLast(
            (entry) =>
              entry.type === "user" &&
              (entry.payload as { securityReleaseRequestId?: string }).securityReleaseRequestId,
          );
          observedRelease = String((held?.payload as { text?: string } | undefined)?.text ?? "Missing released output");
          if (failRelease) throw new Error("fixture continuation failure");
          const reply = "Released fixture output.";
          await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
          await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
          return { reply };
        }
        if (!turn.input.startsWith("run fixture")) return run(turn);
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        const ref: ToolContextRef = {
          current: {
            ...turn.tools,
            async read() {
              return { content: "SCREENING_FIXTURE_BLOCK", sourceScopeId: "personal:U1", shared: true };
            },
            async execute() {
              executions++;
              return { stdout: "SCREENING_FIXTURE_BLOCK", stderr: "", code: 0, timedOut: false };
            },
          },
          emit: turn.emit,
          scopeLabel: turn.scopeLabel,
          orgScopeId: turn.orgScopeId,
          toolApprovalGate: turn.toolApprovalGate,
          screenToolResult: turn.screenToolResult,
          pendingApprovals: [],
        };
        const call = fixtureCall(turn.input);
        const tool = createAgentTools(ref).find((tool) => tool.name === call.tool)!;
        const execute = tool.execute as unknown as (
          id: string,
          args: unknown,
        ) => Promise<{ content: Array<{ text?: string }> }>;
        const result = await execute("fixture-call", call.args);
        const reply = result.content.map((part) => part.text ?? "").join("\n");
        await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
        return { reply, pendingApprovals: ref.pendingApprovals, pausedOnApproval: ref.pausedOnApproval };
      };
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

function request(threadRef = "fixture-thread"): TurnRequest {
  return { surface: "test", actor: { externalId: "U1" }, conversation: { kind: "dm", threadRef }, text: "run fixture" };
}

for (const securityPosture of ["dangerous", "auto", "strict"] as const) {
  test(`${securityPosture}: real wrapper releases exact saved output without rerunning or widening permissions`, async () => {
    executions = 0;
    const built = buildApp(testConfig({ securityPosture, securityScreenAllPostures: true }), {
      securityScreener: {
        provider: "fixture-screen",
        shadow: false,
        async classify() {
          return { verdict: { decision: "strict", reason: "fixture verdict" }, score: 1, threshold: 0.5 };
        },
      },
    });
    const req = request();
    let blocked = await built.app.turn(req);
    if (securityPosture === "strict") {
      assert.equal(executions, 0);
      assert.equal(blocked.pendingApprovals?.[0]?.approvalKey, "tool:execute");
      blocked = await built.app.turn({
        ...req,
        approval: { requestId: blocked.pendingApprovals![0]!.requestId, approved: true },
      });
    }
    assert.equal(executions, 1);
    assert.equal(blocked.pendingApprovals?.length, 1);
    const release = blocked.pendingApprovals![0]!;
    assert.equal(release.approvalKey, "security-screen-release:execute");
    assert.deepEqual(release.grantModes, { session: false, always: false });
    const results = (await built.sessions.getEntries(blocked.sessionId!)).filter(
      (entry) => entry.type === "tool_result",
    );
    assert.ok(results.some((entry) => (entry.payload as { quarantined?: boolean }).quarantined));
    assert.doesNotMatch(JSON.stringify(results), /SCREENING_FIXTURE_BLOCK/);
    for (const scope of ["session", "always"] as const) {
      const broad = await built.app.turn({ ...req, approval: { requestId: release.requestId, approved: true, scope } });
      assert.equal(broad.status, "pending_approval");
      assert.match(broad.reason ?? "", /only be released once/);
      assert.equal(executions, 1);
    }
    const approved = await built.app.turn({ ...req, approval: { requestId: release.requestId, approved: true } });
    assert.equal(approved.status, "ok");
    assert.match(observedRelease, /SCREENING_FIXTURE_BLOCK/);
    assert.equal(executions, 1, "release never executes the side effect again");
    const fresh = await built.app.turn(request("second-fixture-thread"));
    assert.equal(fresh.pendingApprovals?.length, 1);
    assert.equal(
      fresh.pendingApprovals?.[0]?.approvalKey,
      securityPosture === "strict" ? "tool:execute" : "security-screen-release:execute",
    );
  });
}

for (const failure of ["error", "timeout"] as const) {
  test(`real tool output is marked and audited when the proxy ${failure}s`, async () => {
    const built = buildApp(
      testConfig({ securityPosture: "dangerous", securityScreenAllPostures: true, securityScreenTimeoutMs: 10 }),
      {
        securityScreener: {
          provider: "fixture-screen",
          shadow: false,
          async classify() {
            if (failure === "timeout") await new Promise((resolve) => setTimeout(resolve, 50));
            throw new Error("fixture unavailable");
          },
        },
      },
    );
    const result = await built.app.turn(request());
    assert.equal(result.status, "ok");
    assert.match(result.reply ?? "", /NOT security-screened/);
    assert.match(result.reply ?? "", /SCREENING_FIXTURE_BLOCK/);
    const events = await built.auditLog.events();
    assert.ok(events.some((event) => event.action === "security_screen.classify" && event.status === "error"));
    assert.ok(events.some((event) => event.action === "security_posture.tool_result_failed_open"));
  });
}

test("released shared content retains scope and survives a failed continuation", async () => {
  const built = buildApp(testConfig({ securityPosture: "dangerous", securityScreenAllPostures: true }), {
    securityScreener: {
      provider: "fixture-screen",
      shadow: false,
      async classify() {
        return { verdict: { decision: "strict" }, score: 1, threshold: 0.5 };
      },
    },
  });
  const req: TurnRequest = {
    ...request(),
    text: "run fixture shared",
    conversation: { kind: "channel", threadRef: "shared-fixture", channelRef: "C", audience: [{ externalId: "U1" }] },
  };
  const blocked = await built.app.turn(req);
  const approval = { requestId: blocked.pendingApprovals![0]!.requestId, approved: true };
  failRelease = true;
  try {
    await built.app.turn({ ...req, approval }).catch(() => undefined);
  } finally {
    failRelease = false;
  }
  const entries = await built.sessions.getEntries(blocked.sessionId!);
  const released = entries.filter(
    (entry) =>
      entry.type === "user" &&
      (entry.payload as { securityReleaseRequestId?: string }).securityReleaseRequestId === approval.requestId,
  );
  assert.equal(released.length, 1);
  assert.equal(released[0]!.scopeLabel, "personal:U1");
  assert.match(JSON.stringify(released[0]!.payload), /SCREENING_FIXTURE_BLOCK/);
  assert.equal(
    filterHistoryForAudience(released, [{ id: "U2", type: "internal" }], "channel:C", "org:default-org").length,
    0,
  );
  const replay = await built.app.turn({ ...req, approval });
  assert.equal(replay.status, "refused");
  assert.match(replay.reason ?? "", /expired/);
});

async function shareTeammateSkill(built: BuiltApp): Promise<string> {
  const skill = await built.skills.create({
    scopeId: scopeId("personal", "U2"),
    manifest: {
      name: SHARED_SKILL,
      description: "A teammate's CRM routine",
      requiredCapabilities: [],
      body: "SCREENING_FIXTURE_BLOCK",
    },
    createdBy: "U2",
  });
  await built.skills.review(skill.id, "reviewer", []);
  await built.skills.publish(skill.id);
  const shared = await built.app.shareSkill({
    id: skill.id,
    toScope: scopeId("personal", "U1"),
    permission: "read",
    actorId: "U2",
    liveActor: true,
  });
  assert.ok(shared.ok, JSON.stringify(shared));
  return skill.id;
}

function strictScreenApp(): BuiltApp {
  return buildApp(testConfig({ securityPosture: "dangerous", securityScreenAllPostures: true }), {
    securityScreener: {
      provider: "fixture-screen",
      shadow: false,
      async classify() {
        return { verdict: { decision: "strict", reason: "fixture verdict" }, score: 1, threshold: 0.5 };
      },
    },
  });
}

test("a held skill a teammate shares with this conversation is released into it once approved", async () => {
  const built = strictScreenApp();
  await shareTeammateSkill(built);
  const req: TurnRequest = { ...request("teammate-skill"), text: "run fixture skill" };
  const blocked = await built.app.turn(req);
  const hold = blocked.pendingApprovals?.[0];
  assert.equal(hold?.approvalKey, "security-screen-release:skills");
  observedRelease = "";
  const approved = await built.app.turn({ ...req, approval: { requestId: hold!.requestId, approved: true } });
  assert.equal(approved.status, "ok", approved.reason);
  assert.match(observedRelease, /SCREENING_FIXTURE_BLOCK/);
  const released = (await built.sessions.getEntries(blocked.sessionId!)).find(
    (entry) =>
      entry.type === "user" &&
      (entry.payload as { securityReleaseRequestId?: string }).securityReleaseRequestId === hold!.requestId,
  );
  assert.equal(released?.scopeLabel, scopeId("personal", "U1"));
});

test("a held skill its owner stopped sharing stays blocked", async () => {
  const built = strictScreenApp();
  const skillId = await shareTeammateSkill(built);
  const req: TurnRequest = { ...request("unshared-skill"), text: "run fixture skill" };
  const blocked = await built.app.turn(req);
  const hold = blocked.pendingApprovals?.[0];
  assert.equal(hold?.approvalKey, "security-screen-release:skills");
  const unshared = await built.app.unshareSkill({
    id: skillId,
    scope: scopeId("personal", "U1"),
    actorId: "U2",
    liveActor: true,
  });
  assert.ok(unshared.ok, JSON.stringify(unshared));
  const refused = await built.app.turn({ ...req, approval: { requestId: hold!.requestId, approved: true } });
  assert.equal(refused.status, "refused");
  assert.match(refused.reason ?? "", /no longer readable/);
});
