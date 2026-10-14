import { hashId } from "../util/crypto.ts";
import { orgId as orgIdOf } from "../config.ts";
import { scopeId } from "../types.ts";
import { securityHoldSourceKey } from "../security/security-hold.ts";
import { redactSecretText } from "../security/secret-masking.ts";
import { samePerson } from "../directory/person.ts";
import { scheduledHoldDecider } from "../core/approval-store.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { ScheduledHoldDecision } from "../triggers/security-hold-resume.ts";
import { MAX_REPORT_NOTE_CHARS, type ScreeningReport } from "../security/screening-reports.ts";
import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

export type SecurityHoldReportOutcome =
  | { state: "created" | "updated" | "exists"; report: ScreeningReport }
  | { state: "not_found" | "not_a_hold" | "unavailable" };

export type ScheduledHoldOutcome =
  ({ state: "resolved" } & ScheduledHoldDecision) | { state: "not_found" | "not_owner" | "unavailable" };

const NOTE_SEPARATOR = "\n\n";

export function createSecurityHoldMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<App, "reportSecurityHold" | "resolveScheduledHold" | "recordApprovalCard"> {
  return {
    async reportSecurityHold(requestId, reporterId, note) {
      if (!deps.screeningReports || !deps.approvals) return { state: "unavailable" };
      const record = await deps.approvals.get(requestId);
      if (!record || !(await h.approvalRecordIsCurrent(record))) return { state: "not_found" };
      const decider = scheduledHoldDecider(record);
      if (decider ? !samePerson(decider, reporterId) : !(await visibleToReporter(record, reporterId)))
        return { state: "not_found" };
      const hold = record.securityHold;
      if (!hold) return { state: "not_a_hold" };
      const trimmed = note?.trim().slice(0, MAX_REPORT_NOTE_CHARS);
      const report: ScreeningReport = {
        id: hashId([requestId, reporterId], 32),
        approvalId: requestId,
        sessionId: record.sessionId,
        source: hold.source,
        sourceKey: securityHoldSourceKey(hold.source),
        category: hold.category,
        ...(hold.scheduledTask ? { scheduledTask: hold.scheduledTask } : {}),
        ...(hold.reason ? { reason: hold.reason } : {}),
        ...(hold.evidence ? { evidence: hold.evidence } : {}),
        content: redactSecretText(record.summaryDetail ?? record.screenedOutput?.text ?? ""),
        reporterId,
        ...(trimmed ? { note: trimmed } : {}),
        createdAt: Date.now(),
        status: "open",
      };
      const stored = await deps.screeningReports.putIfAbsent(report.id, report);
      if (stored.createdAt !== report.createdAt) {
        if (!trimmed || stored.note?.split(NOTE_SEPARATOR).includes(trimmed))
          return { state: "exists", report: stored };
        const note = (stored.note ? `${stored.note}${NOTE_SEPARATOR}${trimmed}` : trimmed).slice(
          -MAX_REPORT_NOTE_CHARS,
        );
        const updated = (await deps.screeningReports.merge(report.id, { note, status: "open" })) ?? stored;
        return { state: "updated", report: updated };
      }
      deps.auditLog.record({
        at: Date.now(),
        principalId: reporterId,
        action: "security_screen.report_false_positive",
        resource: report.sourceKey,
        scopeLabel: scopeId("org", orgIdOf()),
        status: "open",
        detail: JSON.stringify({ reportId: report.id, approvalId: requestId, category: report.category }),
      });
      return { state: "created", report };
    },

    async recordApprovalCard(requestId, card) {
      await deps.approvals?.merge(requestId, { card });
    },

    async resolveScheduledHold(requestId, actorId, approved) {
      const record = await deps.approvals?.get(requestId);
      const decider = record ? scheduledHoldDecider(record) : undefined;
      if (!record || !decider || !(await h.approvalRecordIsCurrent(record))) return { state: "not_found" };
      if (!samePerson(decider, actorId)) return { state: "not_owner" };
      if (!deps.resumeScheduledHold) return { state: "unavailable" };
      const decision = await deps.resumeScheduledHold(requestId, record, approved);
      deps.auditLog.record({
        at: Date.now(),
        principalId: actorId,
        action: `security_screen.scheduled_hold_${decision.outcome}`,
        resource: requestId,
        scopeLabel: scopeId("org", orgIdOf()),
        status: decision.outcome,
        detail: JSON.stringify({ cronId: record.securityHold!.scheduledTask!.id }),
      });
      return { state: "resolved", ...decision };
    },
  };

  async function visibleToReporter(record: PendingApprovalRecord, reporterId: string): Promise<boolean> {
    const session = await deps.sessions.get(record.sessionId);
    return !!session && (await h.approvalVisibleToViewer(session, reporterId, record));
  }
}
