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
  type LiveSession,
} from "./browser-pane-state";

let session: LiveSession | null = null;
let ended: { threadRef: string; note: string } | null = null;
let collapsed = false;
let busy = false;
let notice = "";
let inFlight = false;

let timer: ReturnType<typeof setInterval> | null = null;

export function resetBrowserPane(): void {
  stopBrowserPanePolling();
  session = null;
  ended = null;
  collapsed = false;
  busy = false;
  notice = "";
  resetRowMenus();
}

export function startBrowserPanePolling(rerender: () => void, streaming: boolean): void {
  const wanted = streaming || session ? 3000 : 20_000;
  if (timer && wanted === currentInterval) return;
  stopBrowserPanePolling();
  currentInterval = wanted;
  void refreshBrowserPane(rerender);
  timer = setInterval(() => void refreshBrowserPane(rerender), wanted);
  (timer as { unref?: () => void }).unref?.();
}

let currentInterval = 0;

export function stopBrowserPanePolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
  currentInterval = 0;
}

interface LiveResponse {
  session?: LiveSession | null;
}

async function refreshBrowserPane(rerender: () => void): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await api<LiveResponse>("/api/browser/live").catch(() => null);
    if (!r) return;
    const next = r.session ?? null;
    const changed = next?.sessionId !== session?.sessionId || next?.controlMode !== session?.controlMode;
    if (session && !next) {
      ended = { threadRef: session.threadRef, note: endedNote(session.expiresAt <= Date.now() ? "expired" : "lost") };
    }
    if (next) ended = null;
    session = next;
    if (next && changed) collapsed = false;
    if (changed) rerender();
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
    if (s.liveViewUrl) window.open(s.liveViewUrl, "_blank", "noopener");
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

  return html`<section class="browser-pane ${status.human ? "human" : ""} ${collapsed ? "collapsed" : ""}">
    ${header} ${notice ? html`<div class="kc-state warning">${notice}</div>` : nothing}
    ${collapsed ? nothing : iframeBody(s)}
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
