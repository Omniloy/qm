import { html, nothing, type TemplateResult } from "lit";
import { Globe } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { resetRowMenus, rowMenuTpl } from "./row-actions";
import { paneVisible, paneStatus, paneActions, primaryAction, timeLeft, type LiveSession } from "./browser-pane-state";

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
 * input go straight between the person's tab and the provider; QM carries
 * neither. Verified against production: SPA_CSP already allows it.
 */

let session: LiveSession | null = null;
let collapsed = false;
let busy = false;
let notice = "";
let inFlight = false;

let timer: ReturnType<typeof setInterval> | null = null;

export function resetBrowserPane(): void {
  stopBrowserPanePolling();
  session = null;
  collapsed = false;
  busy = false;
  notice = "";
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
    session = next;
    // A browser that appears, or one that changes hands, is worth looking at.
    if (next && changed) collapsed = false;
    if (changed) rerender();
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
    window.open(s.liveViewUrl, "_blank", "noopener");
    return;
  }
  busy = true;
  notice = "";
  rerender();
  try {
    if (id === "end") {
      await api(`/api/browser/session/${encodeURIComponent(s.sessionId)}`, { method: "DELETE" });
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
  if (!paneVisible(session, threadRef, now)) return nothing;
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

  return html`<section class="browser-pane ${status.human ? "human" : ""} ${collapsed ? "collapsed" : ""}">
    ${header} ${notice ? html`<div class="kc-state warning">${notice}</div>` : nothing}
    ${
      collapsed
        ? nothing
        : html`<iframe
            class="browser-pane-view"
            src=${s.liveViewUrl}
            title="Your browser"
            allow="clipboard-read; clipboard-write"
          ></iframe>`
    }
  </section>`;
}
