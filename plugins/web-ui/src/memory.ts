import { html, nothing, render } from "lit";
import { Clock3, RefreshCw, Search, Sparkles, Trash2 } from "lucide";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { appState, replacePanePreservingFocus } from "./shell";
import { contextsState, ensureContexts, scopeTitle } from "./contexts";
import { mainConversation } from "./conversations";
import { addPendingSession } from "./sessions";

interface RevisionRow {
  revision: string;
  content: string;
  operation: string;
  author?: string;
  at: number;
}

let memoryDraft = "";
let memorySaved = "";
let memoryRevision = "";
let memoryNotice = "";
let memorySaving = false;
let memoryLoaded = false;
let memoryScopeId: string | null = null;
let memoryLoadSeq = 0;
let notebookEditing = false;
let search = "";
let historyOpen = false;
let history: RevisionRow[] = [];
let memoryConfirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;

export function resetMemoryState(): void {
  memoryDraft = "";
  memorySaved = "";
  memoryRevision = "";
  memoryNotice = "";
  memorySaving = false;
  memoryLoaded = false;
  memoryScopeId = null;
  memoryLoadSeq++;
  notebookEditing = false;
  search = "";
  historyOpen = false;
  history = [];
  memoryConfirmation = null;
}

function memoryPath(base: string): string {
  return memoryScopeId ? `${base}?scopeId=${encodeURIComponent(memoryScopeId)}` : base;
}

function memoryPayload(fields: Record<string, unknown>): string {
  return JSON.stringify(memoryScopeId ? { ...fields, scopeId: memoryScopeId } : fields);
}

function memoryScopeOptions(): Array<{ value: string; title: string }> {
  const shared = contextsState.list
    .filter((c) => c.kind === "channel" || c.kind === "group")
    .map((c) => ({ value: c.scopeId, title: scopeTitle(c.scopeId, c.name) }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return [{ value: "", title: "Personal" }, ...shared];
}

function switchMemoryScope(scopeId: string | null): void {
  if (scopeId === memoryScopeId) return;
  const apply = async (): Promise<void> => {
    memoryConfirmation = null;
    memoryScopeId = scopeId;
    memoryDraft = "";
    memorySaved = "";
    memoryRevision = "";
    memoryNotice = "";
    memoryLoaded = false;
    search = "";
    historyOpen = false;
    history = [];
    await renderMemory();
  };
  if (memoryLoaded && memoryDraft !== memorySaved) {
    memoryConfirmation = {
      title: "Discard unsaved memory changes?",
      body: "Switching notebooks will drop this draft. Copy anything you want to keep before continuing.",
      action: "Discard and switch",
      run: apply,
    };
    return void drawMemory();
  }
  void apply();
}

const COMPACT_PROMPT =
  "Your memory notebook has grown long. Please compact it: merge duplicate and overlapping facts, drop anything stale or superseded, and keep each remaining fact short, on its own line. Do not invent facts and keep everything that still matters. Save the compacted notebook to memory when you are done.";

function openCompactChat(): void {
  const scope = memoryScopeId;
  const name = scope ? (contextsState.list.find((c) => c.scopeId === scope)?.name ?? null) : null;
  const conv = mainConversation();
  const threadRef = conv.newChat(scope ? { scopeId: scope, name } : undefined);
  if (scope) addPendingSession(threadRef, scope, name);
  conv.composer.state.draft = COMPACT_PROMPT;
  conv.drawActiveChat(conv.state.agent);
  conv.composer.focusComposerEnd();
}

function facts(content: string): Array<{ line: number; text: string; date?: string }> {
  return content.split("\n").flatMap((row, line) => {
    const match = row.match(/^\s*[-*]\s+(?:\((\d{4}-\d{2}-\d{2})\)\s*)?(.*\S)\s*$/);
    return match ? [{ line, ...(match[1] ? { date: match[1] } : {}), text: match[2]! }] : [];
  });
}

function removeFact(line: number): void {
  const lines = memoryDraft.split("\n");
  lines.splice(line, 1);
  memoryDraft = lines.join("\n");
  drawMemory();
}

function emptyFactsMessage(): string {
  if (search) return "No remembered facts match this search.";
  if (memoryDraft.trim()) return "Nothing here is written as facts — the Notebook tab shows the full text.";
  return "The agent hasn’t noted any facts yet.";
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function drawMemory(loading = false): void {
  if (appState.currentView !== "memory" || !appState.mainEl) return;
  const dirty = memoryDraft !== memorySaved;
  const scopeOptions = memoryScopeOptions();
  const visible = facts(memoryDraft).filter(
    (fact) => !search || fact.text.toLowerCase().includes(search.toLowerCase()),
  );
  const host = document.createElement("div");
  host.className = "pane";
  render(
    html`
      <div class="pane-head">
        <div>
          <h1 class="pane-title">Memory</h1>
          <div class="pane-subtitle">
            ${
              memoryScopeId
                ? `Facts the agent carries into ${scopeTitle(memoryScopeId)} conversations.`
                : "Facts the agent carries into your conversations."
            }
          </div>
        </div>
        <div class="pane-head-actions">
          <button class="btn" type="button" @click=${() => void toggleHistory()}>${icon(Clock3, 15)} History</button>
          <button
            class="pane-refresh"
            type="button"
            aria-label="Refresh memory"
            title="Refresh memory"
            @click=${() => void renderMemory(true)}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${memoryNotice || loading ? html`<div class="status">${memoryNotice || "Loading…"}</div>` : nothing}
      <div class="memory-editor">
        <div class="memory-toolbar">
          <div class="resource-tabs" role="tablist" aria-label="Memory view">
            <button
              role="tab"
              type="button"
              aria-selected=${!notebookEditing}
              class=${!notebookEditing ? "active" : ""}
              @click=${() => {
                notebookEditing = false;
                drawMemory();
              }}
            >
              Facts${memoryLoaded ? html`<span>${facts(memoryDraft).length}</span>` : nothing}
            </button>
            <button
              role="tab"
              type="button"
              aria-selected=${notebookEditing}
              class=${notebookEditing ? "active" : ""}
              @click=${() => {
                notebookEditing = true;
                drawMemory();
              }}
            >
              Notebook
            </button>
          </div>
          ${
            scopeOptions.length > 1
              ? html`<label class="list-select memory-scope">
                  <span>Context</span>${fieldSelect({
                    compact: true,
                    ariaLabel: "Notebook context",
                    focusKey: "memory-scope",
                    value: memoryScopeId ?? "",
                    disabled: memorySaving,
                    onChange: (value) => switchMemoryScope(value || null),
                    options: scopeOptions.map(
                      (o) =>
                        html`<option value=${o.value} ?selected=${(memoryScopeId ?? "") === o.value}>
                          ${o.title}
                        </option>`,
                    ),
                  })}
                </label>`
              : nothing
          }
        </div>
        ${
          notebookEditing
            ? html`<p class="memory-help">
                  Edit the notebook directly — one fact per line. Saves are protected if the agent remembers something
                  new while this page is open.
                </p>
                <textarea
                  class="memory-text"
                  data-focus-key="memory-raw"
                  spellcheck="false"
                  ?disabled=${loading || memorySaving}
                  @input=${(e: Event) => {
                    memoryDraft = (e.target as HTMLTextAreaElement).value;
                    drawMemory();
                  }}
                  .value=${memoryDraft}
                ></textarea>`
            : html` <label class="memory-search"
                  >${icon(Search, 16)}<input
                    data-focus-key="memory-search"
                    aria-label="Search memory"
                    type="search"
                    placeholder="Search remembered facts"
                    .value=${search}
                    @input=${(e: Event) => {
                      search = (e.target as HTMLInputElement).value;
                      drawMemory();
                    }}
                /></label>
                <div class="memory-facts">
                  ${
                    visible.length
                      ? visible.map(
                          (fact) =>
                            html`<div class="memory-fact">
                              <div>
                                <div>${fact.text}</div>
                                ${fact.date ? html`<div class="card-meta">Captured ${fact.date}</div>` : nothing}
                              </div>
                              <button
                                class="icon-btn"
                                type="button"
                                aria-label="Forget this fact"
                                title="Forget this fact"
                                @click=${() => removeFact(fact.line)}
                              >
                                ${icon(Trash2, 15)}
                              </button>
                            </div>`,
                        )
                      : html`<div class="empty-state">${emptyFactsMessage()}</div>`
                  }
                </div>`
        }
        <div class="memory-actions">
          <button
            class="btn primary memory-save"
            type="button"
            ?disabled=${loading || memorySaving || !dirty}
            @click=${() => void saveMemory()}
          >
            ${memorySaving ? "Saving…" : "Save changes"}
          </button>
          <span class="memory-hint">${dirty && !memorySaving ? "Unsaved changes" : ""}</span>
          <button
            class="btn memory-compact"
            type="button"
            title=${
              dirty
                ? "Save your changes first, so the agent compacts what you see"
                : "Open a conversation here with a compaction request ready to send"
            }
            ?disabled=${loading || memorySaving || dirty || !memorySaved.trim()}
            @click=${openCompactChat}
          >
            ${icon(Sparkles, 15)} Compact with the agent
          </button>
        </div>
        ${
          historyOpen
            ? html` <section class="memory-history">
                <h2>Revision history</h2>
                ${
                  history.length
                    ? history.map(
                        (row, i) =>
                          html` <div class="memory-revision">
                            <div>
                              <strong>${i === 0 ? "Current" : `Revision ${row.revision}`}</strong>
                              <div class="card-meta">
                                ${fmtDate(row.at)} · ${row.author || "automatic capture"} · ${row.operation}
                              </div>
                            </div>
                            ${i ? html`<button class="btn" type="button" @click=${() => requestRestoreRevision(row)}>Restore</button>` : nothing}
                          </div>`,
                      )
                    : html`<div class="empty-state">Revision history is unavailable for this memory store.</div>`
                }
              </section>`
            : nothing
        }
        ${
          memoryConfirmation
            ? html` <section class="card memory-confirm" role="alertdialog" aria-labelledby="memory-confirm-title">
                <div class="card-head">
                  <h2 class="card-title" id="memory-confirm-title">${memoryConfirmation.title}</h2>
                  <span class="badge warn">Check impact</span>
                </div>
                <p class="memory-help">${memoryConfirmation.body}</p>
                <div class="actions">
                  <button class="btn danger" type="button" @click=${() => void memoryConfirmation?.run()}>
                    ${memoryConfirmation.action}</button
                  ><button
                    class="btn"
                    type="button"
                    @click=${() => {
                      memoryConfirmation = null;
                      drawMemory();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </section>`
            : nothing
        }
      </div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export async function renderMemory(force = false): Promise<void> {
  if (appState.currentView !== "memory") return;
  const dirty = memoryLoaded && memoryDraft !== memorySaved;
  if (dirty && !force) return void drawMemory();
  if (dirty && force) {
    memoryConfirmation = {
      title: "Discard unsaved memory changes?",
      body: "Refreshing will replace this draft with the latest memory. Copy anything you want to keep before continuing.",
      action: "Discard and refresh",
      run: async () => {
        memoryConfirmation = null;
        memoryDraft = memorySaved;
        await renderMemory(true);
      },
    };
    return void drawMemory();
  }
  const seq = ++memoryLoadSeq;
  const stale = (): boolean => seq !== memoryLoadSeq || appState.currentView !== "memory";
  memoryNotice = "";
  drawMemory(true);
  await ensureContexts();
  if (stale()) return;
  try {
    const r = await api<{ content?: string; revision?: string }>(memoryPath("/api/memory"));
    if (stale()) return;
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? "";
    memoryLoaded = true;
  } catch (e) {
    if (stale()) return;
    memoryNotice = errMessage(e, "Failed to load memory.");
  }
  drawMemory();
}

async function saveMemory(): Promise<void> {
  if (memorySaving) return;
  const seq = memoryLoadSeq;
  memorySaving = true;
  memoryNotice = "";
  drawMemory();
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory", {
      method: "PUT",
      body: memoryPayload({ content: memoryDraft, revision: memoryRevision }),
    });
    if (seq !== memoryLoadSeq) return;
    memorySaved = r.content ?? memoryDraft;
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "Saved ✓";
    if (historyOpen) {
      try {
        await loadHistory();
      } catch {
        memoryNotice = "Saved ✓ History could not refresh.";
      }
    }
  } catch (e) {
    if (seq !== memoryLoadSeq) return;
    memoryNotice =
      e instanceof ApiError && e.status === 409
        ? "Memory changed in another conversation. Your draft is still here; copy it if needed, then refresh to merge with the latest version."
        : errMessage(e, "Failed to save memory.");
  } finally {
    memorySaving = false;
    drawMemory();
  }
}

async function loadHistory(): Promise<void> {
  const seq = memoryLoadSeq;
  const r = await api<{ revisions?: RevisionRow[] }>(memoryPath("/api/memory/history"));
  if (seq !== memoryLoadSeq) return;
  history = r.revisions ?? [];
}

async function toggleHistory(): Promise<void> {
  historyOpen = !historyOpen;
  if (historyOpen) {
    try {
      await loadHistory();
    } catch (e) {
      memoryNotice = errMessage(e, "Failed to load memory history.");
    }
  }
  drawMemory();
}

function requestRestoreRevision(row: RevisionRow): void {
  memoryConfirmation = {
    title: `Restore memory from ${fmtDate(row.at)}?`,
    body: "The selected notebook will become current. The version you have now remains available in history.",
    action: "Restore revision",
    run: async () => {
      memoryConfirmation = null;
      await restoreRevision(row);
    },
  };
  drawMemory();
}

async function restoreRevision(row: RevisionRow): Promise<void> {
  const seq = memoryLoadSeq;
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory/restore", {
      method: "POST",
      body: memoryPayload({ revision: row.revision, expectedRevision: memoryRevision }),
    });
    if (seq !== memoryLoadSeq) return;
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "Revision restored ✓";
    try {
      await loadHistory();
    } catch {
      memoryNotice = "Revision restored ✓ History could not refresh.";
    }
  } catch (e) {
    if (seq !== memoryLoadSeq) return;
    memoryNotice = errMessage(e, "Could not restore that revision.");
  }
  drawMemory();
}
