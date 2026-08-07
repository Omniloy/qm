import { html, type TemplateResult } from "lit";
import { FolderOpen, Link, RefreshCw, TriangleAlert } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import {
  bandState,
  canAttach,
  accessLabel,
  requestAccessUrl,
  rowStatus,
  rowIsInert,
  type BandState,
  type ConnectorState,
  type MountRow,
} from "./drive-mount";

/**
 * The Drive folders band on the Files page.
 *
 * Renders no host of its own — files.ts owns the host and lit patches this in.
 * Every decision about *what* to say lives in drive-mount.ts; this file is the
 * markup and the fetches.
 */

let mounts: MountRow[] = [];
let connector: ConnectorState = { configured: false, connected: false, needsReconnect: false };
let notice = "";
let busy = false;
let loadedScope = "";

export function resetDriveFoldersState(): void {
  mounts = [];
  connector = { configured: false, connected: false, needsReconnect: false };
  notice = "";
  busy = false;
  loadedScope = "";
}

interface MountsResponse {
  mounts?: MountRow[];
}

interface ConnectorsResponse {
  providers?: Record<string, { connected?: boolean; needsReconnect?: boolean }>;
}

export async function loadDriveMounts(scopeId: string, rerender: () => void): Promise<void> {
  if (!scopeId) return;
  loadedScope = scopeId;
  try {
    // The connector shape tells us which of the unusable states applies:
    // absent provider means the org never configured Google, present but
    // unconnected means this person has not signed in.
    const [conn, list] = await Promise.all([
      api<ConnectorsResponse>("/api/connectors").catch(() => ({}) as ConnectorsResponse),
      api<MountsResponse>(`/api/mounts?scope=${encodeURIComponent(scopeId)}`).catch(() => ({}) as MountsResponse),
    ]);
    const google = conn.providers?.google;
    connector = {
      configured: Boolean(google),
      connected: Boolean(google?.connected),
      needsReconnect: Boolean(google?.needsReconnect),
    };
    mounts = list.mounts ?? [];
    notice = "";
  } catch (e) {
    notice = errMessage(e);
  }
  rerender();
}

async function refreshOne(id: string, rerender: () => void): Promise<void> {
  busy = true;
  rerender();
  try {
    // Only this person's view — the server invalidates the caller's cache
    // entry alone, so a teammate's listing is untouched.
    await api(`/api/mounts/${encodeURIComponent(id)}/refresh`, { method: "POST" });
    await loadDriveMounts(loadedScope, rerender);
  } catch (e) {
    notice = errMessage(e);
  } finally {
    busy = false;
    rerender();
  }
}

async function refreshAll(rerender: () => void): Promise<void> {
  busy = true;
  rerender();
  try {
    await Promise.all(mounts.map((m) => api(`/api/mounts/${encodeURIComponent(m.id)}/refresh`, { method: "POST" })));
    await loadDriveMounts(loadedScope, rerender);
  } catch (e) {
    notice = errMessage(e);
  } finally {
    busy = false;
    rerender();
  }
}

function emptyCard(title: string, body: string, action?: TemplateResult): TemplateResult {
  return html`<div class="kc-empty">
    ${icon(Link, 20)}
    <div>
      <strong>${title}</strong><span>${body}</span>
      ${action ?? ""}
    </div>
  </div>`;
}

function mountRowTpl(m: MountRow, state: BandState, now: number, rerender: () => void): TemplateResult {
  const inert = rowIsInert(m, state);
  const link = requestAccessUrl(m);
  return html`<div class="drive-mount-row ${inert ? "inert" : ""}">
    ${icon(FolderOpen, 16)}
    <div class="drive-mount-name">
      <strong>${m.name}</strong>
      <span>${m.displayPath ?? "Google Drive"}${m.createdBy ? ` · attached by ${m.createdBy}` : ""}</span>
    </div>
    <span class="badge">${accessLabel(m.mode)}</span>
    <span class="kc-state ${m.inaccessible ? "warning" : ""}">${rowStatus(m, state, now)}</span>
    ${
      m.inaccessible && link
        ? html`<a class="link" href=${link} target="_blank" rel="noopener">Request access in Drive</a>`
        : state === "populated"
          ? html`<button class="link" ?disabled=${busy} @click=${() => void refreshOne(m.id, rerender)}>
              ${icon(RefreshCw, 14)} Refresh
            </button>`
          : ""
    }
  </div>`;
}

export function driveBandTpl(now: number, rerender: () => void, onAttach: () => void): TemplateResult {
  const state = bandState(connector, mounts);

  const header = html`<div class="drive-band-head">
    <strong>Drive folders</strong>
    ${mounts.length ? html`<span class="badge">${mounts.length} attached</span>` : ""}
    <span class="spacer"></span>
    ${
      state === "populated"
        ? html`<button class="link" ?disabled=${busy} @click=${() => void refreshAll(rerender)}>Refresh all</button>`
        : ""
    }
    ${canAttach(state) ? html`<button class="primary" @click=${onAttach}>Attach folder</button>` : ""}
  </div>`;

  let body: TemplateResult;
  switch (state) {
    case "not-configured":
      // No action offered: nothing this person can do resolves it.
      body = emptyCard(
        "Google Workspace is not set up here",
        "An admin has to configure the Google connector before folders can be attached. Ask whoever runs your QM workspace.",
      );
      break;
    case "not-connected":
      body = emptyCard(
        "Connect Google to use Drive folders",
        "The agent works in Drive as you, with your own account — never a teammate's. Connect once, then attach the folders it may touch.",
        html`<a class="link" href="#keychain">Connect Google Workspace</a>`,
      );
      break;
    case "needs-reconnect":
      body = html`<div class="kc-state warning drive-band-warning">
          ${icon(TriangleAlert, 16)} Google needs reconnecting — attached folders are unavailable until you sign in
          again. <a class="link" href="#keychain">Reconnect</a>
        </div>
        <div class="drive-mount-list">${mounts.map((m) => mountRowTpl(m, state, now, rerender))}</div>`;
      break;
    case "empty":
      body = emptyCard(
        "No folders attached yet",
        "Attach a Drive folder and the agent can read, create and edit files in it — Docs, Sheets and Slides included.",
      );
      break;
    case "populated":
      body = html`<div class="drive-mount-list">${mounts.map((m) => mountRowTpl(m, state, now, rerender))}</div>`;
      break;
  }

  return html`<section class="card drive-band">
    ${header} ${notice ? html`<div class="kc-state warning">${notice}</div>` : ""} ${body}
  </section>`;
}
