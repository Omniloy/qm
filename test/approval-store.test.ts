import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalStore } from "../src/core/approval-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { PendingApprovalRecord } from "../src/types.ts";

function record(threadRef: string, createdAt = 1): PendingApprovalRecord {
  return {
    sessionId: threadRef,
    command: "publish",
    createdAt,
    request: {
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "publish report",
    },
    kind: "input",
    grantModes: { session: false, always: false },
  };
}

for (const threadRef of ["dm:D1", "agent:main:subagent:child"]) {
  test(`saving approval immediately delivers a native request for ${threadRef}`, async () => {
    const backing = createMemoryMap<PendingApprovalRecord>();
    const deliveries = createDeliveryStore();
    const approvals = createApprovalStore(backing, deliveries);
    await approvals.put("A1", record(threadRef));
    const [delivery] = await deliveries.pending("principal");
    assert.equal(delivery?.destination.commandApprovalId, "A1");
    assert.equal(delivery?.destination.target, "U1");
    assert.deepEqual((await backing.get("A1"))?.grantModes, { session: false, always: false });
    await approvals.deliverPending();
    assert.equal((await deliveries.pending("principal")).length, 1);
    await deliveries.ack(delivery!.id, Date.now());
    await approvals.take("A1");
    await approvals.put("A1", record(threadRef, 2));
    assert.equal((await deliveries.pending("principal")).length, 1);
    assert.notEqual((await deliveries.pending("principal"))[0]!.id, delivery!.id);
  });
}

test("persisted approvals recover after enqueue failure and restart without failing the turn", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const failed = createApprovalStore(backing, {
    enqueue: async () => {
      throw new Error("delivery unavailable");
    },
  });
  await failed.put("A1", record("agent:main:subagent:child"));
  assert.ok(await backing.get("A1"));
  const deliveries = createDeliveryStore();
  const restarted = createApprovalStore(backing, deliveries);
  await restarted.deliverPending();
  await restarted.deliverPending();
  assert.equal((await deliveries.pending("principal")).length, 1);
});

test("web approvals remain on their native surface", async () => {
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(createMemoryMap<PendingApprovalRecord>(), deliveries);
  const approval = record("web:U1");
  approval.request!.surface = "web";
  await approvals.put("A1", approval);
  await approvals.deliverPending();
  assert.equal((await deliveries.pending("principal")).length, 0);
});

test("system approvals stay pending without enqueuing or reviving an impossible Slack DM", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore({ maxAgeMs: 0 });
  const approvals = createApprovalStore(backing, deliveries);
  const approval = record("slack:C1:ambient:1.0");
  approval.request!.actor.externalId = "system:ambient:acme";
  const stale = await deliveries.enqueue({
    destination: { type: "principal", target: "system:ambient:acme", commandApprovalId: "A1" },
    text: "Approval needed: publish",
    idempotencyKey: "command-approval:A1:1",
  });
  await deliveries.claimPending("principal", 1);
  const expiredAt = (await deliveries.get(stale.id))?.expiredAt;
  assert.ok(expiredAt);

  await approvals.put("A1", approval);
  await approvals.put("A2", approval);
  await approvals.deliverPending();
  await createApprovalStore(backing, deliveries).deliverPending();

  assert.deepEqual(await backing.get("A1"), approval, "the protected action still requires approval");
  assert.deepEqual(await backing.get("A2"), approval);
  assert.deepEqual(await deliveries.pending("principal"), []);
  assert.equal((await deliveries.get(stale.id))?.expiredAt, expiredAt, "a sweep must not revive the stale DM");
});

test("a scheduled task's security hold is sent to the owner's DM, other unattended approvals are not", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(backing, deliveries);
  const cron = (threadRef: string, held: boolean): PendingApprovalRecord => ({
    ...record(threadRef),
    request: { ...record(threadRef).request!, surface: "cron", triggered: true },
    ...(held
      ? {
          securityHold: {
            source: { kind: "command", command: "jira-followup --board MAR" },
            step: "Running a command · scheduled task Jira follow-ups",
            category: "credential_request",
            scheduledTask: { id: "c1", title: "Jira follow-ups" },
          },
        }
      : {}),
  });
  await approvals.put("H1", cron("cron:c1:fire:a", true));
  await approvals.put("H2", cron("cron:c1:fire:b", false));
  await approvals.deliverPending();
  const pending = await deliveries.pending("principal");
  assert.deepEqual(
    pending.map((d) => [d.destination.commandApprovalId, d.destination.target]),
    [["H1", "U1"]],
    "only the structured hold reaches the owner; legacy unattended approvals stay where they were",
  );
  assert.match(pending[0]!.text, /scheduled task paused/);
});

test("repeat fires of a task held on the same source send the owner one card at a time", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(backing, deliveries);
  const fire = (threadRef: string, createdAt: number): PendingApprovalRecord => ({
    ...record(threadRef, createdAt),
    request: { ...record(threadRef).request!, surface: "cron", triggered: true },
    securityHold: {
      source: { kind: "command", command: "jira-followup" },
      step: "Running a command · scheduled task c1",
      category: "credential_request",
      scheduledTask: { id: "c1" },
    },
  });
  await approvals.put("F1", fire("cron:c1:fire:a", 1));
  await approvals.put("F2", fire("cron:c1:fire:b", 2));
  await approvals.put("F3", fire("cron:c1:fire:c", 3));
  await approvals.deliverPending();
  assert.deepEqual(
    (await deliveries.pending("principal")).map((d) => d.destination.commandApprovalId),
    ["F1"],
  );
  await approvals.take("F1");
  await approvals.deliverPending();
  assert.deepEqual(
    (await deliveries.pending("principal")).map((d) => d.destination.commandApprovalId).sort(),
    ["F1", "F2"],
    "once the first is resolved the next waiting hold is delivered",
  );
});
