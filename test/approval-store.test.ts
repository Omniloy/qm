import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalDeliveryRecipient,
  claimApproval,
  claimIsLive,
  releaseApprovalClaim,
  createApprovalStore,
  type HeldContentEntry,
} from "../src/core/approval-store.ts";
import { createMemoryMap, requireAtomic } from "../src/persistence/durable-map.ts";
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
    const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
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
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
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
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
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
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
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

test("put only marks a hold from an older fire on the same content; the poller resolves it later", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  const deliveries = createDeliveryStore();
  const superseded: string[] = [];
  const approvals = createApprovalStore(backing, deliveries, {
    heldContent: createMemoryMap<HeldContentEntry>(),
    supersede: async (id) => {
      superseded.push(id);
      await backing.delete(id);
      return "resolved" as const;
    },
  });
  const held = (session: string, createdAt: number, text: string) =>
    cronHold(`cron:c1:fire:${session}`, createdAt, { sessionId: session, screenedOutput: { tool: "execute", text } });
  await approvals.put("A1", held("fire-a", 1, "email from Alice"));
  await approvals.put("A2", held("fire-a", 2, "email from Bob"));
  await approvals.put("A3", held("fire-a", 3, "email from Alice"));
  await approvals.put("B1", held("fire-b", 4, "email from Bob"));
  assert.deepEqual(superseded, [], "put never resolves anything itself");
  assert.equal((await backing.get("A2"))?.supersededBy, "B1");
  assert.equal((await backing.get("A1"))?.supersededBy, undefined, "same fire never supersedes itself");
  assert.equal((await backing.get("A3"))?.supersededBy, undefined, "different content is independent");
  await approvals.put("Z0", held("fire-z", 0, "email from Bob"));
  assert.equal((await backing.get("Z0"))?.supersededBy, "B1", "an out-of-order older fire is marked on arrival");
  assert.ok(!(await deliveries.pending("principal")).some((d) => d.destination.commandApprovalId === "Z0"));

  await approvals.resolveSupersededHolds();
  assert.deepEqual(superseded.sort(), ["A2", "Z0"]);
  assert.equal(await backing.get("A2"), null);
});

test("a superseded hold whose task is busy stays marked and is retried later", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  let busy = true;
  const approvals = createApprovalStore(backing, createDeliveryStore(), {
    heldContent: createMemoryMap<HeldContentEntry>(),
    supersede: async (id) => {
      if (busy) return "busy" as const;
      await backing.delete(id);
      return "resolved" as const;
    },
  });
  const same = { tool: "execute", text: "same output" };
  await approvals.put("A1", cronHold("cron:c1:fire:a", 1, { sessionId: "a", screenedOutput: same }));
  await approvals.put("B1", cronHold("cron:c1:fire:b", 2, { sessionId: "b", screenedOutput: same }));
  await approvals.resolveSupersededHolds();
  const kept = await backing.get("A1");
  assert.equal(kept?.claimedBy, undefined, "the claim is released when the task was busy");
  busy = false;
  await approvals.resolveSupersededHolds();
  assert.equal(await backing.get("A1"), null);
});

test("claims expire, so a crash between claim and resume never strands a hold", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  await backing.put("H1", cronHold("cron:c1:fire:a", 1));
  const [first, second] = await Promise.all([claimApproval(backing, "H1"), claimApproval(backing, "H1")]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(await claimApproval(backing, "missing"), null);
  await backing.merge("H1", { claimedAt: Date.now() - 31 * 60_000 });
  assert.equal(claimIsLive((await backing.get("H1"))!), false);
  assert.ok(await claimApproval(backing, "H1"), "a stale claim is free again");
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(backing, deliveries);
  await backing.merge("H1", { claimedAt: Date.now() - 31 * 60_000 });
  await approvals.deliverPending();
  assert.ok(
    (await deliveries.pending("principal")).some((d) => d.destination.commandApprovalId === "H1"),
    "a hold with a stale claim is delivered again",
  );
});

test("index cleanup keeps entries for holds created during the pass", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  const heldContent = createMemoryMap<HeldContentEntry>();
  const approvals = createApprovalStore(backing, createDeliveryStore(), { heldContent });
  await heldContent.put("gone", { requestId: "R-gone", sessionId: "s", createdAt: 1 });
  await heldContent.put("fresh", { requestId: "R-fresh", sessionId: "s", createdAt: 2 });
  const entries = backing.entries.bind(backing);
  backing.entries = async () => {
    const snapshot = await entries();
    await backing.put("R-fresh", cronHold("cron:c1:fire:x", 2));
    return snapshot;
  };
  await approvals.deliverPending();
  assert.equal(await heldContent.get("gone"), null);
  assert.ok(await heldContent.get("fresh"), "an entry whose hold appeared mid-pass survives");
});

test("a superseded hold that can no longer be denied is dropped instead of retried forever", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  let calls = 0;
  const approvals = createApprovalStore(backing, createDeliveryStore(), {
    heldContent: createMemoryMap<HeldContentEntry>(),
    supersede: async () => {
      calls++;
      return "unresolvable" as const;
    },
  });
  const same = { tool: "execute", text: "same output" };
  await approvals.put("A", cronHold("cron:c1:fire:a", 1, { sessionId: "a", screenedOutput: same }));
  await approvals.put("B", cronHold("cron:c1:fire:b", 2, { sessionId: "b", screenedOutput: same }));
  for (let i = 0; i < 5; i++) await approvals.resolveSupersededHolds();
  assert.equal(calls, 1);
  assert.equal(await backing.get("A"), null, "the hold stays blocked because its record is gone");
  assert.ok(await backing.get("B"));
});

test("releasing a claim only clears the claim it owns", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  await backing.put("A", cronHold("cron:c1:fire:a", 1));
  const first = await claimApproval(backing, "A");
  await backing.merge("A", { claimedAt: Date.now() - 31 * 60_000 });
  const second = await claimApproval(backing, "A");
  assert.ok(first && second && first.claimedBy !== second.claimedBy, "a stale claim was taken over");
  await releaseApprovalClaim(backing, "A", first.claimedBy);
  assert.equal(await claimApproval(backing, "A"), null, "the stale owner's release left the live claim alone");
  await releaseApprovalClaim(backing, "A", second.claimedBy);
  assert.ok(await claimApproval(backing, "A"));
});

test("a card retired while a decision was pending is reposted once the claim is released", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(backing, deliveries);
  await approvals.put("H1", cronHold("cron:c1:fire:a", 1, { card: { channel: "D1", ts: "1.1" } }));
  const keys = async () =>
    (await deliveries.pending("principal"))
      .filter((d) => d.destination.commandApprovalId === "H1")
      .map((d) => d.idempotencyKey);
  assert.deepEqual(await keys(), ["command-approval:H1:1"]);
  const claimed = await claimApproval(backing, "H1");
  await backing.merge("H1", { cardRetired: true });
  await releaseApprovalClaim(backing, "H1", claimed!.claimedBy);
  const released = (await backing.get("H1"))!;
  assert.equal(released.deliveryRound, 1);
  assert.equal(released.card, undefined);
  await approvals.deliverPending();
  assert.deepEqual(await keys(), ["command-approval:H1:1", "command-approval:H1:1:1"], "a fresh card is queued");
  const kept = await claimApproval(backing, "H1");
  await releaseApprovalClaim(backing, "H1", kept!.claimedBy);
  assert.equal((await backing.get("H1"))!.deliveryRound, 1, "a card that was never retired is not reposted");
});

test("a retired card is reposted when an expired claim is noticed, by a new claim or by the sweep", async () => {
  const backing = requireAtomic(createMemoryMap<PendingApprovalRecord>());
  const deliveries = createDeliveryStore();
  const approvals = createApprovalStore(backing, deliveries);
  await approvals.put("H1", cronHold("cron:c1:fire:a", 1, { card: { channel: "D1", ts: "1.1" } }));
  const stale = { claimedBy: "dead-instance", claimedAt: Date.now() - 31 * 60_000, cardRetired: true };
  await backing.merge("H1", stale);
  const reclaimed = await claimApproval(backing, "H1");
  assert.equal(reclaimed?.deliveryRound, 1, "taking over an expired claim reposts the retired card");
  assert.equal(reclaimed?.card, undefined);

  await backing.merge("H1", { ...stale, deliveryRound: 1 });
  await approvals.deliverPending();
  assert.equal((await backing.get("H1"))?.deliveryRound, 2);
  assert.ok(
    (await deliveries.pending("principal")).some((d) => d.idempotencyKey === "command-approval:H1:1:2"),
    "the sweep queues a fresh card when it notices the expired claim",
  );
});

test("approval stores refuse a backing map without atomic updates", () => {
  const plain = { ...createMemoryMap<PendingApprovalRecord>(), update: undefined, deleteIf: undefined };
  assert.throws(() => createApprovalStore(plain, createDeliveryStore()), /atomic update/);
});
