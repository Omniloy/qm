import { cronTriggerAuthority } from "../cron/authority.ts";
import type { Cron, Destination, PendingApprovalRecord } from "../types.ts";
import { runTrigger, type TriggerDeps } from "./run-trigger.ts";
import { samePerson } from "../directory/person.ts";
import { securityHoldView } from "../security/security-hold.ts";

export interface ScheduledHoldDeps extends TriggerDeps {
  getCron: (id: string) => Promise<Cron | null>;
}

export interface ScheduledHoldDecision {
  outcome: "allowed" | "kept";
  message: string;
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

export async function resumeScheduledHold(
  deps: ScheduledHoldDeps,
  requestId: string,
  record: PendingApprovalRecord,
  approved: boolean,
): Promise<ScheduledHoldDecision> {
  const hold = record.securityHold!;
  const task = hold.scheduledTask!;
  const view = securityHoldView(hold);
  const name = task.title ?? task.id;
  const kept: ScheduledHoldDecision = {
    outcome: "kept",
    message: `Kept blocked: ${view.held}. This run of ${name} stopped without it and delivered nothing.`,
  };
  const approval = { requestId, approved, ...(approved ? { scope: "once" as const } : {}) };
  const cron = await deps.getCron(task.id);
  if (!cron || cron.archived) {
    await deps.run({ ...record.request!, approval });
    return approved
      ? { outcome: "allowed", message: `Allowed once, but ${name} no longer exists, so the run could not continue.` }
      : kept;
  }
  const outcome = await runTrigger(deps, {
    ...cronTriggerAuthority(cron),
    input: record.request!.text,
    fireKey: `security-hold:${requestId}:${approved ? "allow" : "keep"}`,
    surface: "cron",
    threadRef: record.request!.conversation.threadRef,
    approval,
    ...(cron.runtime ? { runtime: cron.runtime } : {}),
    ...(cron.title ? { title: cron.title } : {}),
    ...(cron.destination ? { destination: cron.destination } : {}),
    ...(cron.recipientConsent ? { recipientConsent: cron.recipientConsent } : {}),
    recipientConsentRequired: cron.schedule.everyMs !== undefined || cron.schedule.cron !== undefined,
  });
  if (!approved) return kept;
  if (!outcome.ran)
    return {
      outcome: "allowed",
      message: outcome.note ? `Allowed once, but the run could not continue: ${outcome.note}.` : "Already resolved.",
    };
  if (outcome.status === "silent")
    return { outcome: "allowed", message: `Allowed once: the run of ${name} continued and had nothing new to report.` };
  if (outcome.status === "ok" && cron.destination && !outcome.note)
    return {
      outcome: "allowed",
      message: `Allowed once: the run of ${name} continued and delivered to ${await destinationLabel(deps, cron, cron.destination)}.`,
    };
  if (outcome.status === "ok")
    return {
      outcome: "allowed",
      message: `Allowed once: the run of ${name} continued${outcome.note ? ` (${outcome.note})` : ""}.`,
    };
  return {
    outcome: "allowed",
    message: `Allowed once, but the run could not continue: ${outcome.userNote ?? outcome.note ?? outcome.status ?? "unknown error"}.`,
  };
}
