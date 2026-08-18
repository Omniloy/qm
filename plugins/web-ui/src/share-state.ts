/**
 * The sharer-facing half of public chat links: every decision and every word,
 * with no DOM in it.
 *
 * This module exists so the two things most likely to rot are testable. The
 * first is the copy. Publishing a conversation is irreversible in the only way
 * that matters — you cannot un-read it — so the sentences here are the consent,
 * and a copy edit that softens one of them is a lie shipped to production. They
 * are exported as named constants and asserted verbatim in test/share-state.test.ts.
 *
 * The second is who is told. The link is LIVE and the conversation has other
 * people in it, so the person who clicked Share is not the only one whose future
 * messages get published. `shareStrip` decides the persistent notice that every
 * viewer of the conversation sees, sharer or not, and it is deliberately not
 * dismissable: the state it reports is standing, not an event.
 *
 * Nothing here talks to the network. The caller performs the request and feeds
 * the outcome back in as an event, which is what makes every failure path —
 * including the ones nobody exercises by hand — a unit test.
 */

// --------------------------------------------------------------------- shapes

/** A file a link holder can download, as the dialog needs to show it. */
export interface ShareFileView {
  name: string;
  sizeBytes?: number;
}

/**
 * One live link, as core reports it.
 *
 * `sharerLabel` is a directory display name or null. It is never a principal id:
 * the house `displayName || id` idiom would print `alice@company.com` onto an
 * anonymous page, so the fallback lives here instead, in `sharerName`.
 */
export interface ShareLinkView {
  /**
   * The share id IS the secret. There is no capability token beside it and core
   * mints none: resolution re-authorizes the sharer on every single request, so
   * the id is a bearer credential that stops working the moment anyone revokes
   * it or the sharer's access lapses. Anything in this file that made a Copy
   * button conditional on a second token was describing a wire shape that does
   * not exist, and hid the primary action behind it.
   */
  shareId: string;
  createdAt: number;
  viewCount: number;
  lastViewedAt?: number;
  /** True when the caller is the person who minted this link. Never used to gate revocation — any member may. */
  mine?: boolean;
  sharerLabel: string | null;
  /** Core's own absolute URL for the link, when the deployment knows its public base. */
  url?: string;
}

// ----------------------------------------------------------------------- copy

export const SHARE_BUTTON_LABEL = "Share";

export const SHARE_TITLE = "Share this conversation";

export const SHARE_INTRO = "Anyone with this link can read it — no sign-in needed.";

/**
 * The consequence of the LIVE decision, stated in the sharer's face.
 *
 * Not collapsible, not a tooltip, and not written in the first person: the
 * messages this publishes are mostly other people's.
 */
export const SHARE_BULLET_LIVE =
  "It stays live. Messages sent after you share — by you or by anyone else in this conversation — become visible to everyone holding the link.";

/**
 * What is actually in the link.
 *
 * Attachments ship, including files the agent wrote from command output, so
 * this must not claim file contents are withheld. Saying "tool calls, command
 * output and thinking are not shown" is true of the transcript and only of the
 * transcript — a log the agent attached is downloadable in full.
 */
export const SHARE_BULLET_CONTENTS =
  "Messages and every attached file are shared — including files the agent creates from command output. Tool calls, command output, and thinking are not shown in the transcript.";

export const SHARE_BULLET_NO_EXPIRY = "The link works until someone turns it off. It does not expire on its own.";

export const SHARE_BULLET_CAUTION =
  "Don't share a conversation where the agent may have pasted credentials, one-time links, or private URLs into a message.";

export const SHARE_BULLETS: readonly string[] = [
  SHARE_BULLET_LIVE,
  SHARE_BULLET_CONTENTS,
  SHARE_BULLET_NO_EXPIRY,
  SHARE_BULLET_CAUTION,
];

/** The attachment list is shown before minting, so the exposure is visible at the moment of consent. */
export const SHARE_FILES_HEADING = "Files anyone with the link can download";
export const SHARE_FILES_EMPTY =
  "No files are attached yet. Files attached later become downloadable through this link too.";
/**
 * Shown instead of the empty line when the dialog is looking at a windowed transcript.
 *
 * The list is built from the messages actually loaded in this tab. With earlier turns still
 * unfetched, "no files are attached" would be a claim the dialog cannot support — and the one
 * screen where a wrong reassurance costs the most is the one with the Create button on it.
 */
export const SHARE_FILES_PARTIAL =
  "This is what's loaded so far. Earlier messages in this conversation may have attachments too, and they are shared as well.";

export const SHARE_CREATE_LABEL = "Create link";
export const SHARE_CREATING_LABEL = "Creating link…";
const SHARE_COPY_LABEL = "Copy link";
export const SHARE_COPIED_LABEL = "Copied";
export const SHARE_REPLACE_LABEL = "Replace link";
const SHARE_REPLACING_LABEL = "Replacing link…";
export const SHARE_TURN_OFF_LABEL = "Turn off link";
export const SHARE_TURNING_OFF_LABEL = "Turning off…";
const SHARE_CHECK_AGAIN_LABEL = "Check again";
export const SHARE_CREATE_AGAIN_LABEL = "Create a new link";

const SHARE_LOADING_NOTE = "Checking whether this conversation is already shared…";
export const SHARE_REPLACE_NOTE = "Replacing hands you a new link and kills the old one immediately.";

/** Revocation has to read as total, because it is. */
export const SHARE_REVOKED_NOTICE = "Link turned off. It stopped working immediately.";

/** Failure copy. Each one says what is true of the link right now, because that is the only useful thing to say. */
export const SHARE_CREATE_FAILED = "Couldn't create the link. Nothing has been shared — try again.";
export const SHARE_REVOKE_FAILED = "Couldn't turn the link off, so it is still live. Try again.";
export const SHARE_UNSURE = "Couldn't tell whether this conversation is shared right now. Check again.";
export const SHARE_RATE_LIMITED = "Too many requests just now. Try again in a minute.";
export const SHARE_OFFLINE = "Couldn't reach the server. Nothing has changed — try again.";

/** The strip every viewer of a shared conversation sees. */
const SHARE_STRIP_PREFIX = "Publicly shared by";
const SHARE_STRIP_SUFFIX = "anyone with the link can read this";
/** Used instead of a name we do not have, and instead of any id we do. */
export const SHARE_STRIP_ANONYMOUS_SHARER = "a member of this project";

// ------------------------------------------------------------------ the state

export type ShareState =
  /** Nothing asked yet — the dialog is shut, or it just shut. */
  | { kind: "closed" }
  | { kind: "loading" }
  /** Asked, and this conversation has no live link. */
  | { kind: "off"; error?: string }
  | { kind: "creating" }
  | { kind: "on"; link: ShareLinkView; error?: string }
  | { kind: "replacing"; link: ShareLinkView }
  | { kind: "revoking"; link: ShareLinkView }
  /** Turned off just now, and saying so. */
  | { kind: "revoked" }
  /** We asked and could not tell. The only honest offer is to ask again. */
  | { kind: "unsure"; message: string }
  /** Core refused, in its own words: not a participant, lapsed scope, strict posture, flag off. */
  | { kind: "unavailable"; message: string };

export type ShareEvent =
  | { kind: "open" }
  | { kind: "loaded"; link: ShareLinkView | null }
  | { kind: "create" }
  | { kind: "created"; link: ShareLinkView }
  | { kind: "replace" }
  | { kind: "replaced"; link: ShareLinkView }
  | { kind: "revoke" }
  | { kind: "revoked" }
  | { kind: "failed"; message: string; retryable: boolean }
  | { kind: "dismiss-error" }
  | { kind: "close" };

export const initialShareState: ShareState = { kind: "closed" };

export function isShareBusy(state: ShareState): boolean {
  return (
    state.kind === "loading" || state.kind === "creating" || state.kind === "replacing" || state.kind === "revoking"
  );
}

/** The link this state is standing on, if any. Failures must not lose it. */
export function shareLinkOf(state: ShareState): ShareLinkView | null {
  if (state.kind === "on" || state.kind === "replacing" || state.kind === "revoking") return state.link;
  return null;
}

/**
 * Every transition, including the ones that fail.
 *
 * Two rules earn their keep here. A failure never invents a state: a create that
 * failed lands back on "off" (nothing was shared), a revoke that failed lands
 * back on "on" (the link is still live). And a replace that failed lands on
 * "unsure", because a revoke-and-remint that broke halfway leaves us genuinely
 * unable to say whether the old link still works — and guessing in the
 * reassuring direction is exactly the guess that gets someone burned.
 */
export function shareReducer(state: ShareState, event: ShareEvent): ShareState {
  switch (event.kind) {
    case "close":
      // Reopening always re-asks core. A link revoked in another tab, or by a
      // colleague, must never be shown as live because it was cached.
      return { kind: "closed" };

    case "open":
      return isShareBusy(state) ? state : { kind: "loading" };

    case "loaded":
      return event.link ? { kind: "on", link: event.link } : { kind: "off" };

    case "create":
      if (state.kind === "off" || state.kind === "revoked") return { kind: "creating" };
      return state;

    case "created":
      return state.kind === "creating" ? { kind: "on", link: event.link } : state;

    case "replace":
      return state.kind === "on" ? { kind: "replacing", link: state.link } : state;

    case "replaced":
      return state.kind === "replacing" ? { kind: "on", link: event.link } : state;

    case "revoke":
      return state.kind === "on" ? { kind: "revoking", link: state.link } : state;

    case "revoked":
      return state.kind === "revoking" ? { kind: "revoked" } : state;

    case "failed": {
      if (!event.retryable) return { kind: "unavailable", message: event.message };
      if (state.kind === "creating") return { kind: "off", error: event.message };
      if (state.kind === "revoking") return { kind: "on", link: state.link, error: event.message };
      if (state.kind === "replacing") return { kind: "unsure", message: SHARE_UNSURE };
      if (state.kind === "loading") return { kind: "unsure", message: SHARE_UNSURE };
      return state;
    }

    case "dismiss-error": {
      if (state.kind === "off" && state.error !== undefined) return { kind: "off" };
      if (state.kind === "on" && state.error !== undefined) return { kind: "on", link: state.link };
      return state;
    }

    default: {
      const never: never = event;
      return never;
    }
  }
}

/** A human-readable string, or null. Anything else core might put on the wire is not copy. */
function sentence(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Turn a failed request into an event.
 *
 * Core's own refusal is mirrored verbatim — "you are no longer a member of this
 * project" is a better sentence than any generic one this file could invent, and
 * a generic error is how a deliberate policy refusal gets mistaken for a bug.
 */
export function shareFailureEvent(
  status: number,
  body?: { error?: unknown; message?: unknown } | null,
  fallback: string = SHARE_CREATE_FAILED,
): ShareEvent & { kind: "failed" } {
  // `message` first, `error` only as a fallback. Core puts the machine code in
  // `error` ("forbidden", "not_configured") and the sentence it wrote for a
  // person in `message` ("you are no longer a member of this project, so you
  // cannot share its conversations"). Reading `error` rendered the word
  // "forbidden" as the whole explanation of a non-retryable refusal.
  const fromCore = sentence(body?.message) ?? sentence(body?.error);
  // 0 is the shape a fetch rejection is reported with, and 5xx is the server's
  // problem, not the caller's: both are worth pressing again.
  if (status === 0) return { kind: "failed", message: SHARE_OFFLINE, retryable: true };
  if (status === 429) return { kind: "failed", message: SHARE_RATE_LIMITED, retryable: true };
  if (status >= 500) return { kind: "failed", message: fromCore ?? fallback, retryable: true };
  return { kind: "failed", message: fromCore ?? fallback, retryable: false };
}

// ------------------------------------------------------------------- the link

const SHARE_ID_SHAPE = /^[A-Za-z0-9-]{32,80}$/;

/**
 * `https://host[:port]` and nothing more.
 *
 * A base carrying a path is refused rather than joined: `https://host/base` +
 * `/share/<id>` is not a URL this deployment serves, and a link that resolves to
 * the wrong place is worse than no Copy button.
 */
function isBareOrigin(value: string): boolean {
  return /^https?:\/\/[^/?#]+$/i.test(value);
}

/**
 * The path the share page is served on.
 *
 * Kept in one place so it cannot drift from the server's anchored route, and
 * built from the id alone — there is no query string on a share URL at all. The
 * id is still validated: it arrives as JSON from the network, and a malformed
 * one must produce no button rather than a link that 404s for whoever it was
 * pasted to.
 */
export function sharePagePath(link: Pick<ShareLinkView, "shareId">): string | null {
  if (!SHARE_ID_SHAPE.test(link.shareId)) return null;
  return `/share/${link.shareId}`;
}

/**
 * The URL a person copies.
 *
 * It returns null rather than a best-effort string. A half-built link is worse
 * than no Copy button: it gets pasted, it 404s for the recipient, and the sharer
 * believes they shared something.
 *
 * Core's own `url` wins when it is present and agrees with the id, because only
 * core knows the deployment's public base — the browser's origin is whatever
 * host the sharer happens to be on, which behind a portal need not be the one a
 * stranger can reach.
 */
export function shareLinkUrl(origin: string, link: Pick<ShareLinkView, "shareId" | "url">): string | null {
  const path = sharePagePath(link);
  if (!path) return null;
  const fromCore = (link.url ?? "").trim();
  if (fromCore.endsWith(path) && isBareOrigin(fromCore.slice(0, -path.length))) return fromCore;
  const base = origin.replace(/\/+$/, "");
  return isBareOrigin(base) ? `${base}${path}` : null;
}

// ------------------------------------------------------------------ the strip

export interface ShareStripView {
  visible: boolean;
  text: string;
  /** Always false. The conversation is public for as long as it is public. */
  dismissable: false;
  action: { kind: "revoke"; label: string } | null;
}

/**
 * The sharer's name, or a phrase that is not an identifier.
 *
 * A label carrying `@` or `:` is a principal id wearing a display name's clothes
 * — `alice@company.com`, or `web:...` — and printing it would put an identity on
 * a page strangers can open. Fall back rather than trust it.
 */
export function sharerName(label: string | null | undefined): string {
  const trimmed = (label ?? "").trim();
  if (trimmed.length === 0) return SHARE_STRIP_ANONYMOUS_SHARER;
  if (trimmed.includes("@") || trimmed.includes(":")) return SHARE_STRIP_ANONYMOUS_SHARER;
  return trimmed;
}

/**
 * Whether this conversation shows the public-share strip, and what it says.
 *
 * Shown to EVERY viewer, including people who did not mint the link and were
 * never shown the dialog. Their next message is published too, so they are
 * entitled to know before they type it — and to turn it off, which is why the
 * action is offered to any member rather than only to the minter.
 */
export function shareStrip(links: readonly ShareLinkView[], opts: { canRevoke?: boolean } = {}): ShareStripView {
  const live = links.filter((link) => link.shareId.length > 0);
  if (live.length === 0) return { visible: false, text: "", dismissable: false, action: null };

  const newest = [...live].sort((a, b) => b.createdAt - a.createdAt)[0]!;
  const others = live.length - 1;
  const who =
    others === 0
      ? sharerName(newest.sharerLabel)
      : `${sharerName(newest.sharerLabel)} and ${others} ${others === 1 ? "other" : "others"}`;

  return {
    visible: true,
    text: `${SHARE_STRIP_PREFIX} ${who} · ${SHARE_STRIP_SUFFIX}`,
    dismissable: false,
    // The same words as the dialog's button, because it is the same act. A second constant
    // aliasing the first only invites the two to drift apart.
    action: opts.canRevoke === false ? null : { kind: "revoke", label: SHARE_TURN_OFF_LABEL },
  };
}

// ------------------------------------------------------------ dialog rendering

interface ShareButton {
  label: string;
  disabled: boolean;
}

export interface ShareDialogView {
  title: string;
  intro: string;
  bullets: readonly string[];
  busy: boolean;
  /** The live link, when there is one to show. */
  link: ShareLinkView | null;
  url: string | null;
  /** Whether to list the downloadable files. Only before minting is it a consent step. */
  showFiles: boolean;
  status: string | null;
  note: string | null;
  error: string | null;
  buttons: {
    create?: ShareButton;
    copy?: ShareButton;
    replace?: ShareButton;
    turnOff?: ShareButton;
    checkAgain?: ShareButton;
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse on purpose: the exact second is noise next to "is anyone still opening this?". */
export function shareAgo(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

/** What the link has actually done — the one number that tells a sharer whether to leave it up. */
export function shareViewSummary(link: ShareLinkView, now: number): string {
  if (link.viewCount <= 0) return "Not opened yet";
  const times = link.viewCount === 1 ? "Opened once" : `Opened ${link.viewCount} times`;
  if (link.lastViewedAt === undefined) return times;
  return `${times} · last ${shareAgo(link.lastViewedAt, now)}`;
}

export function formatShareFileSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** One row of the pre-consent file list: `debug.log · 12.4 KB`. */
export function shareFileLabel(file: ShareFileView): string {
  const size = formatShareFileSize(file.sizeBytes);
  return size ? `${file.name} · ${size}` : file.name;
}

/**
 * Everything the dialog paints, derived from state alone.
 *
 * The bullets are on every screen that can still publish something, which is
 * every screen except the one confirming the link is dead.
 */
export function shareDialogView(state: ShareState, opts: { origin: string; now: number }): ShareDialogView {
  const busy = isShareBusy(state);
  const base: ShareDialogView = {
    title: SHARE_TITLE,
    intro: SHARE_INTRO,
    bullets: SHARE_BULLETS,
    busy,
    link: null,
    url: null,
    showFiles: false,
    status: null,
    note: null,
    error: null,
    buttons: {},
  };

  switch (state.kind) {
    case "closed":
    case "loading":
      return { ...base, note: SHARE_LOADING_NOTE };

    case "off":
      return {
        ...base,
        showFiles: true,
        error: state.error ?? null,
        buttons: { create: { label: SHARE_CREATE_LABEL, disabled: false } },
      };

    case "creating":
      return {
        ...base,
        showFiles: true,
        buttons: { create: { label: SHARE_CREATING_LABEL, disabled: true } },
      };

    case "on":
    case "replacing":
    case "revoking": {
      const link = state.link;
      const url = shareLinkUrl(opts.origin, link);
      const inFlight = state.kind !== "on";
      return {
        ...base,
        link,
        url,
        status: shareViewSummary(link, opts.now),
        // Copy is offered for every live link, including one a colleague minted:
        // the id is the whole secret and this viewer is already holding it.
        note: url ? SHARE_REPLACE_NOTE : null,
        error: state.kind === "on" ? (state.error ?? null) : null,
        buttons: {
          ...(url ? { copy: { label: SHARE_COPY_LABEL, disabled: inFlight } } : {}),
          replace: {
            label: state.kind === "replacing" ? SHARE_REPLACING_LABEL : SHARE_REPLACE_LABEL,
            disabled: inFlight,
          },
          turnOff: {
            label: state.kind === "revoking" ? SHARE_TURNING_OFF_LABEL : SHARE_TURN_OFF_LABEL,
            disabled: inFlight,
          },
        },
      };
    }

    case "revoked":
      return {
        ...base,
        // Nothing is public now, so the warnings have nothing to warn about.
        bullets: [],
        status: SHARE_REVOKED_NOTICE,
        buttons: { create: { label: SHARE_CREATE_AGAIN_LABEL, disabled: false } },
      };

    case "unsure":
      return {
        ...base,
        bullets: [],
        error: state.message,
        buttons: { checkAgain: { label: SHARE_CHECK_AGAIN_LABEL, disabled: false } },
      };

    case "unavailable":
      // Core's refusal, in core's words, and no button that would retry it.
      return { ...base, bullets: [], error: state.message };

    default: {
      const never: never = state;
      return never;
    }
  }
}
