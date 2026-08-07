import type { RowActionSpec } from "./drive-mount";

/**
 * DOM-free decisions for a file row's overflow menu.
 *
 * Kept beside the markup rather than inside it for the same reason the Drive
 * band's rules are: which actions a row offers is logic, and logic that
 * governs a destructive action deserves tests.
 */

export interface FileActionRow {
  id: string;
  name: string;
  /** Who uploaded it. Only they may delete it. */
  createdBy?: string;
  /** False when the artifact has no stored bytes — nothing to open. */
  openable: boolean;
  /** The context it currently sits in, when that is not the person's own. */
  createdInScope?: string;
}

export function fileActions(row: FileActionRow, viewerId: string): RowActionSpec[] {
  const mine = row.createdBy === viewerId;
  const actions: RowActionSpec[] = [
    {
      id: "download",
      label: "Download",
      disabled: !row.openable,
      ...(row.openable ? {} : { reason: "This file has no stored contents" }),
    },
  ];

  // Deleting is the owner's alone. Core enforces it too, but offering a button
  // that always fails is worse than not offering it: it reads as a bug.
  actions.push({
    id: "delete",
    label: "Delete…",
    danger: true,
    disabled: !mine,
    ...(mine ? {} : { reason: "Only the person who uploaded a file can delete it" }),
  });

  return actions;
}
