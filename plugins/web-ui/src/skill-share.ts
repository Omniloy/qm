import type { RowActionSpec } from "./drive-mount";

/**
 * DOM-free decisions for sharing a skill out of the scope it lives in.
 *
 * Every one of these actions already exists in core behind `POST /v1/share`,
 * which dispatches on the destination: an org target promotes, `move: true`
 * relocates, and anything else writes an ACL grant. None of it was reachable
 * without an agent holding a capability token, so the only way to share a skill
 * was to ask for it in chat.
 *
 * The rules below mirror core's refusals rather than inventing new ones. Core
 * still enforces all of them — this exists so the menu doesn't offer a button
 * that is certain to fail, which reads as a bug rather than as a permission.
 */

export type SkillShareMode = "share" | "move" | "promote";

export interface SkillShareRow {
  id?: string;
  name: string;
  scope: string;
  scopeId?: string;
  /** Core's own word for "you may change this one". */
  editable?: boolean;
  status?: string;
}

export interface ShareScopeOption {
  scopeId: string;
  name: string;
  kind: "personal" | "channel" | "group";
}

export const NOT_ADMIN_REASON = "Only an org admin can give a skill to the whole organization";

/**
 * The overflow menu for a skill row.
 *
 * Returns an empty list for a skill the viewer doesn't own — a row with a menu
 * that offers nothing is worse than a row with no menu.
 */
export function skillShareActions(row: SkillShareRow, opts: { isAdmin: boolean; archived: boolean }): RowActionSpec[] {
  // An org-wide skill belongs to the org rather than to whoever promoted it, so
  // core reports it as nobody's to edit — including the promoter's. Taking it
  // back is an admin action on the org's own copy, which makes it the one thing
  // a row can offer without being editable.
  if (isOrgScoped(row)) {
    if (opts.archived || !row.id || !opts.isAdmin) return [];
    return [{ id: "demote", label: "Take back from everyone…", danger: true }];
  }

  if (row.editable !== true || !row.id) return [];

  // An archived skill is out of circulation; sharing one would quietly put it
  // back into someone else's chain under a name they never chose.
  if (opts.archived) return [{ id: "restore", label: "Restore" }];

  return [
    { id: "share", label: "Share with a context…" },
    { id: "unshare", label: "Stop sharing…" },
    {
      id: "promote",
      label: "Share with everyone…",
      disabled: !opts.isAdmin,
      ...(opts.isAdmin ? {} : { reason: NOT_ADMIN_REASON }),
    },
    { id: "move", label: "Move to another context…" },
    { id: "archive", label: "Archive…", danger: true },
  ];
}

export function isOrgScoped(row: SkillShareRow): boolean {
  return row.scope === "org" || row.scopeId?.startsWith("org:") === true;
}

/**
 * Where a skill can go.
 *
 * Its current home is dropped because both sharing and moving there are no-ops,
 * and personal scopes are offered only for a move: sharing a skill back to
 * yourself grants you what you already have, while moving it there is how you
 * take one back out of a project.
 */
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

/**
 * The sentence under the destination picker.
 *
 * Stated as what happens to the copy the person is looking at, because that is
 * the question they actually have and the one the three verbs differ on.
 */
export function shareImpact(mode: SkillShareMode, row: SkillShareRow, targetLabel: string): string {
  if (mode === "promote") {
    return (
      `Everyone in the organization gets /${row.name}, in every conversation. ` +
      `You keep your own copy, and org admins can edit the shared one from then on.`
    );
  }
  if (mode === "move") {
    return (
      `/${row.name} moves to ${targetLabel} and stops being available where it lives now. ` +
      `Anyone in ${targetLabel} can then edit it. You can move it back later.`
    );
  }
  return (
    `${targetLabel} gets to use /${row.name}. You keep it, and it stays yours to edit — ` +
    `later changes are not pushed, so share again to update them.`
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

/** The body for `POST /api/skills/:id/share`. */
export function shareRequest(
  mode: SkillShareMode,
  toScope: string,
  permission: "read" | "write",
): { toScope: string; permission?: "read" | "write"; move?: true } {
  if (mode === "promote") return { toScope: "org" };
  if (mode === "move") return { toScope, move: true };
  return { toScope, permission };
}

/**
 * Undoing a share.
 *
 * Separated from the three giving verbs because it answers a different
 * question: not "where should this go" but "who has it, and should they still".
 */
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
    `Anyone who kept their own copy still has it, and its history is preserved.`
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
