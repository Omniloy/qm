import { randomUUID } from "node:crypto";
import { swallowAs } from "../util/errors.ts";
import { hashId } from "../util/crypto.ts";
import { isScheduledHoldRecord } from "../../plugins/chassis/src/scheduled-hold.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function scheduledHoldDecider(
  record: Pick<PendingApprovalRecord, "request" | "securityHold">,
): string | undefined {
  if (!isScheduledHoldRecord(record)) return undefined;
  return record.securityHold!.scheduledTask!.ownerId ?? record.request!.actor.externalId;
}

export function approvalDeliveryRecipient(
  record: Pick<PendingApprovalRecord, "request" | "securityHold">,
): string | undefined {
  const id = scheduledHoldDecider(record) ?? record.request?.actor.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

export interface HeldContentEntry {
  requestId: string;
  sessionId: string;
  createdAt: number;
}

type HeldContentIndex = DurableMap<HeldContentEntry>;

function heldContentKey(
  record: Pick<PendingApprovalRecord, "request" | "securityHold" | "screenedOutput" | "summaryDetail">,
): string | undefined {
  if (!isScheduledHoldRecord(record)) return undefined;
  const content = record.screenedOutput?.text ?? record.summaryDetail;
  if (content === undefined) return undefined;
  return `${record.securityHold!.scheduledTask!.id}:${hashId([content], 32)}`;
}

export async function claimApproval(
  store: DurableMap<PendingApprovalRecord>,
  id: string,
): Promise<PendingApprovalRecord | null> {
  const token = randomUUID();
  const claim = (record: PendingApprovalRecord): PendingApprovalRecord =>
    record.claimedBy ? record : { ...record, claimedBy: token };
  let claimed: PendingApprovalRecord | null;
  if (store.update) claimed = await store.update(id, claim);
  else {
    const current = await store.get(id);
    claimed = current ? claim(current) : null;
    if (claimed && claimed !== current) await store.put(id, claimed);
  }
  return claimed?.claimedBy === token ? claimed : null;
}

export async function releaseApprovalClaim(store: DurableMap<PendingApprovalRecord>, id: string): Promise<void> {
  if (store.update) {
    await store.update(id, ({ claimedBy: _claim, ...rest }) => rest);
    return;
  }
  const current = await store.get(id);
  if (current) {
    const { claimedBy: _claim, ...rest } = current;
    await store.put(id, rest);
  }
}

export interface ApprovalStoreOptions {
  heldContent?: HeldContentIndex;
  supersede?: (id: string, record: PendingApprovalRecord) => Promise<void>;
}

export function createApprovalStore(
  backing: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
  opts: ApprovalStoreOptions = {},
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

  async function supersede(id: string): Promise<void> {
    const record = await claimApproval(backing, id);
    if (!record) return;
    try {
      if (opts.supersede) await opts.supersede(id, record);
      else await backing.delete(id);
    } catch (error) {
      await releaseApprovalClaim(backing, id);
      throw error;
    }
    const recipient = approvalDeliveryRecipient(record);
    if (!record.card || !recipient) return;
    const task = record.securityHold!.scheduledTask!;
    await deliveries.enqueue({
      destination: { ...principalDestination(recipient, recipient), cardUpdate: record.card },
      text: `Superseded: a newer run of ${task.title ?? task.id} was held on the same content, so this run was kept blocked. Answer the newest card instead.`,
      idempotencyKey: `command-approval-superseded:${id}`,
    });
  }

  async function indexHeldContent(id: string, record: PendingApprovalRecord): Promise<boolean> {
    const key = heldContentKey(record);
    if (!key || !opts.heldContent) return false;
    const entry = { requestId: id, sessionId: record.sessionId, createdAt: record.createdAt ?? 0 };
    const previous = await opts.heldContent.get(key);
    const replaces = !previous || previous.requestId === id || previous.sessionId === record.sessionId;
    if (replaces || previous.createdAt <= entry.createdAt) {
      await opts.heldContent.put(key, entry);
      if (!replaces) await supersede(previous.requestId);
      return false;
    }
    await supersede(id);
    return true;
  }

  async function stale(id: string, record: PendingApprovalRecord): Promise<boolean> {
    const key = heldContentKey(record);
    if (!key || !opts.heldContent) return false;
    const latest = await opts.heldContent.get(key);
    return latest !== null && latest.requestId !== id && latest.sessionId !== record.sessionId;
  }

  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      const superseded = await indexHeldContent(id, record).catch(swallowAs("approvals: supersede holds", false));
      if (superseded) return;
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      const entries = await backing.entries();
      for (const [id, record] of entries) {
        if (record.claimedBy) continue;
        if (await stale(id, record)) {
          await supersede(id).catch(swallowAs("approvals: supersede stale hold", undefined));
          continue;
        }
        await deliver(id, record);
      }
      if (!opts.heldContent) return;
      const live = new Set(entries.map(([id]) => id));
      for (const [key, entry] of await opts.heldContent.entries())
        if (!live.has(entry.requestId)) await opts.heldContent.delete(key);
    },
  };
}
