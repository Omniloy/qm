import type { DriveMount } from "./mount-store.ts";
import { isNativeGoogleType, type DriveEntry, type Listing } from "./drive-listing.ts";

/**
 * The `## Attached folders` system-prompt section.
 *
 * This is a map, not an index of contents: names and types only. Two things
 * about it are load-bearing and must survive any edit to the copy.
 *
 * It is a **snapshot**. Nothing re-lists mid-turn, so a file created a minute
 * ago is absent. The block therefore has to say when it was listed and tell
 * the agent to re-list rather than conclude a file does not exist — otherwise
 * a stale map reads as authoritative absence.
 *
 * It may be **incomplete**. A folder can exceed the depth, entry or call
 * budget, and Drive itself can return partial results. An unmarked partial
 * tree is indistinguishable from a complete one.
 */

export interface MountListing {
  mount: DriveMount;
  listing: Listing;
  listedAt: number;
}

const pathOf = (e: DriveEntry): string => (e.dir ? `${e.dir}/${e.name}` : e.name);

const TRUNCATION_NOTE: Record<NonNullable<Listing["truncatedReason"]>, string> = {
  depth: "only the top levels are listed",
  entries: "the list was cut at the entry limit",
  calls: "the listing ran out of its call budget",
  "incomplete-search": "Drive returned partial results",
};

function renderMount(m: MountListing, nowMs: number): string {
  const { mount, listing } = m;
  const ageMin = Math.max(0, Math.round((nowMs - m.listedAt) / 60_000));
  const age = ageMin === 0 ? "just now" : ageMin === 1 ? "1 minute ago" : `${ageMin} minutes ago`;

  const head = `### ${mount.name}${mount.mode === "ro" ? " (read-only)" : ""}`;
  const meta = [
    mount.displayPath ? `Drive location: ${mount.displayPath}` : null,
    `${listing.entries.length} file${listing.entries.length === 1 ? "" : "s"} listed ${age}`,
    listing.truncated
      ? `INCOMPLETE — ${TRUNCATION_NOTE[listing.truncatedReason ?? "entries"]}. Search the folder rather than assuming a file is missing.`
      : null,
  ].filter(Boolean);

  if (!listing.entries.length) {
    return `${head}\n${meta.join("\n")}\n(empty, or nothing you have access to)`;
  }

  const lines = listing.entries.map((e) => {
    const native = isNativeGoogleType(e.mimeType) ? " [Google file — edit in place, do not download and replace]" : "";
    return `- ${pathOf(e)}${native}`;
  });

  return `${head}\n${meta.join("\n")}\n${lines.join("\n")}`;
}

/**
 * Render the block, or "" when there is nothing to say.
 *
 * `nowMs` is passed in rather than read from the clock so the rendering is
 * deterministic and the age line is testable.
 */
export function attachedFoldersSection(mounts: readonly MountListing[], nowMs: number): string {
  if (!mounts.length) return "";

  const body = mounts.map((m) => renderMount(m, nowMs)).join("\n\n");

  return [
    "## Attached folders",
    "Google Drive folders attached to this conversation. You reach them with the Google Workspace skill, as yourself — you can only open what your own Google account can open, and only inside these folders.",
    "",
    "This is a point-in-time snapshot of names and types, not contents. If a file you expect is missing, list the folder again before concluding it is not there.",
    "",
    body,
  ].join("\n");
}

/**
 * The line shown when someone in the conversation has folders attached but
 * cannot use them. Kept separate from the listing so the agent is told *why*
 * it has no folders, rather than silently seeing none.
 */
export function attachedFoldersUnavailableNote(reason: "not-connected" | "no-access"): string {
  return reason === "not-connected"
    ? "## Attached folders\nThis conversation has Drive folders attached, but your Google account is not connected, so you cannot open them. Tell the person to connect Google Workspace in the Keychain."
    : "## Attached folders\nThis conversation has Drive folders attached, but your Google account cannot open them. Tell the person they need access granted in Drive by whoever owns the folder.";
}
