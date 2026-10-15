import { cronTriggerAuthority } from "../cron/authority.ts";
import type { Cron, Destination, PendingApprovalRecord, TurnResult } from "../types.ts";
import type { CronStore } from "../cron/cron-store.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { runTrigger, type TriggerDeps } from "./run-trigger.ts";
import { samePerson } from "../directory/person.ts";
import { securityHoldView } from "../security/security-hold.ts";
import { cronFireLogReply } from "../cron/scheduler.ts";

export interface ScheduledHoldDeps extends TriggerDeps {
  crons: Pick<CronStore, "get" | "recordFire" | "latestFireForThread">;
  lock?: Pick<AdvisoryLock, "withLock" | "tryWithLock">;
}

export interface ScheduledHoldDecision {
  outcome: "allowed" | "kept" | "failed";
  message: string;
}

export type ScheduledHoldReason = "owner" | "superseded";

function scheduledHoldFireKey(requestId: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `security-hold:${requestId}:${record.createdAt ?? 0}`;
}

async function destinationLabel(deps: ScheduledHoldDeps, cron: Cron, destination: Destination): Promise<string> {
  if (destination.type === "principal") {
    if (samePerson(destination.target, cron.owner)) return "you";
    const member = await deps.directory?.get(destination.target).catch(() => null);
    return member?.displayName ?? destination.target;
  }
  if (destination.type === "slack" || destination.type === "group") return "the task's channel";
  return "the task's destination";
}

function deniedResult(result: TurnResult): boolean {
  return result.status === "refused" && (result.reason ?? "").startsWith("approval denied");
}

export async function resumeScheduledHold(
  deps: ScheduledHoldDeps,
  requestId: string,
  record: PendingApprovalRecord,
  approved: boolean,
  reason: ScheduledHoldReason = "owner",
): Promise<ScheduledHoldDecision | null> {
  const resumed: { sessionId?: string; reply?: string } = {};
  const task = record.securityHold!.scheduledTask!;
  const held = securityHoldView(record.securityHold!).held;
  const cron = await deps.crons.get(task.id);
  const name = cron?.title ?? task.title ?? task.id;
  let unavailable: string | undefined;
  if (!cron || cron.archived) unavailable = `${name} no longer exists`;
  else if (!cron.enabled && (cron.schedule.everyMs !== undefined || cron.schedule.cron !== undefined))
    unavailable = `${name} is paused`;
  const allow = approved && !unavailable;
  const threadRef = record.request!.conversation.threadRef;
  const fireKey = scheduledHoldFireKey(requestId, record);

  const keep = async (): Promise<ScheduledHoldDecision> => {
    const result = await deps.run({ ...record.request!, approval: { requestId, approved: false } });
    if (!deniedResult(result)) return { outcome: "failed", message: "Already resolved." };
    let message = `Kept blocked: ${held}. This run of ${name} stopped without it and delivered nothing.`;
    if (reason === "superseded")
      message = `Kept blocked: a newer run of ${name} was held on the same content, so this run stopped without it.`;
    else if (unavailable)
      message = `Kept blocked: ${unavailable}, so this run did not continue${approved ? " and nothing was released" : ""}.`;
    return { outcome: "kept", message };
  };

  const allowOnce = async (live: Cron): Promise<ScheduledHoldDecision> => {
    const outcome = await runTrigger(deps, {
      ...cronTriggerAuthority(live),
      input: record.request!.text,
      fireKey,
      surface: "cron",
      threadRef,
      approval: { requestId, approved: true, scope: "once" },
      ...(live.runtime ? { runtime: live.runtime } : {}),
      ...(live.title ? { title: live.title } : {}),
      ...(live.destination ? { destination: live.destination } : {}),
      ...(live.recipientConsent ? { recipientConsent: live.recipientConsent } : {}),
      recipientConsentRequired: live.schedule.everyMs !== undefined || live.schedule.cron !== undefined,
    });
    if (outcome.sessionId) resumed.sessionId = outcome.sessionId;
    if (outcome.reply !== undefined) resumed.reply = cronFireLogReply(outcome.reply);
    if (!outcome.ran)
      return {
        outcome: "failed",
        message: outcome.note ? `The run could not continue: ${outcome.note}.` : "Already resolved.",
      };
    if (outcome.status === "silent")
      return {
        outcome: "allowed",
        message: `Allowed once: the run of ${name} continued and had nothing new to report.`,
      };
    if (outcome.status === "ok" && live.destination && !outcome.note)
      return {
        outcome: "allowed",
        message: `Allowed once: the run of ${name} continued and delivered to ${await destinationLabel(deps, live, live.destination)}.`,
      };
    if (outcome.status === "ok")
      return {
        outcome: "allowed",
        message: `Allowed once: the run of ${name} continued${outcome.note ? ` (${outcome.note})` : ""}.`,
      };
    return {
      outcome: "failed",
      message: `The run could not continue: ${outcome.userNote ?? outcome.note ?? outcome.status ?? "unknown error"}.`,
    };
  };

  if (!cron) return keep();
  const accounted = async (): Promise<ScheduledHoldDecision> => {
    const original = await deps.crons.latestFireForThread(cron.id, threadRef);
    const decision = await (allow ? allowOnce(cron) : keep());
    if (original)
      await deps.crons.recordFire(cron.id, {
        ...original,
        endedAt: Date.now(),
        status: decision.outcome === "allowed" ? "ok" : "refused",
        note: decision.message,
        ...(resumed.sessionId ? { sessionId: resumed.sessionId } : {}),
        ...(resumed.reply !== undefined ? { reply: resumed.reply } : {}),
      });
    return decision;
  };
  const key = `cron-lifecycle:${cron.id}`;
  if (!deps.lock) return accounted();
  if (reason === "superseded") return deps.lock.tryWithLock ? deps.lock.tryWithLock(key, accounted) : null;
  return deps.lock.withLock(key, accounted);
}
