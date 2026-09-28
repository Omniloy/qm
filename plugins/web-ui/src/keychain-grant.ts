export type GrantMode = "once" | "standing";

export interface GrantScopeOption {
  scopeId: string;
  name: string;
  kind: "personal" | "channel" | "group";
}

export interface GrantableCredential {
  id: string;
  service: string;
  kind?: string;
  expiresAt?: number;
}

export interface ExistingGrant {
  credentialId: string;
  audienceScopeId: string;
  status: string;
  expiresAt?: number;
}

export function grantTargets(
  contexts: readonly GrantScopeOption[],
  credentialId: string,
  grants: readonly ExistingGrant[],
  personalScopeId: string,
  at = Date.now(),
): GrantScopeOption[] {
  const held = new Set(
    grants
      .filter((g) => g.credentialId === credentialId && g.status === "active" && (g.expiresAt ?? Infinity) > at)
      .map((g) => g.audienceScopeId),
  );
  return contexts.filter((c) => c.scopeId && c.scopeId !== personalScopeId && !held.has(c.scopeId));
}

export function grantBlockedReason(
  credential: GrantableCredential,
  targets: readonly GrantScopeOption[],
  at = Date.now(),
): string | null {
  if (credential.kind !== "file" && credential.expiresAt !== undefined && credential.expiresAt < at) {
    return "This credential has expired — replace it before lending it out.";
  }
  if (!targets.length) return "Every context you belong to already has this one.";
  return null;
}

export function grantImpact(mode: GrantMode, credential: GrantableCredential, targetLabel: string): string {
  if (mode === "once") {
    return (
      `The next turn in ${targetLabel} can use ${credential.service} on your behalf, once. ` +
      `The secret itself never leaves the server, and every use is audited under your name.`
    );
  }
  return (
    `Anyone in ${targetLabel} can use ${credential.service} on your behalf, from now on. ` +
    `The secret itself never leaves the server, every use is audited under your name, and you can revoke this at any time.`
  );
}

export function grantConfirmLabel(mode: GrantMode, busy: boolean): string {
  if (busy) return "Working…";
  return mode === "once" ? "Allow once" : "Give access";
}

export function grantRequest(
  credentialId: string,
  audienceScopeId: string,
  mode: GrantMode,
  purpose: string,
): { credential: string; audienceScopeId: string; mode: GrantMode; purpose: string } {
  const written = purpose.trim();
  return {
    credential: credentialId,
    audienceScopeId,
    mode,
    purpose: written || "Given from the keychain page",
  };
}

export function grantSuccessNotice(mode: GrantMode, service: string, targetLabel: string): string {
  return mode === "once"
    ? `${service} is available to ${targetLabel} for one turn.`
    : `${service} is now available to ${targetLabel}.`;
}
