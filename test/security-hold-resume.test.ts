import { test } from "node:test";
import assert from "node:assert/strict";
import { supersedeScheduledHold, resumeScheduledHold } from "../src/triggers/security-hold-resume.ts";
import type { PendingApprovalRecord, TurnResult } from "../src/types.ts";

const record: PendingApprovalRecord = {
  sessionId: "s1",
  command: "release quarantined execute output",
  createdAt: 1,
  request: {
    surface: "cron",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "cron:c1:fire:a" },
    text: "run",
  },
  securityHold: {
    source: { kind: "command", command: "ls" },
    category: "other",
    scheduledTask: { id: "c1", title: "Jira", ownerId: "U1" },
  },
};

function deps(result: TurnResult) {
  return {
    run: async () => result,
    crons: { get: async () => null, recordFire: async () => {}, latestFireForThread: async () => undefined },
    deliveries: {} as never,
    idempotency: {} as never,
    identity: {} as never,
  };
}

test("a busy session or other transient refusal is a retryable failure carrying the real reason", async () => {
  const busy = await supersedeScheduledHold(
    deps({ status: "refused", refusalKind: "session_busy", reason: "the conversation is busy" }),
    "H1",
    record,
  );
  assert.deepEqual(busy, { outcome: "failed", message: "The run could not continue: the conversation is busy." });
});

test("rate limits, budgets and failed runs are retryable too", async () => {
  for (const result of [
    { status: "refused", refusalKind: "rate_limited", reason: "rate limit exceeded" },
    { status: "refused", refusalKind: "budget_exceeded", reason: "budget exceeded" },
    { status: "failed", reason: "provider error" },
  ] as TurnResult[]) {
    const decision = await supersedeScheduledHold(deps(result), "H1", record);
    assert.equal(decision?.outcome, "failed", result.reason);
  }
});

test("every other refusal is permanent and reported as gone", async () => {
  for (const reason of [
    "that approval request expired — ask again if you still want it to run",
    "only the person who requested this command can approve or deny it",
    "this conversation is no longer available — start a new one",
    "internal-only: shared audience includes a non-internal participant",
  ]) {
    const gone = await resumeScheduledHold(deps({ status: "refused", reason }), "H1", record, false);
    assert.equal(gone.outcome, "gone");
    assert.match(gone.message, new RegExp(reason.slice(0, 20)));
  }
});

test("a recognized deny keeps the hold blocked", async () => {
  const kept = await resumeScheduledHold(
    deps({ status: "refused", refusalKind: "approval_denied", reason: "approval denied for release" }),
    "H1",
    record,
    false,
  );
  assert.equal(kept.outcome, "kept");
});
