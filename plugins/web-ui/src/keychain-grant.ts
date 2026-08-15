/**
 * DOM-free decisions for lending a stored credential to a context.
 *
 * Until now a grant could only come into being by asking in chat: core takes a
 * grant's audience from the capability making the request, which for an agent
 * is the conversation it is already in. That is a real protection — it is what
 * stops an agent lending a secret to a room it was never invited to — and it is
 * also why the keychain page could only ever take access away.
 *
 * A person on the keychain page has no conversation to inherit, so they name the
 * audience instead, and core holds them to the same rule every other kind of
 * sharing here follows: you can lend into a context you are part of.
 *
 * Deliberately limited to stored credentials. Connector accounts and the browser
 * are not grant-driven — the orchestrator hands connector tokens out by
 * conversation kind and never consults a grant — so offering to lend one would
 * record consent that nothing reads.
 */

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

/**
 * Where a credential can be lent.
 *
 * Your own personal scope is dropped because a credential you own already works
 * in your own chats, and contexts that already hold an active grant are dropped
 * because lending twice is not an action — the row already says so, with a
 * Revoke beside it.
 */
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

/**
 * Whether the credential can be lent at all.
 *
 * An expired credential is refused up front: the grant would be recorded and
 * then quietly do nothing, which is the worst of both outcomes.
 */
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

/** The sentence under the picker, in terms of what the other people get. */
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

/** The body for `POST /api/keychain/grants`. */
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
    // Core requires a purpose, and it is what the owner reads months later on
    // the grant row. An unwritten one says where it came from rather than
    // leaving the row blank.
    purpose: written || "Given from the keychain page",
  };
}

export function grantSuccessNotice(mode: GrantMode, service: string, targetLabel: string): string {
  return mode === "once"
    ? `${service} is available to ${targetLabel} for one turn.`
    : `${service} is now available to ${targetLabel}.`;
}
