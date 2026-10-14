import { hashId } from "../util/crypto.ts";
import { orgId as orgIdOf } from "../config.ts";
import { scopeId } from "../types.ts";
import { securityHoldSourceKey } from "../security/security-hold.ts";
import { MAX_REPORT_NOTE_CHARS, type ScreeningReport } from "../security/screening-reports.ts";
import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

export type SecurityHoldReportOutcome =
  { state: "created" | "exists"; report: ScreeningReport } | { state: "not_found" | "not_a_hold" | "unavailable" };

export function createSecurityHoldMethods(deps: AppDeps, h: AppHelpers): Pick<App, "reportSecurityHold"> {
  return {
    async reportSecurityHold(requestId, reporterId, note) {
      if (!deps.screeningReports || !deps.approvals) return { state: "unavailable" };
      const record = await deps.approvals.get(requestId);
      if (!record || !(await h.approvalRecordIsCurrent(record))) return { state: "not_found" };
      const session = await deps.sessions.get(record.sessionId);
      if (!session || !(await h.approvalVisibleToViewer(session, reporterId, record))) return { state: "not_found" };
      const hold = record.securityHold;
      if (!hold) return { state: "not_a_hold" };
      const trimmed = note?.trim().slice(0, MAX_REPORT_NOTE_CHARS);
      const report: ScreeningReport = {
        id: hashId([requestId, reporterId], 32),
        approvalId: requestId,
        sessionId: record.sessionId,
        source: hold.source,
        sourceKey: securityHoldSourceKey(hold.source),
        step: hold.step,
        category: hold.category,
        ...(hold.reason ? { reason: hold.reason } : {}),
        ...(hold.evidence ? { evidence: hold.evidence } : {}),
        content: record.summaryDetail ?? record.screenedOutput?.text ?? "",
        reporterId,
        ...(trimmed ? { note: trimmed } : {}),
        createdAt: Date.now(),
        status: "open",
      };
      const stored = await deps.screeningReports.putIfAbsent(report.id, report);
      if (stored.createdAt !== report.createdAt || stored.note !== report.note)
        return { state: "exists", report: stored };
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
  };
}
