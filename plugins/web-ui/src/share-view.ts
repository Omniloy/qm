/**
 * The anonymous shared-conversation page.
 *
 * Three rules decide everything in this file, and each of them is a rule about what this module
 * must NOT reach for:
 *
 *  1. It never imports `./chat`. chat.ts statically imports `./shell` (mountShell,
 *     setSigninRequiredHandler) and `./sessions` (refreshSessions), so importing it would drag the
 *     whole signed-in application — and its sign-in redirect — into a page a stranger loads.
 *     The consequence used to be that the markdown sanitizer — which only chat.ts's module body
 *     installed — would not be installed here, and a shared message would be stored XSS on the
 *     app origin. The install now lives in markdown-sanitize.ts's own module body, so importing
 *     that module IS the install; the explicit call below is belt and braces.
 *
 *  2. It never calls core-bridge's `api()`. That helper calls `reportSigninRequired(...)` on any
 *     401 (core-bridge.ts:462) and shell.ts's handler re-renders all of #app as an auth gate — so
 *     one unlucky 401 would replace a perfectly readable transcript with a login wall. Everything
 *     here goes through bare `fetch()`, and a non-200 never mounts an auth gate.
 *
 *  3. It talks to exactly one path prefix: `/api/public/shares/`. No /me, no /api/sessions, no
 *     /api/runtime-config, no /api/files, no EventSource. The share is LIVE, so freshness comes
 *     from a ~10s poll rather than a delivery stream a stranger's browser would retry forever.
 */
import { marked } from "marked";
import { installMarkdownSanitizer } from "./markdown-sanitize.ts";
import { escapeLoneDollars } from "./markdown-dollars.ts";
import { UI_BASE } from "./deep-link.ts";
import { sharerName } from "./share-state.ts";
import { BRAND } from "../../chassis/src/brand.ts";

// Must run before the first marked.parse() below. Idempotent — chat.ts calls it too.
installMarkdownSanitizer();

/* ------------------------------------------------------------------ wire types */

/** Mirrors SharedFile from src/sessions/share-redaction.ts. */
export interface SharedFile {
  name: string;
  artifactId: string;
  /**
   * No `mimetype`, deliberately, and it is not merely unused: the field is the
   * first thing a future "preview images inline" change would reach for, and
   * the stored type comes from an uploaded filename. Not having it here is what
   * keeps the download chip below the only presentation this page can offer.
   */
  sizeBytes?: number;
}

/** Mirrors SharedEntry from src/sessions/share-redaction.ts. */
export interface SharedEntry {
  i: number;
  role: "user" | "assistant";
  text: string;
  at?: number;
  files?: SharedFile[];
}

/**
 * Core decides this, never the page. `sessionId` is present only when access === "member";
 * the payload deliberately carries no threadRef, no scopeId and no principal id.
 */
export type ShareAccess = "anonymous" | "member" | "outsider";

export interface SharedTranscript {
  title?: string;
  createdAt?: number;
  sharerLabel?: string;
  viewerLabel?: string;
  access: ShareAccess;
  entries: SharedEntry[];
  sessionId?: string;
}

export type ShareStatus = "loading" | "ready" | "dead" | "error";

/* ------------------------------------------------------------------ constants */

/** Anchored, never a prefix test — the authed relay is one typo away from this. */
export const SHARE_PATH_RE = /^\/share\/([A-Za-z0-9-]{32,80})$/;

/** The share is LIVE, so we re-read rather than snapshot. Ten seconds is the whole freshness budget. */
export const POLL_MS = 10_000;

/** Every network call this page makes starts with this. Asserted by test. */
export const SHARE_API_PREFIX = "/api/public/shares/";

export const SHARE_COPY = {
  anonymousBanner: "You're viewing a shared conversation",
  signIn: "Sign in",
  outsiderBannerNamed: (name: string): string =>
    `You're signed in as ${name}, but you don't have access to this project. ` +
    `You can read this conversation because someone shared it with you.`,
  outsiderBanner:
    "You're signed in, but you don't have access to this project. " +
    "You can read this conversation because someone shared it with you.",
  memberBanner: "You're a member of this project",
  openInApp: `Open in ${BRAND.productName}`,
  /**
   * Verbatim the dialog's qualifier, and the qualifier is the point: a log the agent wrote from
   * command output ships as a downloadable attachment, so "command output isn't included" would
   * be false on a page that is rendering a download chip for exactly that file. It is true of the
   * transcript and only of the transcript.
   */
  footerNote:
    "Messages and attached files are shared. Tool activity, command output, and thinking are not shown in the transcript.",
  deadTitle: "This link isn't active",
  deadBody: "The link was turned off, or it never existed. Ask whoever shared it for a new one.",
  offlineNote: "Couldn't reach the server. Still showing what loaded earlier.",
  untitled: "Shared conversation",
} as const;

/* ------------------------------------------------------------------ url helpers */

/** `/share/<id>` (under UI_BASE) -> the share id, or null. Anchored on purpose. */
export function shareIdFromPath(pathname: string): string | null {
  const base = UI_BASE;
  const rest = base && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  return SHARE_PATH_RE.exec(rest)?.[1] ?? null;
}

/**
 * The only query this page ever sends.
 *
 * There is no `?t=` capability token on a share URL and core mints none: the share id IS the
 * secret, and it is re-authorized against the sharer's live access on every request. Threading a
 * second token through would have been a parameter no server reads — and, because the dialog made
 * its Copy button conditional on receiving one, a link nobody could ever copy.
 */
function withCursor(path: string, sinceIndex?: number | null): string {
  if (typeof sinceIndex !== "number" || !Number.isInteger(sinceIndex) || sinceIndex < 0) return path;
  return `${path}?sinceIndex=${sinceIndex}`;
}

/**
 * `sinceIndex` is the highest index already on screen, not that index plus one. The relay's cursor
 * semantics are the server's to define; asking for one entry we already have costs a duplicate the
 * reconcile drops on the floor, whereas asking for one too many would silently lose a message —
 * and a live share that quietly stops updating is worse than a slightly chatty one.
 */
export function shareApiPath(shareId: string, sinceIndex?: number | null): string {
  return withCursor(`${UI_BASE}${SHARE_API_PREFIX}${encodeURIComponent(shareId)}`, sinceIndex);
}

/**
 * Attachments are served through the share, never through /api/files/:id/content — that route
 * re-checks the viewer's ACL and would 404 for a link holder, and pointing at it would also be
 * the page quietly asking for credentials it does not have.
 */
export function shareFileHref(shareId: string, artifactId: string): string {
  return `${UI_BASE}${SHARE_API_PREFIX}${encodeURIComponent(shareId)}/files/${encodeURIComponent(artifactId)}`;
}

export function signInHref(currentPath: string): string {
  return `${UI_BASE}/auth/login?returnTo=${encodeURIComponent(currentPath)}`;
}

export function openInAppHref(sessionId: string): string {
  return `${UI_BASE}/?session=${encodeURIComponent(sessionId)}`;
}

/* ------------------------------------------------------------------ rendering */

/**
 * The only place this module produces HTML from untrusted text. `marked`'s postprocess hook is
 * DOMPurify (installed above), so `<script>`, `<iframe>`, `on*=` handlers and `javascript:` hrefs
 * do not survive. Both roles go through it: a hostile payload is just as likely to arrive as a
 * user message as an assistant one.
 */
export function renderMarkdown(text: string): string {
  return String(marked.parse(escapeLoneDollars(text ?? ""), { async: false }));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A download chip. Never an <img>, never a preview, never an inline frame: the bytes are
 * attacker-influenced and the share origin is the app origin, so the only safe presentation is a
 * link the reader chooses to follow. `download` plus the route's forced content-disposition make
 * that a save, not a navigation.
 */
export function fileChipEl(file: SharedFile, shareId: string): HTMLAnchorElement {
  const a = el("a", "file-chip share-file-chip");
  a.href = shareFileHref(shareId, file.artifactId);
  a.setAttribute("download", file.name || "attachment");
  a.rel = "noopener noreferrer";
  a.appendChild(el("span", undefined, file.name || "attachment"));
  const size = typeof file.sizeBytes === "number" ? formatBytes(file.sizeBytes) : "";
  if (size) a.appendChild(el("small", undefined, size));
  return a;
}

/**
 * No `data-index` on the row. The entry's `i` is its position in the *unredacted* transcript, so
 * publishing it would let a reader count exactly how many tool calls, thinking blocks and hidden
 * turns were withheld between two messages — a shape of the private conversation, for free, in
 * view-source.
 */
export function messageEl(entry: SharedEntry, shareId: string): HTMLElement {
  const row = el("article", `message-row ${entry.role === "user" ? "user-row" : "assistant-row"}`);
  const body = entry.role === "user" ? el("div", "message-bubble user-bubble") : el("div", "assistant-body");
  const prose = el("div", "share-prose");
  prose.innerHTML = renderMarkdown(entry.text);
  body.appendChild(prose);
  const files = entry.files ?? [];
  if (files.length) {
    const strip = el("div", "message-files");
    for (const f of files) strip.appendChild(fileChipEl(f, shareId));
    body.appendChild(strip);
  }
  row.appendChild(body);
  if (typeof entry.at === "number" && Number.isFinite(entry.at)) {
    row.title = new Date(entry.at).toLocaleString();
  }
  return row;
}

/**
 * The access strip. All three states read the transcript; they differ only in what they offer
 * next. The outsider gets no sign-in button on purpose — they are already signed in, so a sign-in
 * button there reads as the page being broken.
 */
export function accessStripEl(data: SharedTranscript, currentPath: string): HTMLElement {
  const strip = el("div", `share-access share-access-${data.access}`);
  strip.setAttribute("role", "status");
  if (data.access === "member") {
    strip.appendChild(el("span", "share-access-text", SHARE_COPY.memberBanner));
    if (data.sessionId) {
      const open = el("a", "share-access-action share-open-app", SHARE_COPY.openInApp);
      open.href = openInAppHref(data.sessionId);
      strip.appendChild(open);
    }
    return strip;
  }
  if (data.access === "outsider") {
    const name = (data.viewerLabel ?? "").trim();
    strip.appendChild(
      el("span", "share-access-text", name ? SHARE_COPY.outsiderBannerNamed(name) : SHARE_COPY.outsiderBanner),
    );
    return strip;
  }
  strip.appendChild(el("span", "share-access-text", SHARE_COPY.anonymousBanner));
  const signIn = el("a", "share-access-action share-signin", SHARE_COPY.signIn);
  signIn.href = signInHref(currentPath);
  strip.appendChild(signIn);
  return strip;
}

/**
 * The sharer's label arrives from core, and the codebase's standard display-name fallback is the
 * principal id — which is an email. An anonymous reader has no business being handed a colleague's
 * address, nor the local part of one, so an id-shaped label falls back to a phrase.
 *
 * This is `sharerName` from ./share-state.ts, not a second rule: the dialog and the public page
 * were deciding the same question two different ways, and the page strangers read is not the one
 * that should have the looser rule.
 */
export function sharerDisplayLabel(label: string | undefined): string {
  return sharerName(label);
}

export function deadLinkEl(): HTMLElement {
  const wrap = el("div", "share-dead");
  wrap.appendChild(el("h1", "share-dead-title", SHARE_COPY.deadTitle));
  wrap.appendChild(el("p", "share-dead-body", SHARE_COPY.deadBody));
  return wrap;
}

/* ------------------------------------------------------------------ fetching */

export interface ShareFetchResult {
  kind: "ok" | "dead" | "error";
  data?: SharedTranscript;
  status: number;
}

/**
 * Bare fetch. Deliberately not core-bridge's `api()`: that reports a 401 to the sign-in handler,
 * which re-renders the entire app as an auth gate. Here a 401 is just an error we keep quiet
 * about, because an anonymous reader is *expected* to be unauthenticated.
 */
export async function fetchShare(
  shareId: string,
  fetchImpl: typeof fetch,
  sinceIndex?: number | null,
  signal?: AbortSignal,
): Promise<ShareFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(shareApiPath(shareId, sinceIndex), {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: "error", status: 0 };
  }
  // A revoked, swept or never-existent share is one indistinguishable response by design.
  if (res.status === 404 || res.status === 410) return { kind: "dead", status: res.status };
  if (!res.ok) return { kind: "error", status: res.status };
  try {
    const body = (await res.json()) as SharedTranscript;
    if (!body || !Array.isArray(body.entries)) return { kind: "error", status: res.status };
    return { kind: "ok", data: body, status: res.status };
  } catch {
    return { kind: "error", status: res.status };
  }
}

/* ------------------------------------------------------------------ the page */

export interface ShareViewOptions {
  shareId: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  currentPath?: () => string;
  isHidden?: () => boolean;
}

export interface ShareViewHandle {
  refresh(): Promise<void>;
  stop(): void;
  status(): ShareStatus;
  data(): SharedTranscript | null;
}

export function mountShareView(root: HTMLElement, opts: ShareViewOptions): ShareViewHandle {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const pollMs = opts.pollMs ?? POLL_MS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const currentPath = opts.currentPath ?? (() => `${window.location.pathname}${window.location.search}`);
  const isHidden = opts.isHidden ?? (() => typeof document !== "undefined" && document.hidden === true);

  let status: ShareStatus = "loading";
  // Read through a function, never the closed-over binding: control-flow narrowing across the
  // async poll boundary is exactly the thing that would silently drop the dead-link short-circuit.
  const currentStatus = (): ShareStatus => status;
  let latest: SharedTranscript | null = null;
  let timer: unknown = null;
  let stopped = false;
  const rows = new Map<number, { node: HTMLElement; key: string }>();

  root.textContent = "";
  const page = el("div", "share-page readonly-chat");
  const head = el("header", "share-head");
  const title = el("h1", "share-title", SHARE_COPY.untitled);
  const sub = el("p", "share-sub");
  head.appendChild(title);
  head.appendChild(sub);
  const accessSlot = el("div", "share-access-slot");
  const scroll = el("main", "chat-scroll share-scroll");
  const stack = el("div", "message-stack");
  scroll.appendChild(stack);
  const notice = el("p", "share-notice");
  notice.hidden = true;
  const foot = el("footer", "share-foot");
  foot.appendChild(el("span", "share-foot-note", SHARE_COPY.footerNote));
  page.appendChild(head);
  page.appendChild(accessSlot);
  page.appendChild(scroll);
  page.appendChild(notice);
  page.appendChild(foot);
  root.appendChild(page);

  /** The poll cursor: what we already have, so a live share re-reads only its tail. */
  function highestIndex(): number | null {
    let max: number | null = null;
    for (const i of rows.keys()) if (max === null || i > max) max = i;
    return max;
  }

  function rowKey(e: SharedEntry): string {
    return `${e.role}\u0000${e.text}\u0000${(e.files ?? []).map((f) => f.artifactId).join(",")}`;
  }

  /**
   * Append-mostly reconcile. The share is live, so a poll usually adds entries at the tail; we
   * never clear the stack, so a server that answers with a partial tail is handled the same way
   * as one that answers with the whole transcript.
   */
  function paintEntries(entries: SharedEntry[]): void {
    for (const entry of entries) {
      const key = rowKey(entry);
      const existing = rows.get(entry.i);
      if (existing && existing.key === key) continue;
      const node = messageEl(entry, opts.shareId);
      if (existing) {
        existing.node.replaceWith(node);
      } else {
        stack.appendChild(node);
      }
      rows.set(entry.i, { node, key });
    }
  }

  function paint(data: SharedTranscript): void {
    latest = data;
    title.textContent = data.title?.trim() || SHARE_COPY.untitled;
    const shared = sharerDisplayLabel(data.sharerLabel);
    sub.textContent = shared ? `Shared by ${shared}` : "";
    sub.hidden = !shared;
    accessSlot.textContent = "";
    accessSlot.appendChild(accessStripEl(data, currentPath()));
    paintEntries(data.entries);
  }

  function paintDead(): void {
    status = "dead";
    rows.clear();
    root.textContent = "";
    root.appendChild(deadLinkEl());
  }

  async function refresh(): Promise<void> {
    if (stopped || currentStatus() === "dead") return;
    const result = await fetchShare(opts.shareId, fetchImpl, highestIndex());
    if (stopped || currentStatus() === "dead") return;
    if (result.kind === "dead") {
      // Revocation is the whole containment story for a link with no expiry, so it takes effect
      // on the very next poll rather than on the next page load.
      paintDead();
      return;
    }
    if (result.kind === "error") {
      // Never reportSigninRequired, never swap in an auth gate: whatever is already on screen
      // stays on screen. A 401 here is the normal state of an anonymous reader.
      if (currentStatus() === "loading") {
        status = "error";
        notice.textContent = SHARE_COPY.offlineNote;
        notice.hidden = false;
      }
      return;
    }
    notice.hidden = true;
    status = "ready";
    if (result.data) paint(result.data);
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      if (stopped) return;
      const run = isHidden() ? Promise.resolve() : refresh();
      void run.finally(() => {
        if (currentStatus() !== "dead") schedule();
      });
    }, pollMs);
  }

  void refresh().finally(() => schedule());

  return {
    refresh,
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    status: currentStatus,
    data: () => latest,
  };
}

/**
 * Entry point for the `/share/<id>` route. Importing this module does nothing but install the
 * sanitizer; the page only exists once someone calls this, which is what makes it testable.
 */
export function startShareView(root?: HTMLElement | null): ShareViewHandle | null {
  const host = root ?? document.getElementById("app");
  if (!host) return null;
  const shareId = shareIdFromPath(window.location.pathname);
  if (!shareId) return null;
  document.body.classList.add("share-body");
  return mountShareView(host, { shareId });
}
