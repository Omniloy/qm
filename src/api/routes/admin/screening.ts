import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { isObj } from "../../../util/objects.ts";
import { skillIdentity } from "../../../skills/skill-store.ts";
import { SECURITY_CATEGORY_LABELS, securityHoldSourceLabel } from "../../../security/security-hold.ts";
import {
  SCREENING_REPORT_STATUSES,
  skillTrustKey,
  type ScreeningReport,
  type ScreeningReportStatus,
  type SkillTrust,
} from "../../../security/screening-reports.ts";

function unsupported(ctx: ApiCtx): void {
  sendJson(ctx.res, 501, { error: "unsupported", message: "screening reports are not configured here" });
}

export async function listScreeningReports(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const { screeningReports, skillTrusts } = ctx.deps;
  if (!screeningReports) return unsupported(ctx);
  const status = ctx.url.searchParams.get("status");
  const reports = (await screeningReports.all())
    .filter((report) => !status || status === "all" || report.status === status)
    .sort((a, b) => b.createdAt - a.createdAt);
  const trusts = skillTrusts ? await skillTrusts.all() : [];
  const groups = new Map<string, ScreeningReport[]>();
  for (const report of reports) groups.set(report.sourceKey, [...(groups.get(report.sourceKey) ?? []), report]);
  sendJson(ctx.res, 200, {
    groups: [...groups.entries()].map(([sourceKey, items]) => {
      const latest = items[0]!;
      const source = latest.source;
      return {
        sourceKey,
        source: latest.source,
        sourceLabel: securityHoldSourceLabel(latest.source),
        open: items.filter((r) => r.status === "open").length,
        reports: items.map((report) => ({ ...report, categoryLabel: SECURITY_CATEGORY_LABELS[report.category] })),
        trusted:
          source.kind === "skill"
            ? (trusts.find((t) => t.id === skillTrustKey(source.skillId, source.version)) ?? null)
            : null,
      };
    }),
    trusts: trusts.sort((a, b) => b.grantedAt - a.grantedAt),
  });
}

export async function setScreeningReportStatus(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const { screeningReports } = ctx.deps;
  if (!screeningReports) return unsupported(ctx);
  const status = isObj(ctx.body) ? ctx.body.status : undefined;
  if (typeof status !== "string" || !(SCREENING_REPORT_STATUSES as readonly string[]).includes(status)) {
    sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `status must be one of ${SCREENING_REPORT_STATUSES.join(", ")}`,
    });
    return;
  }
  const id = ctx.params.id ?? "";
  const updated = await screeningReports.merge(id, {
    status: status as ScreeningReportStatus,
    resolvedBy: actor.id,
    resolvedAt: Date.now(),
  });
  if (!updated) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return;
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: "security_screen.report_status",
    resource: id,
    scopeLabel: scope,
    status,
    detail: JSON.stringify({ sourceKey: updated.sourceKey }),
  });
  sendJson(ctx.res, 200, { report: updated });
}

export async function listSkillTrusts(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.skillTrusts) return unsupported(ctx);
  const trusts = (await ctx.deps.skillTrusts.all()).sort((a, b) => b.grantedAt - a.grantedAt);
  sendJson(ctx.res, 200, { trusts });
}

export async function grantSkillTrust(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const { skillTrusts } = ctx.deps;
  if (!skillTrusts) return unsupported(ctx);
  const body = isObj(ctx.body) ? ctx.body : {};
  const { skillId, version, contentHash, reportId } = body;
  if (typeof skillId !== "string" || !skillId || typeof version !== "number" || !Number.isInteger(version)) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "skillId and an integer version are required" });
    return;
  }
  const skill = await ctx.app.getSkill(skillId);
  if (!skill) {
    sendJson(ctx.res, 404, { error: "not_found", message: "no such skill" });
    return;
  }
  const identity = skillIdentity(skill);
  if (identity.version !== version || (typeof contentHash === "string" && contentHash !== identity.contentHash)) {
    sendJson(ctx.res, 409, {
      error: "skill_changed",
      message: `${identity.name} is now at v${identity.version}; its new content is screened again before it can be trusted`,
    });
    return;
  }
  const trust: SkillTrust = {
    id: skillTrustKey(identity.skillId, identity.version),
    skillId: identity.skillId,
    name: identity.name,
    version: identity.version,
    contentHash: identity.contentHash,
    grantedBy: actor.id,
    grantedAt: Date.now(),
    ...(typeof reportId === "string" && reportId ? { reportId } : {}),
  };
  await skillTrusts.put(trust.id, trust);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "security_screen.skill_trust_granted",
    resource: trust.id,
    scopeLabel: scope,
    status: "ok",
    detail: JSON.stringify({ skillId: trust.skillId, version: trust.version, contentHash: trust.contentHash }),
  });
  sendJson(ctx.res, 200, { trust });
}

export async function revokeSkillTrust(ctx: ApiCtx): Promise<void> {
  const scope = orgScope();
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const { skillTrusts } = ctx.deps;
  if (!skillTrusts) return unsupported(ctx);
  const id = decodeURIComponent(ctx.params.id ?? "");
  const removed = await skillTrusts.take(id);
  if (!removed) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return;
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: "security_screen.skill_trust_revoked",
    resource: id,
    scopeLabel: scope,
    status: "ok",
    detail: JSON.stringify({ skillId: removed.skillId, version: removed.version }),
  });
  sendJson(ctx.res, 200, { revoked: true, id });
}
