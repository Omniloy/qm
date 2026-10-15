import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalDeliveryRecipient,
  claimApproval,
  createApprovalStore,
  type HeldContentEntry,
} from "../src/core/approval-store.ts";
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

function cronHold(
  threadRef: string,
  createdAt: number,
  extra: Partial<PendingApprovalRecord> = {},
): PendingApprovalRecord {
  const base = record(threadRef, createdAt);
  return {
    ...base,
    request: { ...base.request!, surface: "cron", triggered: true, actor: { externalId: "U-floor" } },
    securityHold: {
      source: { kind: "command", command: "jira-followup --board MAR" },
      category: "credential_request",
      scheduledTask: { id: "c1", title: "Jira follow-ups", ownerId: "U-owner" },
    },
    ...extra,
  };
}

test("a scheduled task's hold goes to the cron owner, not the acting member; legacy cron approvals stay put", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(backing, deliveries);
  await approvals.put("H1", cronHold("cron:c1:fire:a", 1));
  const legacy = cronHold("cron:c2:fire:a", 1);
  delete legacy.securityHold;
  await approvals.put("L1", legacy);
  await approvals.deliverPending();
  const pending = await deliveries.pending("principal");
  assert.deepEqual(
    pending.map((d) => [d.destination.commandApprovalId, d.destination.target]),
    [["H1", "U-owner"]],
  );
  assert.match(pending[0]!.text, /scheduled task paused/);
  assert.equal(approvalDeliveryRecipient(cronHold("x", 1)), "U-owner");
  const ownerless = cronHold("x", 1);
  delete ownerless.securityHold!.scheduledTask!.ownerId;
  assert.equal(approvalDeliveryRecipient(ownerless), "U-floor", "the actor is the fallback when the cron has no owner");
});

test("only a different fire held on the same content supersedes, through the supersede hook", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  const deliveries = createDeliveryStore();
  const superseded: string[] = [];
  const approvals = createApprovalStore(backing, deliveries, {
    heldContent: createMemoryMap<HeldContentEntry>(),
    supersede: async (id) => {
      superseded.push(id);
      await backing.delete(id);
    },
  });
  const held = (session: string, createdAt: number, text: string, extra: Partial<PendingApprovalRecord> = {}) =>
    cronHold(`cron:c1:fire:${session}`, createdAt, {
      sessionId: session,
      screenedOutput: { tool: "execute", text },
      ...extra,
    });
  await approvals.put("A1", held("fire-a", 1, "email from Alice", { card: { channel: "D1", ts: "100.1" } }));
  await approvals.put("A2", held("fire-a", 2, "email from Bob"));
  await approvals.put("A3", held("fire-a", 3, "email from Alice"));
  assert.deepEqual(superseded, [], "holds within one fire never supersede each other, even on the same content");
  await approvals.put("B1", held("fire-b", 4, "email from Bob"));
  assert.deepEqual(superseded, ["A2"], "a later fire supersedes only the hold on the same content");
  assert.ok(await backing.get("A1"), "a different email in the older fire stays pending");
  await approvals.put("C1", held("fire-c", 5, "email from Alice"));
  assert.deepEqual(superseded.sort(), ["A2", "A3"]);
  const update = (await deliveries.pending("principal")).find((d) => d.destination.cardUpdate);
  assert.equal(update, undefined, "A3 never had a posted card");

  await approvals.put("D1", held("fire-d", 6, "email from Carol", { card: { channel: "D9", ts: "9.9" } }));
  await approvals.put("E1", held("fire-e", 7, "email from Carol"));
  const rewrite = (await deliveries.pending("principal")).find((d) => d.destination.cardUpdate);
  assert.deepEqual(rewrite?.destination.cardUpdate, { channel: "D9", ts: "9.9" });
  assert.match(rewrite!.text, /held on the same content/);

  await approvals.put("Z0", held("fire-z", 0, "email from Carol"));
  assert.ok((superseded as string[]).includes("Z0"), "an out-of-order older fire is superseded on arrival");
  assert.ok(!(await deliveries.pending("principal")).some((d) => d.destination.commandApprovalId === "Z0"));
});

test("a claimed hold cannot be claimed twice or superseded", async () => {
  const backing = createMemoryMap<PendingApprovalRecord>();
  await backing.put("H1", cronHold("cron:c1:fire:a", 1));
  const [first, second] = await Promise.all([claimApproval(backing, "H1"), claimApproval(backing, "H1")]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(await claimApproval(backing, "missing"), null);
});
