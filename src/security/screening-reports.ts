import type { DurableMap } from "../persistence/durable-map.ts";
import type { SecurityScreenCategory, SkillIdentity, ToolResultContext } from "./security-posture.ts";

export const SCREENING_REPORT_STATUSES = ["open", "screen_correct", "fixed"] as const;
export type ScreeningReportStatus = (typeof SCREENING_REPORT_STATUSES)[number];

export interface ScreeningReport {
  id: string;
  approvalId: string;
  sessionId: string;
  source: ToolResultContext;
  sourceKey: string;
  scheduledTask?: { id: string; title?: string; ownerId?: string };
  category: SecurityScreenCategory;
  reason?: string;
  evidence?: string;
  content: string;
  reporterId: string;
  note?: string;
  createdAt: number;
  status: ScreeningReportStatus;
  resolvedBy?: string;
  resolvedAt?: number;
}

export type ScreeningReportStore = DurableMap<ScreeningReport>;

export interface SkillTrust {
  id: string;
  skillId: string;
  name: string;
  version: number;
  contentHash: string;
  grantedBy: string;
  grantedAt: number;
  reportId?: string;
}

export type SkillTrustStore = DurableMap<SkillTrust>;

export const MAX_REPORT_NOTE_CHARS = 2_000;

export function skillTrustKey(skillId: string, version: number): string {
  return `${skillId}@${version}`;
}

export async function trustedSkillVersion(
  store: SkillTrustStore | undefined,
  identity: SkillIdentity,
): Promise<SkillTrust | null> {
  if (!store) return null;
  const trust = await store.get(skillTrustKey(identity.skillId, identity.version));
  return trust && trust.contentHash === identity.contentHash ? trust : null;
}

export interface ScreeningHoldCount {
  sourceKey: string;
  holds: number;
  lastAt: number;
}

export type ScreeningHoldCountStore = DurableMap<ScreeningHoldCount>;

export const SCREENING_REPORT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export async function countHold(store: ScreeningHoldCountStore | undefined, sourceKey: string): Promise<void> {
  if (!store) return;
  const at = Date.now();
  await store.putIfAbsent(sourceKey, { sourceKey, holds: 0, lastAt: at });
  const bump = (value: ScreeningHoldCount): ScreeningHoldCount => ({ ...value, holds: value.holds + 1, lastAt: at });
  if (store.update) {
    await store.update(sourceKey, bump);
    return;
  }
  const current = await store.get(sourceKey);
  if (current) await store.put(sourceKey, bump(current));
}

export async function sweepScreeningReports(
  store: ScreeningReportStore,
  sessionExists: (sessionId: string) => Promise<boolean>,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const [id, report] of await store.entries()) {
    if (report.createdAt > now - SCREENING_REPORT_RETENTION_MS && (await sessionExists(report.sessionId))) continue;
    await store.delete(id);
    removed++;
  }
  return removed;
}
