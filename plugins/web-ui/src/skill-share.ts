import type { RowActionSpec } from "./drive-mount";

export type SkillShareMode = "share" | "move" | "promote";

export interface SkillShareRow {
  id?: string;
  name: string;
  scope: string;
  scopeId?: string;
  editable?: boolean;
  createdByViewer?: boolean;
  status?: string;
}

export interface ShareScopeOption {
  scopeId: string;
  name: string;
  kind: "personal" | "channel" | "group";
}

export const NOT_ADMIN_REASON = "Only an org admin can give a skill to the whole organization";

export function skillShareActions(
  row: SkillShareRow,
  opts: { isAdmin: boolean; canPromote?: boolean; archived: boolean },
): RowActionSpec[] {
  const canPromote = opts.isAdmin || opts.canPromote === true;
  if (isOrgScoped(row)) {
    if (opts.archived || !row.id || !(opts.isAdmin || (canPromote && row.createdByViewer === true))) return [];
    return [{ id: "demote", label: "Take back from everyone…", danger: true }];
  }

  if (row.editable !== true || !row.id) return [];

  if (opts.archived) return [{ id: "restore", label: "Restore" }];

  return [
    { id: "share", label: "Share with a context…" },
    { id: "unshare", label: "Stop sharing…" },
    {
      id: "promote",
      label: "Share with everyone…",
      disabled: !canPromote,
      ...(canPromote ? {} : { reason: NOT_ADMIN_REASON }),
    },
    { id: "move", label: "Move to another context…" },
    { id: "archive", label: "Archive…", danger: true },
  ];
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
    if (c.kind === "personal") return mode === "move";
    return true;
  });
}

export function shareImpact(mode: SkillShareMode, row: SkillShareRow, targetLabel: string): string {
  if (mode === "promote") {
    return (
      `Everyone in the organization gets a copy of /${row.name}, in every conversation. ` +
      `Your own stays where it is, but your later edits to it don't reach the org copy — ` +
      `only org admins can edit that one.`
    );
  }
  if (mode === "move") {
    return (
      `/${row.name} moves to ${targetLabel} and stops being available where it lives now. ` +
      `Contexts you shared it with lose access. You can move it back later.`
    );
  }
  return (
    `${targetLabel} gets to use /${row.name}. It stays yours to edit, and they always get your latest version — ` +
    `no need to share again after a change.`
  );
}

export function shareTitle(mode: SkillShareMode, name: string): string {
  if (mode === "promote") return `Share /${name} with everyone?`;
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
): { toScope: string; permission?: "read"; move?: true } {
  if (mode === "promote") return { toScope: "org" };
  if (mode === "move") return { toScope, move: true };
  return { toScope, permission: "read" };
}

export interface SkillGrantRow {
  granteeScopeId: string;
  permission: "read" | "write";
}

export function unshareEmptyState(name: string): string {
  return `/${name} isn't shared with any context. Sharing it with one puts it in that context's chain without taking it out of yours.`;
}

export function unshareImpact(name: string, targetLabel: string): string {
  return (
    `${targetLabel} stops being able to invoke /${name}. ` +
    `You keep the skill, and you can share it with them again later.`
  );
}

export function unshareSuccessNotice(name: string, targetLabel: string): string {
  return `${targetLabel} can no longer use /${name}.`;
}

export function demoteImpact(name: string): string {
  return (
    `/${name} stops being available to everyone in the organization, in every conversation. ` +
    `The org copy is archived; the skill it was shared from keeps working where it lives.`
  );
}

export function demoteSuccessNotice(name: string): string {
  return `/${name} is no longer available to the organization.`;
}

export function shareSuccessNotice(mode: SkillShareMode, name: string, targetLabel: string): string {
  if (mode === "promote") return `/${name} is now available to everyone in the organization.`;
  if (mode === "move") return `/${name} moved to ${targetLabel}.`;
  return `/${name} shared with ${targetLabel}.`;
}
