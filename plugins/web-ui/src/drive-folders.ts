import { html, nothing, type TemplateResult } from "lit";
import { FolderOpen, Link, RefreshCw, TriangleAlert } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import {
  bandState,
  canAttach,
  mountNameError,
  parseDriveFolderId,
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
let picker: {
  trail: PickerFolder[];
  folders: PickerFolder[];
  loading: boolean;
  error: string;
  query: string;
  searching: boolean;
} | null = null;
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
          ? html`<span class="drive-row-actions">
              <button class="btn" type="button" ?disabled=${busy} @click=${() => void refreshOne(m.id, rerender)}>
                ${icon(RefreshCw, 14)}
              </button>
              <button class="btn" type="button" @click=${() => askDetach(m, rerender)}>Detach</button>
            </span>`
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
        ? html`<button class="btn" type="button" ?disabled=${busy} @click=${() => void refreshAll(rerender)}>
            Refresh all
          </button>`
        : ""
    }
    ${canAttach(state) ? html`<button class="primary" type="button" @click=${onAttach}>Attach folder</button>` : ""}
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

/** Fetch whichever view the picker is in: a pasted id, a search, or a folder's children. */
async function fetchFolders(mode: { id?: string; q?: string; parent?: string }): Promise<PickerFolder[]> {
  const qs = mode.id
    ? `id=${encodeURIComponent(mode.id)}`
    : mode.q
      ? `q=${encodeURIComponent(mode.q)}`
      : `parent=${encodeURIComponent(mode.parent ?? "root")}`;
  const r = await api<BrowseResponse>(`/api/mounts/browse?${qs}`);
  return r.folders ?? [];
}

async function browseInto(folder: PickerFolder, rerender: () => void, descend: boolean): Promise<void> {
  if (!picker) return;
  picker.loading = true;
  picker.error = "";
  picker.searching = false;
  rerender();
  try {
    const folders = await fetchFolders({ parent: folder.id });
    if (!picker) return;
    if (descend) picker.trail = [...picker.trail, folder];
    picker.folders = folders;
  } catch (e) {
    if (picker) picker.error = errMessage(e);
  } finally {
    if (picker) picker.loading = false;
    rerender();
  }
}

/** One box handles both pasting a link and searching by name. */
async function runQuery(rerender: () => void): Promise<void> {
  if (!picker) return;
  const raw = picker.query.trim();
  if (!raw) return void browseInto(ROOT, rerender, false);

  picker.loading = true;
  picker.error = "";
  rerender();
  try {
    const id = parseDriveFolderId(raw);
    const folders = await fetchFolders(id ? { id } : { q: raw });
    if (!picker) return;
    picker.searching = true;
    picker.folders = folders;
    if (!folders.length) picker.error = id ? "No folder found for that link." : "No folders match that name.";
  } catch (e) {
    if (picker) picker.error = errMessage(e);
  } finally {
    if (picker) picker.loading = false;
    rerender();
  }
}

export function openDrivePicker(rerender: () => void = () => {}): void {
  picker = { trail: [ROOT], folders: [], loading: true, error: "", query: "", searching: false };
  void browseInto(ROOT, rerender, false);
}

function closeAll(rerender: () => void): void {
  picker = null;
  pending = null;
  detaching = null;
  rerender();
}

/** Every dialog shares one scrim so it lands centred instead of mid-page. */
function scrim(rerender: () => void, inner: TemplateResult): TemplateResult {
  return html`<div
    class="kc-dialog-scrim"
    @click=${(e: Event) => {
      if (e.target === e.currentTarget) closeAll(rerender);
    }}
  >
    ${inner}
  </div>`;
}

function beginAttach(f: PickerFolder, rerender: () => void): void {
  pending = { folder: f, name: slugFromFolderName(f.name), mode: "rw", error: "" };
  picker = null;
  rerender();
}

export function drivePickerTpl(scopeId: string, rerender: () => void): TemplateResult | typeof nothing {
  if (pending) return scrim(rerender, attachConfirmTpl(scopeId, rerender));
  if (detaching) return scrim(rerender, detachConfirmTpl(rerender));
  if (!picker) return nothing;

  const p = picker;
  const here = p.trail[p.trail.length - 1]!;

  return scrim(
    rerender,
    html`<section class="kc-confirm drive-picker">
      <header class="drive-picker-head">
        <h2>Attach a Drive folder</h2>
        <button class="btn" type="button" @click=${() => closeAll(rerender)}>Cancel</button>
      </header>

      <label class="drive-field">
        <span>Paste a Drive link, or search by name</span>
        <input
          type="text"
          placeholder="https://drive.google.com/drive/folders/… or “Design docs”"
          .value=${p.query}
          @input=${(e: Event) => {
            p.query = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") void runQuery(rerender);
          }}
        />
      </label>

      ${
        p.searching
          ? html`<button
              class="btn drive-back"
              type="button"
              @click=${() => {
                p.query = "";
                void browseInto(ROOT, rerender, false);
              }}
            >
              ← Back to My Drive
            </button>`
          : html`<nav class="drive-crumbs">
              ${p.trail.map(
              (f, i) =>
                html`<button
                  class="btn"
                  type="button"
                  ?disabled=${i === p.trail.length - 1}
                  @click=${() => {
                  p.trail = p.trail.slice(0, i + 1);
                  void browseInto(f, rerender, false);
                }}
                >
                  ${f.name}
                </button>`,
            )}
            </nav>`
      }
      ${p.error ? html`<p class="drive-note warning">${p.error}</p>` : ""}

      <div class="drive-results">
        ${
          p.loading
            ? html`<p class="drive-note">Loading…</p>`
            : p.folders.length
              ? p.folders.map(
                  (f) =>
                    html`<div class="drive-result-row">
                      ${icon(FolderOpen, 16)}
                      <span class="drive-result-name">${f.name}</span>
                      ${
                    p.searching
                      ? ""
                      : html`<button class="btn" type="button" @click=${() => void browseInto(f, rerender, true)}>
                          Open
                        </button>`
                  }
                      <button class="primary" type="button" @click=${() => beginAttach(f, rerender)}>Attach</button>
                    </div>`,
                )
              : html`<p class="drive-note">No subfolders here.</p>`
        }
      </div>

      ${
        p.searching || p.trail.length < 2
          ? ""
          : html`<footer class="drive-picker-foot">
              <button class="primary" type="button" @click=${() => beginAttach(here, rerender)}>
                Attach “${here.name}”
              </button>
            </footer>`
      }
    </section>`,
  );
}

function attachConfirmTpl(scopeId: string, rerender: () => void): TemplateResult {
  const p = pending!;
  return html`<section class="kc-confirm drive-picker">
    <header class="drive-picker-head"><h2>Attach “${p.folder.name}”</h2></header>

    <label class="drive-field">
      <span>Name in QM</span>
      <input
        type="text"
        .value=${p.name}
        @input=${(e: Event) => {
          p.name = (e.target as HTMLInputElement).value;
          p.error = "";
        }}
      />
    </label>

    <div class="drive-field">
      <span>Agent access</span>
      <div class="drive-mode">
        <button
          class="btn ${p.mode === "rw" ? "active" : ""}"
          type="button"
          @click=${() => {
          p.mode = "rw";
          rerender();
        }}
        >
          Read &amp; write
        </button>
        <button
          class="btn ${p.mode === "ro" ? "active" : ""}"
          type="button"
          @click=${() => {
          p.mode = "ro";
          rerender();
        }}
        >
          Read only
        </button>
      </div>
    </div>

    <p class="drive-note">
      QM may use your Google account to read${p.mode === "rw" ? ", create and edit" : ""} files in
      <strong>${p.folder.name}</strong> on your behalf. Teammates use their own Google accounts, not yours.
    </p>
    ${p.error ? html`<p class="drive-note warning">${p.error}</p>` : ""}

    <footer class="drive-picker-foot">
      <button class="btn" type="button" @click=${() => closeAll(rerender)}>Cancel</button>
      <button class="primary" type="button" ?disabled=${busy} @click=${() => void doAttach(scopeId, rerender)}>
        Attach folder
      </button>
    </footer>
  </section>`;
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
  return html`<section class="kc-confirm drive-picker">
    <header class="drive-picker-head"><h2>Detach “${m.name}”?</h2></header>
    <p class="drive-note">
      The agent stops seeing this folder in every conversation in this scope. Nothing in Drive changes, and nothing is
      deleted.
    </p>
    <footer class="drive-picker-foot">
      <button class="btn" type="button" @click=${() => closeAll(rerender)}>Cancel</button>
      <button
        class="primary"
        type="button"
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
    </footer>
  </section>`;
}
