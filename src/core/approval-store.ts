import { randomUUID } from "node:crypto";
import { swallowAs } from "../util/errors.ts";
import { hashId } from "../util/crypto.ts";
import { isScheduledHoldRecord } from "../../plugins/chassis/src/scheduled-hold.ts";
import type { PendingApprovalRecord } from "../types.ts";
import { requireAtomic, type AtomicDurableMap, type DurableMap } from "../persistence/durable-map.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";

export function approvalDeliveryKey(
  id: string,
  record: Pick<PendingApprovalRecord, "createdAt" | "deliveryRound">,
): string {
  const round = record.deliveryRound ? `:${record.deliveryRound}` : "";
  return `command-approval:${id}:${record.createdAt ?? 0}${round}`;
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

function withFreshCard(record: PendingApprovalRecord): PendingApprovalRecord {
  if (!record.cardRetired || claimIsLive(record)) return record;
  const { cardRetired: _retired, ...rest } = record;
  return { ...rest, deliveryRound: (record.deliveryRound ?? 0) + 1 };
}

export async function claimApproval(
  store: AtomicDurableMap<PendingApprovalRecord>,
  id: string,
): Promise<PendingApprovalRecord | null> {
  const token = randomUUID();
  const claimed = await store.update(id, (record) =>
    claimIsLive(record) ? record : { ...withFreshCard(record), claimedBy: token, claimedAt: Date.now() },
  );
  return claimed?.claimedBy === token ? claimed : null;
}

export async function releaseApprovalClaim(
  store: AtomicDurableMap<PendingApprovalRecord>,
  id: string,
  token: string | undefined,
): Promise<void> {
  const release = (record: PendingApprovalRecord): PendingApprovalRecord => {
    if (!token || record.claimedBy !== token) return record;
    const { claimedBy: _claim, claimedAt: _at, ...rest } = record;
    return withFreshCard(rest);
  };
  await store.update(id, release);
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

type SupersedeOutcome = "resolved" | "busy" | "unresolvable";

export interface ApprovalStoreOptions {
  heldContent?: HeldContentIndex;
  supersede?: (id: string, record: PendingApprovalRecord) => Promise<SupersedeOutcome>;
}

export function createApprovalStore(
  store: DurableMap<PendingApprovalRecord>,
  deliveries: Pick<DeliveryStore, "enqueue">,
  opts: ApprovalStoreOptions = {},
) {
  const backing = requireAtomic(store);
  const heldContent = opts.heldContent ? requireAtomic(opts.heldContent) : undefined;
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
    if (!key || !heldContent) return false;
    const entry = { requestId: id, sessionId: record.sessionId, createdAt: record.createdAt ?? 0 };
    const previous = await heldContent.get(key);
    const replaces = !previous || previous.requestId === id || previous.sessionId === record.sessionId;
    if (replaces || previous.createdAt <= entry.createdAt) {
      await heldContent.put(key, entry);
      if (!replaces) await markSuperseded(previous.requestId, id);
      return false;
    }
    await markSuperseded(id, previous.requestId);
    return true;
  }

  async function resolveSuperseded(id: string): Promise<void> {
    const claimed = await claimApproval(backing, id);
    if (!claimed) return;
    let outcome: SupersedeOutcome = "busy";
    try {
      outcome = opts.supersede ? await opts.supersede(id, claimed) : "unresolvable";
    } finally {
      if (outcome === "unresolvable") {
        await backing.deleteIf(id, (record) => record.claimedBy === claimed.claimedBy);
      } else if (outcome === "busy") await releaseApprovalClaim(backing, id, claimed.claimedBy);
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
      for (const [id, stored] of entries) {
        if (stored.supersededBy || claimIsLive(stored)) continue;
        const record = stored.cardRetired ? await backing.update(id, withFreshCard) : stored;
        if (record) await deliver(id, record);
      }
      if (!heldContent) return;
      const live = new Set(entries.map(([id]) => id));
      for (const [key, entry] of await heldContent.entries())
        if (!live.has(entry.requestId) && !(await backing.get(entry.requestId)))
          await heldContent.deleteIf(key, (current) => current.requestId === entry.requestId);
    },
    async resolveSupersededHolds(): Promise<void> {
      for (const [id, record] of await backing.entries())
        if (record.supersededBy && !claimIsLive(record))
          await resolveSuperseded(id).catch(swallowAs("approvals: resolve superseded hold", undefined));
    },
  };
}
