import { html, nothing, render } from "lit";
import { File, Image, Upload } from "lucide";
import { api, reportSigninRequired, type SigninRequired, withBase } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { browserRenderableImage, fieldSelect, formatBytes, icon, relTime } from "./ui";
import { contextsState, ensureContexts, personalScopeId, scopeChip, scopeFilterControl } from "./contexts";
import { appState } from "./shell";
import { fileListNeedsAllPages } from "./file-list";
import {
  driveBandTpl,
  drivePickerTpl,
  loadDriveMounts,
  openDrivePicker,
  resetDriveFoldersState,
} from "./drive-folders";
import { fileActions } from "./file-actions";
import { resetRowMenus, rowMenuTpl } from "./row-actions";

interface FileItem {
  id: string;
  name: string;
  createdBy?: string;
  mimetype: string;
  sizeBytes: number;
  direction: "in" | "out";
  createdAt: number;
  createdInScope?: string;
  ownerScopeId?: string;
  openable: boolean;
}
interface FileRow extends FileItem {
  kind: "Created" | "Uploaded" | "Shared";
}

const PAGE_SIZE = 60;
let fileRows: FileRow[] = [];
let filesNotice = "";
let filesScope: string | null = null;
let filesQuery = "";
let filesType: "all" | "image" | "document" | "other" = "all";
let filesOwnership: "all" | "owned" | "shared" = "all";
let filesSort: "newest" | "oldest" | "name" = "newest";
let filesDragActive = false;
let filesUploading = false;
let filesLoadingMore = false;
let filesNextCursor: string | null = null;
let filesHost: HTMLElement | null = null;
let deletingFile: FileRow | null = null;
let deleteBusy = false;
let deleteError = "";
let filesRequestSeq = 0;
let filesLoadAllQueued = false;

function fileScope(f: FileItem): string | null {
  return f.createdInScope ?? (f.ownerScopeId?.startsWith("personal:") ? f.ownerScopeId : null) ?? personalScopeId();
}

function typeOf(f: FileItem): "image" | "document" | "other" {
  if (browserRenderableImage(f.mimetype)) return "image";
  if (f.mimetype.startsWith("text/") || /(?:pdf|document|sheet|presentation|json|xml|csv)/i.test(f.mimetype))
    return "document";
  return "other";
}

function selectControl(
  label: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void,
) {
  return html`<label class="list-select"
    ><span>${label}</span>${fieldSelect({
      compact: true,
      value,
      onChange,
      options: options.map(([v, text]) => html`<option value=${v}>${text}</option>`),
    })}</label
  >`;
}

function visibleFiles(): FileRow[] {
  const q = filesQuery.trim().toLowerCase();
  return fileRows
    .filter((f) => !filesScope || fileScope(f) === filesScope)
    .filter((f) => filesOwnership === "all" || (filesOwnership === "shared") === (f.kind === "Shared"))
    .filter((f) => filesType === "all" || typeOf(f) === filesType)
    .filter((f) => !q || `${f.name} ${f.mimetype}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (filesSort === "name") return a.name.localeCompare(b.name);
      if (filesSort === "oldest") return a.createdAt - b.createdAt;
      return b.createdAt - a.createdAt;
    });
}

/**
 * Redraw the Files page from outside it — the document-level menu dismissal in
 * main.ts needs a way to reflect a closed row menu. A no-op when the page is
 * not mounted, so the global handler never has to know which view is showing.
 */
export function redrawFilesPage(): void {
  if (appState.currentView !== "files" || !filesHost) return;
  drawFiles();
}

function drawFiles(loading = false): void {
  if (appState.currentView !== "files" || !appState.mainEl) return;
  if (!filesHost || filesHost.parentElement !== appState.mainEl) {
    filesHost = document.createElement("div");
    filesHost.className = "pane files-page";
    appState.mainEl.replaceChildren(filesHost);
  }
  const visible = visibleFiles();
  const filtered = Boolean(filesScope || filesQuery.trim() || filesType !== "all" || filesOwnership !== "all");
  let dropLabel = "Drop files here or choose files";
  if (filesDragActive) dropLabel = "Drop files";
  else if (filesUploading) dropLabel = "Uploading…";
  const status = filesNotice || (loading && !fileRows.length ? "Loading files…" : "");
  const uploadTarget = filesScope ?? personalScopeId();
  render(
    html`
      <div class="list-page-head">
        <div>
          <h1 class="pane-title">Files</h1>
          <div class="pane-subtitle">Files created, uploaded, or shared with you</div>
        </div>
        <div class="list-page-actions">
          ${scopeFilterControl(filesScope, (s) => {
            filesScope = s;
            fileRows = [];
            filesNextCursor = null;
            void loadFiles(appState.viewRenderSeq);
          })}<button class="btn primary" type="button" ?disabled=${filesUploading} @click=${pickFiles}>
            ${icon(Upload, 15)}<span>Upload</span>
          </button>
        </div>
      </div>
      ${status ? html`<div class="status" aria-live="polite">${status}</div>` : nothing}
      <button
        class="file-drop ${filesDragActive ? "dragging" : ""}"
        type="button"
        ?disabled=${filesUploading}
        @click=${pickFiles}
        @dragenter=${onFileDrag}
        @dragover=${onFileDrag}
        @dragleave=${onFileDragLeave}
        @drop=${onFileDrop}
      >
        ${icon(Upload, 18)}<span>${dropLabel}</span>${uploadTarget ? scopeChip(uploadTarget) : nothing}
      </button>
      ${
        uploadTarget
          ? driveBandTpl(
              Date.now(),
              () => drawFiles(),
              () => openDrivePicker(() => drawFiles()),
            )
          : nothing
      }
      <div class="list-toolbar">
        <label class="list-search"
          ><span class="sr-only">Search files</span
          ><input
            type="search"
            aria-label="Search files"
            placeholder="Search file names and types…"
            .value=${filesQuery}
            @input=${(e: Event) => {
              filesQuery = (e.currentTarget as HTMLInputElement).value;
              drawFiles();
              void loadAllFiles();
            }}
        /></label>
        ${selectControl(
          "Ownership",
          filesOwnership,
          [
            ["all", "All files"],
            ["owned", "Yours"],
            ["shared", "Shared"],
          ],
          (v) => {
            filesOwnership = v as typeof filesOwnership;
            drawFiles();
            void loadAllFiles();
          },
        )}
        ${selectControl(
          "Type",
          filesType,
          [
            ["all", "All types"],
            ["image", "Images"],
            ["document", "Documents"],
            ["other", "Other"],
          ],
          (v) => {
            filesType = v as typeof filesType;
            drawFiles();
            void loadAllFiles();
          },
        )}
        ${selectControl(
          "Sort",
          filesSort,
          [
            ["newest", "Newest"],
            ["oldest", "Oldest"],
            ["name", "Name"],
          ],
          (v) => {
            filesSort = v as typeof filesSort;
            drawFiles();
            void loadAllFiles();
          },
        )}
      </div>
      ${visible.length ? html`<div class="list-rows file-list">${visible.map(fileRow)}</div>` : html`<div class="empty compact">${filtered ? "No files match these filters." : "No files yet. Upload one here or ask the agent to create one."}</div>`}
      ${filesNextCursor ? html`<div class="list-footer"><button class="btn" type="button" ?disabled=${filesLoadingMore} @click=${() => void loadMoreFiles()}>${filesLoadingMore ? "Loading…" : "Load more"}</button></div>` : nothing}
      ${drivePickerTpl(uploadTarget ?? "", () => drawFiles())} ${deleteFileConfirmTpl()}
    `,
    filesHost,
  );
}

function onFileAction(id: string, f: FileRow): void {
  switch (id) {
    case "download": {
      const a = document.createElement("a");
      a.href = withBase(`/api/files/${encodeURIComponent(f.id)}/content`);
      a.download = f.name;
      a.click();
      return;
    }
    case "delete":
      deletingFile = f;
      drawFiles();
      return;
  }
}

function fileRow(f: FileRow) {
  const contentUrl = withBase(`/api/files/${encodeURIComponent(f.id)}/content`);
  const isImage = f.openable && browserRenderableImage(f.mimetype);
  const me = appState.me?.user ?? "";
  return html`<article class="list-row file-row">
    <span class="file-row-icon">${icon(isImage ? Image : File, 17)}</span>
    <span class="list-row-title"><span>${f.name}</span><span class="file-row-type">${f.mimetype}</span></span>
    <span class="list-row-meta"
      >${scopeChip(fileScope(f))}<span class="badge">${f.kind}</span><span>${formatBytes(f.sizeBytes)}</span
      ><span>${relTime(f.createdAt)}</span
      >${f.openable ? html`<a class="btn compact" href=${contentUrl} target="_blank" rel="noreferrer">Open</a>` : html`<span>Unavailable</span>`}${rowMenuTpl(
        `file:${f.id}`,
        f.name,
        fileActions(f, me),
        (id) => onFileAction(id, f),
        () => drawFiles(),
      )}</span
    >
  </article>`;
}

function deleteFileConfirmTpl(): typeof nothing | ReturnType<typeof html> {
  const f = deletingFile;
  if (!f) return nothing;
  const close = () => {
    deletingFile = null;
    drawFiles();
  };
  return html`<div
    class="kc-dialog-scrim"
    @click=${(e: Event) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <section class="kc-confirm drive-picker">
      <header class="drive-picker-head"><h2>Delete “${f.name}”?</h2></header>
      <p class="drive-note">
        The file and its contents are removed for everyone it was shared with, and the agent can no longer read it. This
        cannot be undone.
      </p>
      ${deleteError ? html`<p class="drive-note warning">${deleteError}</p>` : ""}
      <footer class="drive-picker-foot">
        <button class="btn" type="button" @click=${close}>Cancel</button>
        <button class="primary" type="button" ?disabled=${deleteBusy} @click=${() => void doDeleteFile(f)}>
          ${deleteBusy ? "Deleting…" : "Delete file"}
        </button>
      </footer>
    </section>
  </div>`;
}

async function doDeleteFile(f: FileRow): Promise<void> {
  deleteBusy = true;
  deleteError = "";
  drawFiles();
  try {
    await api(`/api/files/${encodeURIComponent(f.id)}`, { method: "DELETE" });
    fileRows = fileRows.filter((r) => r.id !== f.id);
    deletingFile = null;
  } catch (e) {
    deleteError = errMessage(e);
  } finally {
    deleteBusy = false;
    drawFiles();
  }
}

async function fileSha256(file: globalThis.File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadOne(file: globalThis.File): Promise<void> {
  const scope = filesScope ?? personalScopeId();
  const q = new URLSearchParams();
  if (scope) q.set("scope", scope);
  q.set("sha", await fileSha256(file));
  q.set("name", file.name || "file");
  const r = await fetch(withBase(`/api/files/upload?${q.toString()}`), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!r.ok) {
    const text = await r.text();
    let message = `Upload failed (${r.status})`;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string } & SigninRequired;
      if (r.status === 401) reportSigninRequired(parsed);
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text.trim()) message = text.trim();
    }
    throw new Error(message);
  }
}

async function uploadFiles(files: globalThis.File[]): Promise<void> {
  const picked = files.filter((f) => f.size >= 0);
  if (!picked.length || filesUploading) return;
  filesUploading = true;
  filesNotice = `Uploading ${picked.length} ${picked.length === 1 ? "file" : "files"}…`;
  drawFiles();
  let uploaded = 0;
  try {
    for (const file of picked) {
      await uploadOne(file);
      uploaded++;
    }
    filesNotice = `Uploaded ${picked.length} ${picked.length === 1 ? "file" : "files"}.`;
    await loadFiles(appState.viewRenderSeq);
  } catch (e) {
    filesNotice = `${uploaded ? `Uploaded ${uploaded} of ${picked.length}. ` : ""}${errMessage(e, "Upload failed.")}`;
    if (uploaded) await loadFiles(appState.viewRenderSeq);
    else drawFiles();
  } finally {
    filesUploading = false;
    filesDragActive = false;
    drawFiles();
  }
}

function pickFiles(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => void uploadFiles(Array.from(input.files ?? []));
  input.click();
}
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
function onFileDrag(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (!filesDragActive) {
    filesDragActive = true;
    drawFiles();
  }
}
function onFileDragLeave(e: DragEvent): void {
  if (!hasFiles(e)) return;
  const current = e.currentTarget as HTMLElement;
  if (e.relatedTarget instanceof Node && current.contains(e.relatedTarget)) return;
  filesDragActive = false;
  drawFiles();
}
function onFileDrop(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  filesDragActive = false;
  void uploadFiles(Array.from(e.dataTransfer?.files ?? []));
}

function rowsFromPage(r: { owned?: FileItem[]; shared?: FileItem[] }): FileRow[] {
  return [
    ...(r.owned ?? []).map((f): FileRow => ({ ...f, kind: f.direction === "out" ? "Created" : "Uploaded" })),
    ...(r.shared ?? []).map((f): FileRow => ({ ...f, kind: "Shared" })),
  ];
}

async function fetchFilePage(
  cursor?: string,
  scope = filesScope,
): Promise<{ rows: FileRow[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) q.set("cursor", cursor);
  if (scope) q.set("scope", scope);
  const r = await api<{ owned?: FileItem[]; shared?: FileItem[]; nextCursor?: string }>(`/api/files?${q.toString()}`);
  return { rows: rowsFromPage(r), nextCursor: r.nextCursor ?? null };
}

async function loadMoreFiles(): Promise<void> {
  if (!filesNextCursor || filesLoadingMore) return;
  const requestSeq = filesRequestSeq;
  const scope = filesScope;
  filesLoadingMore = true;
  drawFiles();
  try {
    const page = await fetchFilePage(filesNextCursor, scope);
    if (requestSeq !== filesRequestSeq) return;
    const byId = new Map(fileRows.map((f) => [f.id, f]));
    for (const row of page.rows) byId.set(row.id, row);
    fileRows = [...byId.values()];
    filesNextCursor = page.nextCursor;
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, "Failed to load more files.");
  }
  if (requestSeq !== filesRequestSeq) return;
  filesLoadingMore = false;
  drawFiles();
  if (filesLoadAllQueued) {
    filesLoadAllQueued = false;
    void loadAllFiles();
  }
}

async function loadAllFiles(): Promise<void> {
  if (!fileListNeedsAllPages({ query: filesQuery, type: filesType, ownership: filesOwnership, sort: filesSort }))
    return;
  if (filesLoadingMore) {
    filesLoadAllQueued = true;
    return;
  }
  const requestSeq = filesRequestSeq;
  const scope = filesScope;
  filesLoadingMore = true;
  drawFiles();
  try {
    while (filesNextCursor && requestSeq === filesRequestSeq) {
      const page = await fetchFilePage(filesNextCursor, scope);
      if (requestSeq !== filesRequestSeq) return;
      const byId = new Map(fileRows.map((file) => [file.id, file]));
      for (const row of page.rows) byId.set(row.id, row);
      fileRows = [...byId.values()];
      filesNextCursor = page.nextCursor;
    }
  } catch (e) {
    if (requestSeq !== filesRequestSeq) return;
    filesNotice = errMessage(e, "Failed to load all matching files.");
  }
  if (requestSeq !== filesRequestSeq) return;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  drawFiles();
}

async function loadFiles(seq: number): Promise<void> {
  const requestSeq = ++filesRequestSeq;
  filesLoadAllQueued = false;
  filesLoadingMore = false;
  await ensureContexts();
  drawFiles(true);
  // Fire and forget: the band renders its own loading/empty states, and a
  // slow Drive listing must not hold up the file list.
  void loadDriveMounts(filesScope ?? personalScopeId(), () => drawFiles());
  try {
    const page = await fetchFilePage();
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    fileRows = page.rows;
    filesNextCursor = page.nextCursor;
    void loadAllFiles();
  } catch (e) {
    if (requestSeq !== filesRequestSeq || seq !== appState.viewRenderSeq || appState.currentView !== "files") return;
    filesNotice = errMessage(e, "Failed to load files.");
  }
  drawFiles();
}

export async function renderFiles(): Promise<void> {
  if (appState.currentView !== "files") return;
  // Transient per-visit state: a half-open menu or a delete confirm left over
  // from last time would reappear over a different list.
  resetRowMenus();
  resetDriveFoldersState();
  deletingFile = null;
  deleteBusy = false;
  deleteError = "";
  if (contextsState.selected) {
    filesScope = contextsState.selected;
    fileRows = [];
    filesNextCursor = null;
    contextsState.selected = null;
  }
  const seq = appState.viewRenderSeq;
  filesNotice = "";
  filesNextCursor = null;
  await loadFiles(seq);
}
