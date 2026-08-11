import { html, nothing, type TemplateResult } from "lit";
import { Globe } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { resetRowMenus, rowMenuTpl } from "./row-actions";
import {
  paneVisible,
  paneStatus,
  paneActions,
  primaryAction,
  timeLeft,
  endedNote,
  frameInterval,
  toPageCoords,
  type LiveSession,
} from "./browser-pane-state";

/**
 * The browser a person has open, shown where the conversation that opened it
 * is.
 *
 * Renders in the chat's bottom dock beside liveWorkDock, which is the existing
 * home for "what is happening right now" and behaves the same way: absent
 * until there is something to show, never an empty state. No browser means no
 * pane, so there is nothing to dismiss and nothing to explain.
 *
 * The body is a cross-origin iframe of the provider's own viewer. Pixels and
 * input go straight between the person's tab and the provider; MiniOmni carries
 * neither. Verified against production: SPA_CSP already allows it.
 */

let session: LiveSession | null = null;
/**
 * The last browser this conversation showed, kept after it goes so the pane can
 * say what happened instead of disappearing. Cleared when a new one opens or
 * the person dismisses it.
 */
let ended: { threadRef: string; note: string } | null = null;
let collapsed = false;
let busy = false;
let notice = "";
let inFlight = false;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The last picture of a browser MiniOmni hosts itself, and the machinery to keep it
 * fresh.
 *
 * A vendor's browser renders itself inside an iframe and needs none of this.
 * Ours has no URL to embed — Chrome will not expose its debug port off
 * loopback — so the pane asks MiniOmni for frames and draws them. The upside is that
 * there is no bearer material in the pane at all.
 */
interface Frame {
  w: number;
  h: number;
  url: string;
  title: string;
  jpeg: string;
}
let frame: Frame | null = null;
let frameTimer: ReturnType<typeof setTimeout> | null = null;
let frameInFlight = false;
let frameFailures = 0;
/** The draw function to call when a frame lands, kept for the visibility listener. */
let lastRerender: (() => void) | null = null;

function stopFrames(): void {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = null;
}

/**
 * Fetch one frame, then schedule the next.
 *
 * A chain rather than an interval: frames take about 145ms to produce and the
 * network adds more, so a fixed interval would stack requests on a slow link
 * and make the picture lag further the worse things get.
 */
async function pumpFrames(rerender: () => void): Promise<void> {
  const s = session;
  if (!s || s.viewer !== "stream" || collapsed) return stopFrames();
  // Nobody is looking: check back rather than burning a frame a second. But
  // only once there is something to come back TO — skipping the very first
  // frame leaves the pane on "waiting for the browser" indefinitely, which is
  // indistinguishable from a broken browser.
  if (typeof document !== "undefined" && document.hidden && frame) {
    frameTimer = setTimeout(() => void pumpFrames(rerender), 2000);
    return;
  }
  if (!frameInFlight) {
    frameInFlight = true;
    try {
      const next = await api<Frame>(`/api/browser/session/${encodeURIComponent(s.sessionId)}/frame`);
      if (next?.jpeg) {
        frame = next;
        frameFailures = 0;
        rerender();
      }
    } catch {
      // A dropped frame is not worth a banner — the last picture stays up. But
      // a browser that has genuinely gone will fail every time, and the poll
      // backs off rather than hammering core forever.
      frameFailures += 1;
    } finally {
      frameInFlight = false;
    }
  }
  const wait = frameFailures > 3 ? 5000 : frameInterval(s);
  frameTimer = setTimeout(() => void pumpFrames(rerender), wait);
}

function syncFrames(rerender: () => void): void {
  lastRerender = rerender;
  const wanted = !!session && session.viewer === "stream" && !collapsed;
  if (wanted && !frameTimer) void pumpFrames(rerender);
  if (!wanted) stopFrames();
}

/**
 * Come back to a fresh picture, not a two-second-old one.
 *
 * While the tab is hidden the pane deliberately stops fetching, so the last
 * frame is however stale the person's absence made it. Waiting out the poll
 * before correcting that means the first thing they see on returning is a page
 * the browser has already left.
 */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !session || session.viewer !== "stream" || collapsed) return;
    const rerender = lastRerender;
    if (!rerender) return;
    stopFrames();
    void pumpFrames(rerender);
  });
}

/** Send what a person did in the pane. Refused by core unless they hold the wheel. */
async function sendInput(body: Record<string, unknown>, rerender: () => void): Promise<void> {
  const s = session;
  if (!s) return;
  try {
    await api(`/api/browser/session/${encodeURIComponent(s.sessionId)}/input`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Pull the next frame straight away rather than waiting out the interval:
    // input with a visible delay feels like it was dropped.
    stopFrames();
    void pumpFrames(rerender);
  } catch (e) {
    notice = errMessage(e);
    rerender();
  }
}

export function resetBrowserPane(): void {
  stopBrowserPanePolling();
  stopFrames();
  session = null;
  ended = null;
  collapsed = false;
  busy = false;
  notice = "";
  frame = null;
  frameFailures = 0;
  resetRowMenus();
}

/**
 * Watch for a browser appearing, and for control changing hands.
 *
 * Adaptive on purpose. A browser only ever appears because the agent just made
 * one, so a quiet conversation is checked rarely; once one is open, control can
 * change from either side and the pane has to keep up. Idempotent — every draw
 * calls it, and only the first one starts anything.
 */
export function startBrowserPanePolling(rerender: () => void, streaming: boolean): void {
  const wanted = streaming || session ? 3000 : 20_000;
  if (timer && wanted === currentInterval) return;
  stopBrowserPanePolling();
  currentInterval = wanted;
  void refreshBrowserPane(rerender);
  timer = setInterval(() => void refreshBrowserPane(rerender), wanted);
}

let currentInterval = 0;

export function stopBrowserPanePolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
  currentInterval = 0;
}

export function browserPaneSession(): LiveSession | null {
  return session;
}

interface LiveResponse {
  session?: LiveSession | null;
}

/**
 * Ask whether a browser is open.
 *
 * Called on mount and while a turn is streaming — a browser only ever appears
 * because the agent just made one, so there is no reason to poll a quiet
 * conversation.
 */
export async function refreshBrowserPane(rerender: () => void): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await api<LiveResponse>("/api/browser/live");
    const next = r.session ?? null;
    const changed = next?.sessionId !== session?.sessionId || next?.controlMode !== session?.controlMode;
    // A browser that was here and is not any more gets a headstone rather than
    // a silent removal — a crashed run should not look like a broken pane.
    if (session && !next) {
      ended = { threadRef: session.threadRef, note: endedNote(session.expiresAt <= Date.now() ? "expired" : "lost") };
    }
    if (next) ended = null;
    // A different browser means the picture on screen is of the old one.
    // Keeping it would show someone the wrong page and let them click it.
    if (next?.sessionId !== session?.sessionId) {
      frame = null;
      frameFailures = 0;
    }
    session = next;
    if (next && changed) collapsed = false;
    if (changed) rerender();
    // Restart the frame chain if it has stopped. Otherwise the only thing that
    // starts it is a re-render, and the only thing that causes a re-render is a
    // frame arriving — so one interruption freezes the picture permanently,
    // showing a page the browser left long ago. This poll runs regardless, so
    // it is the one place that can always recover.
    syncFrames(rerender);
  } catch {
    // A failed poll is not worth a banner: the pane simply does not change.
    // Real failures surface on the actions, which a person is waiting on.
  } finally {
    inFlight = false;
  }
}

async function act(id: string, rerender: () => void): Promise<void> {
  const s = session;
  if (!s) return;
  if (id === "minimize") {
    collapsed = true;
    rerender();
    return;
  }
  if (id === "open") {
    // Guarded as well as hidden: a streamed browser has no URL, and opening
    // `undefined` gives a blank tab rather than an error anyone can act on.
    if (s.viewer === "iframe" && s.liveViewUrl) window.open(s.liveViewUrl, "_blank", "noopener");
    return;
  }
  busy = true;
  notice = "";
  rerender();
  try {
    if (id === "end") {
      await api(`/api/browser/session/${encodeURIComponent(s.sessionId)}`, { method: "DELETE" });
      ended = { threadRef: s.threadRef, note: endedNote("ended") };
      session = null;
    } else {
      const mode = id === "take" ? "human_control" : "agent";
      const r = await api<{ session?: LiveSession }>(
        `/api/browser/session/${encodeURIComponent(s.sessionId)}/handoff`,
        { method: "POST", body: JSON.stringify({ mode }) },
      );
      session = r.session ?? session;
      // Taking the wheel is pointless behind a collapsed strip.
      if (mode === "human_control") collapsed = false;
    }
  } catch (e) {
    notice = errMessage(e);
  } finally {
    busy = false;
    rerender();
  }
}

export function browserPaneTpl(threadRef: string | null, rerender: () => void): TemplateResult | typeof nothing {
  const now = Date.now();
  if (!paneVisible(session, threadRef, now)) {
    if (!ended || !threadRef || ended.threadRef !== threadRef) return nothing;
    return html`<section class="browser-pane ended">
      <div class="browser-pane-head">
        <span class="tool-icon">${icon(Globe, 15)}</span>
        <strong>Your browser</strong>
        <span class="kc-state">${ended.note}</span>
        <span class="spacer"></span>
        <button
          class="btn compact"
          type="button"
          @click=${() => {
            ended = null;
            rerender();
          }}
        >
          Dismiss
        </button>
      </div>
    </section>`;
  }
  const s = session!;
  const status = paneStatus(s);
  const primary = primaryAction(s);
  const left = timeLeft(s, now);

  const header = html`<div class="browser-pane-head">
    <span class="tool-icon">${icon(Globe, 15)}</span>
    <strong>Your browser</strong>
    <span class="badge ${status.human ? "accent" : ""}">${status.label}</span>
    ${left ? html`<span class="kc-state">${left}</span>` : nothing}
    <span class="spacer"></span>
    <button class="btn" type="button" ?disabled=${busy} @click=${() => void act(primary.id, rerender)}>
      ${busy ? "…" : primary.label}
    </button>
    ${
      collapsed
        ? html`<button
            class="btn compact"
            type="button"
            title="Expand"
            @click=${() => {
              collapsed = false;
              rerender();
            }}
          >
            ${icon(Globe, 13)}
          </button>`
        : nothing
    }
    ${rowMenuTpl(`browser:${s.sessionId}`, "your browser", paneActions(s), (id) => void act(id, rerender), rerender)}
  </div>`;

  syncFrames(rerender);

  return html`<section class="browser-pane ${status.human ? "human" : ""} ${collapsed ? "collapsed" : ""}">
    ${header} ${notice ? html`<div class="kc-state warning">${notice}</div>` : nothing}
    ${collapsed ? nothing : s.viewer === "stream" ? streamBody(s, rerender) : iframeBody(s)}
  </section>`;
}

function iframeBody(s: LiveSession): TemplateResult {
  return html`<iframe
    class="browser-pane-view"
    src=${s.liveViewUrl ?? ""}
    title="Your browser"
    allow="clipboard-read; clipboard-write"
  ></iframe>`;
}

/** Named keys travel as keys; everything else is text the page should receive. */
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

function streamBody(s: LiveSession, rerender: () => void): TemplateResult {
  const human = s.controlMode === "human_control";
  if (!frame) {
    return html`<div class="browser-pane-view waiting">
      <span class="kc-state">${frameFailures > 3 ? "Cannot reach that browser." : "Waiting for the browser…"}</span>
    </div>`;
  }
  return html`<img
    class="browser-pane-view ${human ? "drivable" : ""}"
    src=${`data:image/jpeg;base64,${frame.jpeg}`}
    alt=${frame.title || "Your browser"}
    title=${human ? frame.url : "Take control to click and type"}
    tabindex=${human ? 0 : -1}
    draggable="false"
    @click=${(e: MouseEvent) => {
      // Clicking while the agent drives is not an error worth a message — the
      // header already says who has the wheel, and the cursor says it too.
      if (!human || !frame) return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const pt = toPageCoords(
        { x: e.clientX - r.left, y: e.clientY - r.top },
        { width: r.width, height: r.height },
        { w: frame.w, h: frame.h },
      );
      if (pt) void sendInput({ kind: "click", ...pt }, rerender);
    }}
    @wheel=${(e: WheelEvent) => {
      if (!human) return;
      e.preventDefault();
      void sendInput({ kind: "scroll", by: Math.round(e.deltaY) }, rerender);
    }}
    @keydown=${(e: KeyboardEvent) => {
      if (!human) return;
      if (NAMED_KEYS.has(e.key)) {
        e.preventDefault();
        void sendInput({ kind: "key", name: e.key }, rerender);
        return;
      }
      // Leave shortcuts alone: a person reaching for Cmd-R wants their own
      // browser to reload, not the remote one to receive an "r".
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        void sendInput({ kind: "type", text: e.key }, rerender);
      }
    }}
  />`;
}
