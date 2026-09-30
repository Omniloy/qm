import type { RowActionSpec } from "./drive-mount";

export type SkillShareMode = "share" | "move" | "promote";
export type SkillPermission = "read" | "write";

export interface SkillShareRow {
  id?: string;
  name: string;
  scope: string;
  scopeId?: string;
  editable?: boolean;
  createdByViewer?: boolean;
  ownedByViewer?: boolean;
  ownerName?: string;
  orgWide?: boolean;
  canManage?: boolean;
  canMoveOrTransfer?: boolean;
  status?: string;
}

export interface ShareScopeOption {
  scopeId: string;
  name: string;
  kind: "personal" | "channel" | "group";
}

interface SkillConflict {
  id: string;
  name: string;
  home: string;
  owner: string;
}

export const NOT_ADMIN_REASON = "Only an org admin can give a skill to the whole organization";

export function skillShareActions(
  row: SkillShareRow,
  opts: { isAdmin: boolean; canPromote?: boolean; archived: boolean },
): RowActionSpec[] {
  if (!row.id) return [];
  if (opts.archived) return row.canManage ? [{ id: "restore", label: "Restore" }] : [];
  if (isOrgScoped(row)) {
    const legacyOwn = opts.canPromote === true && (row.ownedByViewer === true || row.createdByViewer === true);
    return opts.isAdmin || legacyOwn ? [{ id: "demote", label: "Take back from everyone…", danger: true }] : [];
  }
  if (row.canManage !== true) return [];
  const actions: RowActionSpec[] = [
    { id: "share", label: "Share with a context…" },
    { id: "unshare", label: "Stop sharing…" },
  ];
  if (row.canMoveOrTransfer === true) {
    if (row.orgWide) {
      actions.push({ id: "demote", label: "Stop sharing with everyone…" });
    } else {
      const canPromote = opts.isAdmin || (opts.canPromote === true && row.ownedByViewer === true);
      actions.push({
        id: "promote",
        label: "Make available to everyone…",
        disabled: !canPromote,
        ...(canPromote ? {} : { reason: NOT_ADMIN_REASON }),
      });
    }
    actions.push({ id: "move", label: "Move home…" }, { id: "transfer", label: "Transfer ownership…" });
  }
  actions.push({ id: "archive", label: "Archive…", danger: true });
  return actions;
}

export function isOrgScoped(row: SkillShareRow): boolean {
  return row.scope === "org" || row.scopeId?.startsWith("org:") === true;
}

export function shareTargets(
  contexts: readonly ShareScopeOption[],
  row: SkillShareRow,
  mode: SkillShareMode,
): ShareScopeOption[] {
  if (mode === "promote") return [];
  return contexts.filter((c) => {
    if (!c.scopeId || c.scopeId === row.scopeId) return false;
    if (c.kind === "personal") return mode === "move" && row.ownedByViewer === true;
    return true;
  });
}

export function shareImpact(
  mode: SkillShareMode,
  row: SkillShareRow,
  targetLabel: string,
  permission: SkillPermission = "read",
): string {
  if (mode === "promote") {
    return (
      `Everyone in the organization can use /${row.name}. It stays one skill: edits by you or its home's members ` +
      `reach everyone immediately. You can stop sharing it at any time.`
    );
  }
  if (mode === "move") {
    return (
      `/${row.name} moves to ${targetLabel}. Grants move with it; people in its current home lose access ` +
      `unless it's shared with them.`
    );
  }
  const base = `${targetLabel} can use /${row.name}. Edits you make reach them automatically.`;
  return permission === "write"
    ? `${base} They can also edit the instructions; edits reach everyone who has it.`
    : base;
}

export function shareTitle(mode: SkillShareMode, name: string): string {
  if (mode === "promote") return `Make /${name} available to everyone?`;
  if (mode === "move") return `Move /${name}?`;
  return `Share /${name}`;
}

export function shareConfirmLabel(mode: SkillShareMode, busy: boolean): string {
  if (busy) return "Working…";
  if (mode === "promote") return "Share org-wide";
  if (mode === "move") return "Move skill";
  return "Share";
}

export function shareRequest(
  mode: SkillShareMode,
  toScope: string,
  permission: SkillPermission = "read",
): { toScope: string; permission?: SkillPermission; move?: true } {
  if (mode === "promote") return { toScope: "org" };
  if (mode === "move") return { toScope, move: true };
  return { toScope, permission };
}

export function permissionLabel(permission: SkillPermission): string {
  return permission === "write" ? "Can use and edit it" : "Can use it";
}

export function nameConflictMessage(name: string, targetLabel: string, conflict: SkillConflict): string {
  const who = targetLabel === "everyone in the organization" ? "Everyone" : targetLabel;
  return (
    `${who} already sees a different /${name} (owner ${conflict.owner}, home ${conflict.home}). ` +
    `Rename yours, or ask an admin to merge.`
  );
}

export function conflictFrom(body: unknown): SkillConflict | null {
  const conflict = (body as { conflict?: unknown } | null)?.conflict as Partial<SkillConflict> | undefined;
  return conflict && typeof conflict.id === "string" && typeof conflict.owner === "string"
    ? (conflict as SkillConflict)
    : null;
}

export interface SkillGrantRow {
  granteeScopeId: string;
  permission: SkillPermission;
}

export function unshareEmptyState(name: string): string {
  return `/${name} isn't shared with any context. Sharing it with one puts it in that context's chain without taking it out of its home.`;
}

export function unshareImpact(name: string, targetLabel: string): string {
  return `${targetLabel} stops being able to use /${name}. It stays in its home, and you can share it with them again later.`;
}

export function unshareSuccessNotice(name: string, targetLabel: string): string {
  return `${targetLabel} can no longer use /${name}.`;
}

export function demoteImpact(name: string, legacyOrgCopy = false): string {
  return legacyOrgCopy
    ? `/${name} stops being available to everyone in the organization. This org copy is archived; the skill it was copied from keeps working where it lives.`
    : `/${name} stops being available org-wide. It stays in its home and its other shares.`;
}

export function demoteSuccessNotice(name: string): string {
  return `/${name} is no longer available to the organization.`;
}

export function shareSuccessNotice(mode: SkillShareMode, name: string, targetLabel: string): string {
  if (mode === "promote") return `/${name} is now available to everyone in the organization.`;
  if (mode === "move") return `/${name} moved to ${targetLabel}.`;
  return `/${name} shared with ${targetLabel}.`;
}

export function transferImpact(name: string, ownerLabel: string, personalHome: boolean, homeLabel: string): string {
  return (
    `${ownerLabel} becomes the owner of /${name} and can edit, share, move or transfer it.` +
    (personalHome ? ` It will live in ${homeLabel}.` : "") +
    ` You'll keep access only through its home or shares.`
  );
}

export function transferSuccessNotice(name: string, ownerLabel: string): string {
  return `${ownerLabel} now owns /${name}.`;
}
