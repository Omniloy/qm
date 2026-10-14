import { swallowAs } from "../util/errors.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";
import { securityHoldSourceKey } from "../security/security-hold.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function scheduledHoldDecider(
  record: Pick<PendingApprovalRecord, "request" | "securityHold">,
): string | undefined {
  if (record.request?.surface !== "cron" || !record.securityHold?.scheduledTask) return undefined;
  return record.securityHold.scheduledTask.ownerId ?? record.request.actor.externalId;
}

export function approvalDeliveryRecipient(
  record: Pick<PendingApprovalRecord, "request" | "securityHold">,
): string | undefined {
  const id = scheduledHoldDecider(record) ?? record.request?.actor.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

function holdGroup(record: PendingApprovalRecord): string | undefined {
  if (!scheduledHoldDecider(record)) return undefined;
  return `${record.securityHold!.scheduledTask!.id}\u0000${securityHoldSourceKey(record.securityHold!.source)}`;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
) {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const scheduledHold = scheduledHoldDecider(record) !== undefined;
    if (!record.request || (record.request.surface !== "slack" && !scheduledHold)) return;
    const recipient = approvalDeliveryRecipient(record);
    if (!recipient) return;
    await deliveries.enqueue({
      destination: {
        ...principalDestination(recipient, recipient),
        commandApprovalId: id,
        ...(record.request.slackSource
          ? { slackAccountId: record.request.slackSource.accountId, slackTeamId: record.request.slackSource.teamId }
          : {}),
      },
      text: scheduledHold
        ? `A scheduled task paused for your OK: ${record.summary ?? record.command}`
        : `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }

  async function supersede(entries: ReadonlyArray<[string, PendingApprovalRecord]>): Promise<Set<string>> {
    const latest = new Map<string, [string, PendingApprovalRecord]>();
    for (const entry of entries) {
      const group = holdGroup(entry[1]);
      if (!group) continue;
      const current = latest.get(group);
      if (!current || (entry[1].createdAt ?? 0) > (current[1].createdAt ?? 0)) latest.set(group, entry);
    }
    const superseded = new Set<string>();
    for (const [id, record] of entries) {
      const group = holdGroup(record);
      if (!group || latest.get(group)![0] === id) continue;
      superseded.add(id);
      if (!(await backing.take(id))) continue;
      const recipient = approvalDeliveryRecipient(record);
      if (!record.card || !recipient) continue;
      const task = record.securityHold!.scheduledTask!;
      await deliveries.enqueue({
        destination: { ...principalDestination(recipient, recipient), cardUpdate: record.card },
        text: `Superseded: a newer run of ${task.title ?? task.id} was held on the same content, so this run was kept blocked. Answer the newest card instead.`,
        idempotencyKey: `command-approval-superseded:${id}`,
      });
    }
    return superseded;
  }

  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      const superseded = holdGroup(record)
        ? await supersede(await backing.entries()).catch(swallowAs("approvals: supersede holds", new Set<string>()))
        : new Set<string>();
      if (superseded.has(id)) return;
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      const entries = await backing.entries();
      const superseded = await supersede(entries);
      for (const [id, record] of entries) if (!superseded.has(id)) await deliver(id, record);
    },
  };
}
