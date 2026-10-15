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

const CLAIM_TTL_MS = 30 * 60_000;

export function claimIsLive(record: Pick<PendingApprovalRecord, "claimedBy" | "claimedAt">, now = Date.now()): boolean {
  return record.claimedBy !== undefined && (record.claimedAt ?? 0) > now - CLAIM_TTL_MS;
}

export async function claimApproval(
  store: DurableMap<PendingApprovalRecord>,
  id: string,
): Promise<PendingApprovalRecord | null> {
  const token = randomUUID();
  const claim = (record: PendingApprovalRecord): PendingApprovalRecord =>
    claimIsLive(record) ? record : { ...record, claimedBy: token, claimedAt: Date.now() };
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
  const release = ({ claimedBy: _claim, claimedAt: _at, ...rest }: PendingApprovalRecord): PendingApprovalRecord =>
    rest;
  if (store.update) {
    await store.update(id, release);
    return;
  }
  const current = await store.get(id);
  if (current) await store.put(id, release(current));
}

export async function announceHoldDecision(
  deliveries: Pick<DeliveryStore, "enqueue">,
  id: string,
  record: PendingApprovalRecord,
  message: string,
): Promise<void> {
  const recipient = approvalDeliveryRecipient(record);
  if (!record.card || !recipient) return;
  await deliveries.enqueue({
    destination: { ...principalDestination(recipient, recipient), cardUpdate: record.card },
    text: message,
    idempotencyKey: `command-approval-decided:${id}:${record.createdAt ?? 0}`,
  });
}

export interface ApprovalStoreOptions {
  heldContent?: HeldContentIndex;
  supersede?: (id: string, record: PendingApprovalRecord) => Promise<boolean>;
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

  async function markSuperseded(id: string, by: string): Promise<void> {
    await backing.merge(id, { supersededBy: by });
  }

  async function indexHeldContent(id: string, record: PendingApprovalRecord): Promise<boolean> {
    const key = heldContentKey(record);
    if (!key || !opts.heldContent) return false;
    const entry = { requestId: id, sessionId: record.sessionId, createdAt: record.createdAt ?? 0 };
    const previous = await opts.heldContent.get(key);
    const replaces = !previous || previous.requestId === id || previous.sessionId === record.sessionId;
    if (replaces || previous.createdAt <= entry.createdAt) {
      await opts.heldContent.put(key, entry);
      if (!replaces) await markSuperseded(previous.requestId, id);
      return false;
    }
    await markSuperseded(id, previous.requestId);
    return true;
  }

  async function resolveSuperseded(id: string): Promise<void> {
    const claimed = await claimApproval(backing, id);
    if (!claimed) return;
    let resolved = false;
    try {
      if (opts.supersede) resolved = await opts.supersede(id, claimed);
      else {
        await backing.delete(id);
        resolved = true;
      }
    } finally {
      if (!resolved) await releaseApprovalClaim(backing, id);
    }
  }

  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      const superseded = await indexHeldContent(id, record).catch(swallowAs("approvals: index held content", false));
      if (superseded) return;
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending(): Promise<void> {
      const entries = await backing.entries();
      for (const [id, record] of entries) if (!record.supersededBy && !claimIsLive(record)) await deliver(id, record);
      if (!opts.heldContent) return;
      const live = new Set(entries.map(([id]) => id));
      for (const [key, entry] of await opts.heldContent.entries())
        if (!live.has(entry.requestId) && !(await backing.get(entry.requestId)))
          await opts.heldContent.deleteIf?.(key, (current) => current.requestId === entry.requestId);
    },
    async resolveSupersededHolds(): Promise<void> {
      for (const [id, record] of await backing.entries())
        if (record.supersededBy && !claimIsLive(record))
          await resolveSuperseded(id).catch(swallowAs("approvals: resolve superseded hold", undefined));
    },
  };
}
