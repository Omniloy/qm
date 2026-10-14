import { swallowAs } from "../util/errors.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";
import { securityHoldSourceKey } from "../security/security-hold.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
) {
  async function earlierHoldPending(id: string, record: PendingApprovalRecord): Promise<boolean> {
    const task = record.securityHold?.scheduledTask?.id;
    if (!task || !record.securityHold) return false;
    const key = securityHoldSourceKey(record.securityHold.source);
    return (await backing.entries()).some(
      ([otherId, other]) =>
        otherId !== id &&
        other.securityHold?.scheduledTask?.id === task &&
        securityHoldSourceKey(other.securityHold.source) === key &&
        (other.createdAt ?? 0) < (record.createdAt ?? 0),
    );
  }

  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const unattendedHold = record.request?.surface === "cron" && record.securityHold !== undefined;
    if (!record.request || (record.request.surface !== "slack" && !unattendedHold)) return;
    if (unattendedHold && (await earlierHoldPending(id, record))) return;
    const actorId = approvalDeliveryRecipient(record.request.actor);
    if (!actorId) return;
    await deliveries.enqueue({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(record.request.slackSource
          ? { slackAccountId: record.request.slackSource.accountId, slackTeamId: record.request.slackSource.teamId }
          : {}),
      },
      text: unattendedHold
        ? `A scheduled task paused for your OK: ${record.summary ?? record.command}`
        : `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      for (const [id, record] of await backing.entries()) await deliver(id, record);
    },
  };
}
