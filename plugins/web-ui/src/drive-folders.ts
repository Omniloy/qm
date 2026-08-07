import { html, nothing, type TemplateResult } from "lit";
import { FolderOpen, Link, RefreshCw, TriangleAlert } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import {
  bandState,
  canAttach,
  mountNameError,
  slugFromFolderName,
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

interface PickerFolder {
  id: string;
  name: string;
}

/** Breadcrumb trail into Drive, so "back" is possible without re-opening. */
let picker: { trail: PickerFolder[]; folders: PickerFolder[]; loading: boolean; error: string } | null = null;
let pending: { folder: PickerFolder; name: string; mode: "ro" | "rw"; error: string } | null = null;
let detaching: MountRow | null = null;

export function resetDriveFoldersState(): void {
  mounts = [];
  connector = { configured: false, connected: false, needsReconnect: false };
  notice = "";
  busy = false;
  loadedScope = "";
  picker = null;
  pending = null;
  detaching = null;
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

/* ---------------------------------------------------------------- picker */

interface BrowseResponse {
  folders?: PickerFolder[];
}

const ROOT: PickerFolder = { id: "root", name: "My Drive" };

async function browseInto(folder: PickerFolder, rerender: () => void, descend: boolean): Promise<void> {
  if (!picker) return;
  picker.loading = true;
  picker.error = "";
  rerender();
  try {
    const r = await api<BrowseResponse>(`/api/mounts/browse?parent=${encodeURIComponent(folder.id)}`);
    if (!picker) return;
    if (descend) picker.trail = [...picker.trail, folder];
    picker.folders = r.folders ?? [];
  } catch (e) {
    if (picker) picker.error = errMessage(e);
  } finally {
    if (picker) picker.loading = false;
    rerender();
  }
}

export function openDrivePicker(rerender: () => void = () => {}): void {
  picker = { trail: [ROOT], folders: [], loading: true, error: "" };
  void browseInto(ROOT, rerender, false);
}

export function drivePickerTpl(scopeId: string, rerender: () => void): TemplateResult | typeof nothing {
  if (pending) return attachConfirmTpl(scopeId, rerender);
  if (detaching) return detachConfirmTpl(rerender);
  if (!picker) return nothing;

  const here = picker.trail[picker.trail.length - 1]!;
  const close = (): void => {
    picker = null;
    rerender();
  };

  return html`<div class="kc-confirm drive-picker">
    <div class="drive-picker-head">
      <strong>Choose a folder</strong>
      <span class="spacer"></span>
      <button class="link" @click=${close}>Cancel</button>
    </div>
    <div class="drive-crumbs">
      ${picker.trail.map(
        (f, i) =>
          html`<button
            class="link"
            ?disabled=${i === picker!.trail.length - 1}
            @click=${() => {
            picker!.trail = picker!.trail.slice(0, i + 1);
            void browseInto(f, rerender, false);
          }}
          >
            ${f.name}
          </button>`,
      )}
    </div>
    ${picker.error ? html`<div class="kc-state warning">${picker.error}</div>` : ""}
    ${
      picker.loading
        ? html`<div class="kc-state">Loading…</div>`
        : picker.folders.length
          ? html`<div class="drive-mount-list">
              ${picker.folders.map(
              (f) =>
                html`<div class="drive-mount-row">
                  ${icon(FolderOpen, 16)}
                  <div class="drive-mount-name"><strong>${f.name}</strong></div>
                  <button class="link" @click=${() => void browseInto(f, rerender, true)}>Open</button>
                  <button
                    class="primary"
                    @click=${() => {
                    pending = { folder: f, name: slugFromFolderName(f.name), mode: "rw", error: "" };
                    picker = null;
                    rerender();
                  }}
                  >
                    Attach
                  </button>
                </div>`,
            )}
            </div>`
          : html`<div class="kc-state">No subfolders here.</div>`
    }
    <div class="drive-picker-foot">
      <button
        class="primary"
        ?disabled=${picker.trail.length < 2}
        @click=${() => {
          pending = { folder: here, name: slugFromFolderName(here.name), mode: "rw", error: "" };
          picker = null;
          rerender();
        }}
      >
        Attach “${here.name}”
      </button>
    </div>
  </div>`;
}

function attachConfirmTpl(scopeId: string, rerender: () => void): TemplateResult {
  const p = pending!;
  return html`<div class="kc-confirm drive-picker">
    <strong>Attach “${p.folder.name}”</strong>
    <label
      >Name in QM
      <input
        .value=${p.name}
        @input=${(e: Event) => {
          p.name = (e.target as HTMLInputElement).value;
          p.error = "";
        }}
      />
    </label>
    <div class="drive-mode">
      <button
        class="link ${p.mode === "rw" ? "active" : ""}"
        @click=${() => {
        p.mode = "rw";
        rerender();
      }}
      >
        Read &amp; write
      </button>
      <button
        class="link ${p.mode === "ro" ? "active" : ""}"
        @click=${() => {
        p.mode = "ro";
        rerender();
      }}
      >
        Read only
      </button>
    </div>
    <p class="kc-state">
      QM may use your Google account to read${p.mode === "rw" ? ", create and edit" : ""} files in
      <strong>${p.folder.name}</strong> on your behalf. Teammates use their own Google accounts, not yours.
    </p>
    ${p.error ? html`<div class="kc-state warning">${p.error}</div>` : ""}
    <div class="drive-picker-foot">
      <button
        class="link"
        @click=${() => {
        pending = null;
        rerender();
      }}
      >
        Cancel
      </button>
      <button class="primary" ?disabled=${busy} @click=${() => void doAttach(scopeId, rerender)}>Attach folder</button>
    </div>
  </div>`;
}

async function doAttach(scopeId: string, rerender: () => void): Promise<void> {
  const p = pending;
  if (!p) return;
  // Validate here as well as in core: a bad name should not cost a round trip.
  const nameError = mountNameError(p.name);
  if (nameError) {
    p.error = nameError;
    rerender();
    return;
  }
  busy = true;
  rerender();
  try {
    await api("/api/mounts", {
      method: "POST",
      body: JSON.stringify({
        scopeId,
        externalId: p.folder.id,
        name: p.name,
        mode: p.mode,
        displayPath: p.folder.name,
      }),
    });
    pending = null;
    await loadDriveMounts(scopeId, rerender);
  } catch (e) {
    p.error = errMessage(e);
  } finally {
    busy = false;
    rerender();
  }
}

export function askDetach(m: MountRow, rerender: () => void): void {
  detaching = m;
  rerender();
}

function detachConfirmTpl(rerender: () => void): TemplateResult {
  const m = detaching!;
  return html`<div class="kc-confirm drive-picker">
    <strong>Detach “${m.name}”?</strong>
    <p class="kc-state">
      The agent stops seeing this folder in every conversation in this scope. Nothing in Drive changes, and nothing is
      deleted.
    </p>
    <div class="drive-picker-foot">
      <button
        class="link"
        @click=${() => {
        detaching = null;
        rerender();
      }}
      >
        Cancel
      </button>
      <button
        class="primary"
        ?disabled=${busy}
        @click=${async () => {
          busy = true;
          rerender();
          try {
            await api(`/api/mounts/${encodeURIComponent(m.id)}`, { method: "DELETE" });
            detaching = null;
            await loadDriveMounts(loadedScope, rerender);
          } catch (e) {
            notice = errMessage(e);
          } finally {
            busy = false;
            rerender();
          }
        }}
      >
        Detach
      </button>
    </div>
  </div>`;
}
