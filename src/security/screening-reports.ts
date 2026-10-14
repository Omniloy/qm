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
  step: string;
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
