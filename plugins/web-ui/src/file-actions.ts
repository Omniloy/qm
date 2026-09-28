import type { RowActionSpec } from "./drive-mount";

export interface FileActionRow {
  id: string;
  name: string;
  createdBy?: string;
  openable: boolean;
  createdInScope?: string;
}

export function fileActions(row: FileActionRow, viewerId: string, personalScope?: string | null): RowActionSpec[] {
  const mine = row.createdBy === viewerId;
  const notMine = "Only the person who uploaded a file can change it";
  const actions: RowActionSpec[] = [
    {
      id: "download",
      label: "Download",
      disabled: !row.openable,
      ...(row.openable ? {} : { reason: "This file has no stored contents" }),
    },
  ];

  actions.push({
    id: "move",
    label: "Change context…",
    disabled: !mine,
    ...(mine ? {} : { reason: notMine }),
  });

  const inProject = Boolean(row.createdInScope) && Boolean(personalScope) && row.createdInScope !== personalScope;
  if (inProject) {
    actions.push({
      id: "unshare",
      label: "Remove from this context",
      disabled: !mine,
      ...(mine ? {} : { reason: notMine }),
    });
  }

  actions.push({
    id: "delete",
    label: "Delete…",
    danger: true,
    disabled: !mine,
    ...(mine ? {} : { reason: "Only the person who uploaded a file can delete it" }),
  });

  return actions;
}
