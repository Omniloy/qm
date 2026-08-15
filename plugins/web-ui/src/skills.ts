import { html, nothing, render, type TemplateResult } from "lit";
import { Box } from "lucide";
import { api, type CoreContext } from "./core-bridge";
import type { SkillItem } from "./composer";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { appState, can } from "./shell";
import { skillActions } from "./skill-actions";
import {
  shareConfirmLabel,
  shareImpact,
  shareRequest,
  shareSuccessNotice,
  shareTargets,
  shareTitle,
  skillShareActions,
  type ShareScopeOption,
  type SkillShareMode,
} from "./skill-share";
import { resetRowMenus, rowMenuTpl } from "./row-actions";
import {
  createReviewMatches,
  isSharedSkillScope,
  reviewMatches,
  shouldBlockRepeatedPublishClick,
  type SkillCreateReview,
  type SkillEditReview,
} from "./skill-edit-review";
import {
  filterSkillGroups,
  groupSkills,
  isArchivedSkill,
  skillEmptyState,
  statusCounts,
  type SkillStatusFilter,
} from "./skill-registry";
import { listBackLink, listPageTpl } from "./list-page";
import { scopeTitle } from "./contexts";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { SkillsRefreshSequence } from "./skills-refresh";
import { SkillsMutationSequence } from "./skills-mutation";

let skillRows: SkillItem[] = [];
let skillsNotice = "";
let skillSearch = "";
let scopeFilter = "all";
let sourceFilter = "all";
let statusFilter: SkillStatusFilter = "active";
let createScopes: Array<{ scopeId: string; name: string }> = [];
let skillsPageHost: HTMLElement | null = null;

let editing: {
  id: string;
  description: string;
  body: string;
  originalDescription: string;
  originalBody: string;
  scopeId?: string;
  name: string;
  review: SkillEditReview | null;
} | null = null;
let editingTarget: SkillItem | null = null;
let saving = false;
let editError = "";

let creating: {
  name: string;
  description: string;
  body: string;
  scopeId: string;
  review: SkillCreateReview | null;
} | null = null;
let creatingSaving = false;
let createError = "";

let deleting: string | null = null;
let archiveConfirmation: SkillItem | null = null;
let shareScopes: ShareScopeOption[] = [];
let sharing: { skill: SkillItem; mode: SkillShareMode; toScope: string; permission: "read" | "write" } | null = null;
let shareBusy = false;
let shareError = "";
let shareFocusTarget: HTMLElement | null = null;
let editRequestSeq = 0;
const skillsRefreshes = new SkillsRefreshSequence();
const skillMutations = new SkillsMutationSequence();
let flowFocusTarget: HTMLElement | null = null;
let archiveFocusTarget: HTMLElement | null = null;

function scopeLabel(scope: string): string {
  return scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : "";
}

function editAudience(scopeId: string | undefined): string {
  if (scopeId?.startsWith("personal:")) return "only you";
  return scopeId ? scopeTitle(scopeId) : "this context";
}

async function startEdit(s: SkillItem): Promise<void> {
  if (!s.id) return;
  const request = ++editRequestSeq;
  skillMutations.invalidate();
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  creating = null;
  editing = null;
  editingTarget = s;
  editError = "";
  skillsNotice = "Loading skill instructions…";
  drawSkills();
  queueMicrotask(() => skillsPageHost?.querySelector<HTMLElement>(".context-back")?.focus());
  try {
    const r = await api<{ skill: SkillItem }>(`/api/skills/${encodeURIComponent(s.id)}`);
    if (request !== editRequestSeq) return;
    editing = {
      id: s.id,
      description: r.skill.description,
      body: r.skill.body ?? "",
      originalDescription: r.skill.description,
      originalBody: r.skill.body ?? "",
      scopeId: r.skill.scopeId,
      name: r.skill.name,
      review: null,
    };
    editingTarget = r.skill;
    skillsNotice = "";
  } catch (e) {
    if (request !== editRequestSeq) return;
    editError = errMessage(e, "Failed to load skill details.");
    skillsNotice = "";
  }
  drawSkills();
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>("#skill-edit-description") ??
      skillsPageHost?.querySelector<HTMLElement>(".context-back");
    target?.focus();
  });
}

function restoreFocusedFlow(target: HTMLElement | null): void {
  queueMicrotask(() => {
    if (creating || editingTarget || archiveConfirmation || appState.currentView !== "skills") return;
    const skillId = target?.dataset.skillId;
    const matchingEdit = skillId
      ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-edit-trigger") ?? [])].find(
          (element) => element.dataset.skillId === skillId,
        )
      : null;
    const search = skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null;
    const create = skillsPageHost?.querySelector<HTMLElement>(".list-page-action") ?? null;
    const fallback = skillId ? (matchingEdit ?? search ?? create) : (create ?? search);
    restoreDialogFocus(target, () => fallback ?? null);
  });
}

function closeFocusedFlow(): void {
  editRequestSeq += 1;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  creating = null;
  editError = "";
  createError = "";
  skillsNotice = "";
  saving = false;
  creatingSaving = false;
  const target = flowFocusTarget;
  flowFocusTarget = null;
  drawSkills();
  restoreFocusedFlow(target);
}

function startCreate(): void {
  if (creating) return;
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  editRequestSeq += 1;
  creating = { name: "", description: "", body: "", scopeId: createScopes[0]?.scopeId ?? "", review: null };
  createError = "";
  creatingSaving = false;
  drawSkills();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#skill-create-name")?.focus());
}

function skillMeta(s: SkillItem): string {
  const source = s.source === "pack" ? `Pack ${s.pack?.upstreamName ?? "source"}` : "Created here";
  return `${scopeLabel(s.scope)} · v${s.version ?? 1} · ${source}`;
}

function skillVariant(s: SkillItem, hasScopeVariants: boolean): TemplateResult {
  const actions = skillActions(s);
  const archived = isArchivedSkill(s);
  let state = "Active";
  if (archived) state = "Archived";
  else if (hasScopeVariants) state = "Scope variant";
  const busy = deleting === s.id || (shareBusy && sharing?.skill.id === s.id);
  // Core owns every one of these refusals; the menu only declines to offer what
  // it already knows will be refused.
  const menu = skillShareActions(s, { isAdmin: can("admin"), archived }).map((a) =>
    busy ? { ...a, disabled: true, reason: "Working…" } : a,
  );
  return html`
    <div class="skill-variant ${archived ? "archived" : ""}">
      <span class="skill-variant-icon">${icon(Box, 16)}</span>
      <div class="skill-variant-copy">
        <div class="skill-variant-description" title=${s.description}>${s.description}</div>
        <div class="skill-variant-meta">
          ${skillMeta(s)}${s.assetCount ? ` · ${s.assetCount} asset${s.assetCount === 1 ? "" : "s"}` : ""}
        </div>
        <details class="skill-variant-details">
          <summary>Details</summary>
          <p>${s.description}</p>
          <dl>
            <div>
              <dt>Scope</dt>
              <dd>${s.scopeId ? scopeTitle(s.scopeId) : scopeLabel(s.scope)}</dd>
            </div>
            <div>
              <dt>Capabilities</dt>
              <dd>${s.requiredCapabilities?.length ? s.requiredCapabilities.join(", ") : "None required"}</dd>
            </div>
          </dl>
        </details>
      </div>
      <div class="skill-variant-state">
        <span class="badge ${archived ? "" : "skill-active"}">${state}</span>
        ${actions.edit && !archived ? html`<button class="btn skill-edit-trigger" data-skill-id=${s.id ?? ""} type="button" ?disabled=${busy} @click=${() => void startEdit(s)}>Edit</button>` : nothing}
        ${
          menu.length
            ? html`<span class="skill-row-menu" data-skill-id=${s.id ?? ""}
                >${rowMenuTpl(
                  `skill:${s.id ?? ""}`,
                  `/${s.name}`,
                  menu,
                  (id) => void onSkillMenu(s, id),
                  () => drawSkills(),
                )}</span
              >`
            : nothing
        }
      </div>
    </div>
  `;
}

function skillGroup(name: string, skills: SkillItem[]): TemplateResult {
  const activeVariants = skills.filter((skill) => !isArchivedSkill(skill)).length;
  const hasScopeVariants = activeVariants > 1;
  return html`<section class="skill-group">
    <div class="skill-group-head">
      <h2 class="skill-group-name">
        <code>/${name}</code>${skills.length > 1 ? html`<span>${skills.length} variants</span>` : nothing}
      </h2>
      ${hasScopeVariants ? html`<span class="skill-precedence">Narrower scope takes precedence where both apply</span>` : nothing}
    </div>
    ${skills.map((skill) => skillVariant(skill, hasScopeVariants))}
  </section>`;
}

function editorPane() {
  const e = editing;
  if (!e) {
    return html`<section class="skill-form-page">
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">Edit /${editingTarget?.name ?? "skill"}</h1>
          <p>${editError ? "Instructions unavailable." : "Loading instructions…"}</p>
        </div>
      </div>
      ${editError ? html`<div class="form-error" role="alert">${editError}</div>` : nothing}
    </section>`;
  }
  const reviewed = reviewMatches(e.review, e.description, e.body);
  let saveLabel = "Save";
  if (saving) saveLabel = "Saving…";
  else if (reviewed) saveLabel = "Publish change";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveEdit();
      }}
    >
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">Edit /${e.name}</h1>
          <p>Available to ${editAudience(e.scopeId)}</p>
        </div>
        <span class="badge">Editing</span>
      </div>
      <label class="skill-field">
        <span>Description</span>
        <input
          id="skill-edit-description"
          class="skill-desc-input"
          type="text"
          .value=${e.description}
          data-focus-key="skill-edit-description"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>Instructions</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          data-focus-key="skill-edit-body"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${e.body}
        ></textarea>
      </label>
      ${editError ? html`<div class="card-meta skill-shadowed">${editError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>Publish this change to ${scopeTitle(e.scopeId ?? null)}?</strong>
              <div class="card-meta">
                Everyone in this context can invoke the updated instructions. Description
                ${e.description === e.originalDescription ? "unchanged" : "changed"}; instructions
                ${e.body === e.originalBody ? "unchanged" : "changed"}.
              </div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${saving}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${saveLabel}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${saving}
                @click=${() => {
                  e.review = null;
                  drawSkills();
                }}
              >
                Review again
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${saving} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function creatorPane() {
  const c = creating!;
  const ready = c.name.trim() !== "" && c.description.trim() !== "" && c.body.trim() !== "";
  const reviewed = createReviewMatches(c.review, c.name.trim(), c.description.trim(), c.body.trim(), c.scopeId);
  let createLabel = "Create skill";
  if (creatingSaving) createLabel = "Saving…";
  else if (reviewed) createLabel = "Publish skill";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveCreate();
      }}
    >
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">New skill</h1>
          <p>Create a reusable procedure for yourself or a shared context.</p>
        </div>
        <span class="badge">New</span>
      </div>
      <label class="skill-field">
        <span>Name</span>
        <input
          id="skill-create-name"
          class="skill-desc-input"
          type="text"
          placeholder="watch-pipeline"
          data-focus-key="skill-create-name"
          .value=${c.name}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.name = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>Available to</span>
        ${fieldSelect({
          className: "skill-scope-select",
          value: c.scopeId,
          disabled: creatingSaving,
          onChange: (value) => {
            c.scopeId = value;
            c.review = null;
            drawSkills();
          },
          options: createScopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`),
        })}
        <small class="card-meta">Everyone in a shared context can invoke and edit this skill.</small>
      </label>
      <label class="skill-field">
        <span>Description</span>
        <input
          class="skill-desc-input"
          type="text"
          placeholder="One line: what it does / when to use it"
          data-focus-key="skill-create-description"
          .value=${c.description}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>Instructions</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          placeholder="The SKILL.md contents — the steps to follow when this skill is used."
          data-focus-key="skill-create-body"
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${c.body}
        ></textarea>
      </label>
      ${createError ? html`<div class="card-meta skill-shadowed">${createError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>Publish /${c.name.trim()} to ${scopeTitle(c.scopeId)}?</strong>
              <div class="card-meta">Everyone in this context can invoke and edit these instructions.</div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${creatingSaving || !ready}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${createLabel}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${creatingSaving}
                @click=${() => {
                  c.review = null;
                  drawSkills();
                }}
              >
                Review again
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${creatingSaving} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function drawSkills(loading = false): void {
  if (appState.currentView !== "skills" || !appState.mainEl) return;
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    skillsPageHost = document.createElement("div");
    skillsPageHost.className = "pane skills-page";
    appState.mainEl.replaceChildren(skillsPageHost);
  }
  if (creating || editingTarget) {
    render(creating ? creatorPane() : editorPane(), skillsPageHost);
    return;
  }
  const filters = { query: skillSearch, scope: scopeFilter, source: sourceFilter, status: statusFilter };
  const groups = filterSkillGroups(groupSkills(skillRows), filters);
  const filtered = groups.flatMap((group) => group.skills);
  const counts = statusCounts(skillRows);
  const rows: TemplateResult[] = groups.map((group) => skillGroup(group.name, group.skills));
  const clearFilters = () => {
    skillSearch = "";
    scopeFilter = "all";
    sourceFilter = "all";
    statusFilter = "all";
    drawSkills();
  };
  const emptyState = skillEmptyState(skillRows.length, filtered.length, loading);
  let empty: string | TemplateResult = "No skills available yet.";
  if (emptyState === "filtered") {
    empty = html`<div class="skill-empty">
      <span>No skills match these filters.</span
      ><button class="btn" type="button" @click=${clearFilters}>Clear filters</button>
    </div>`;
  } else if (emptyState === "loading") {
    empty = "Loading skills…";
  }
  render(
    html`${listPageTpl({
      title: "Skills",
      onRefresh: () => void renderSkills(),
      action: { label: "New skill", onClick: startCreate },
      search: {
        value: skillSearch,
        placeholder: "Search skills…",
        onInput: (value) => {
          skillSearch = value;
          drawSkills();
        },
      },
      filters: html`<div class="skill-registry-controls">
          <div class="resource-tabs" role="group" aria-label="Filter by skill status">
            ${(
              [
                ["active", "Active", counts.active],
                ["archived", "Archived", counts.archived],
                ["all", "All", counts.all],
              ] as const
            ).map(
              ([value, label, count]) =>
                html`<button
                  type="button"
                  aria-pressed=${statusFilter === value}
                  class=${statusFilter === value ? "active" : ""}
                  @click=${() => {
                    statusFilter = value;
                    drawSkills();
                  }}
                >
                  ${label}<span>${count}</span>
                </button>`,
            )}
          </div>
          <div class="skill-filter-fields">
            <label class="list-select"
              ><span>Scope</span>${fieldSelect({
                compact: true,
                ariaLabel: "Filter skills by scope",
                value: scopeFilter,
                onChange: (value) => {
                  scopeFilter = value;
                  drawSkills();
                },
                options: [
                  html`<option value="all">All scopes</option>`,
                  html`<option value="personal">Personal</option>`,
                  html`<option value="channel">Channel</option>`,
                  html`<option value="group">Project / group</option>`,
                  html`<option value="team">Team</option>`,
                  html`<option value="org">Organization</option>`,
                ],
              })}</label
            >
            <label class="list-select"
              ><span>Source</span>${fieldSelect({
                compact: true,
                ariaLabel: "Filter skills by source",
                value: sourceFilter,
                onChange: (value) => {
                  sourceFilter = value;
                  drawSkills();
                },
                options: [
                  html`<option value="all">All sources</option>`,
                  html`<option value="native">Created here</option>`,
                  html`<option value="pack">Skill packs</option>`,
                  html`<option value="overrides">Overrides</option>`,
                ],
              })}</label
            >
          </div>
        </div>
        <div class="skill-result-count" aria-live="polite">
          ${loading ? "Loading…" : `${filtered.length} skill${filtered.length === 1 ? "" : "s"} in ${groups.length} ${groups.length === 1 ? "group" : "groups"}`}
        </div>
        ${skillsNotice ? html`<div class="status">${skillsNotice}</div>` : nothing}`,
      rows,
      empty,
    })}${archiveConfirmation ? archiveDialog(archiveConfirmation) : nothing}${sharing ? shareDialog() : nothing}`,
    skillsPageHost,
  );
}

function setSkillsBackgroundInert(inert: boolean): void {
  skillsPageHost?.querySelectorAll<HTMLElement>(":scope > :not(.project-dialog-backdrop)").forEach((element) => {
    element.inert = inert;
  });
}

function closeArchiveDialog(): void {
  if (deleting) return;
  const target = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    if (archiveConfirmation || appState.currentView !== "skills") return;
    const fallback = target?.dataset.skillId
      ? [...document.querySelectorAll<HTMLElement>(".skill-archive-trigger")].find(
          (element) => element.dataset.skillId === target.dataset.skillId,
        )
      : null;
    restoreDialogFocus(target, () => fallback);
  });
}

function archiveDialog(skill: SkillItem): TemplateResult {
  const audience =
    skill.scope === "personal"
      ? "you"
      : `everyone in ${skill.scopeId ? scopeTitle(skill.scopeId) : `this ${skill.scope}`}`;
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
  >
    <div
      class="project-dialog skill-archive-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-archive-title"
      aria-describedby="skill-archive-impact"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
    >
      <div class="project-dialog-head">
        <div><h2 id="skill-archive-title">Archive /${skill.name}?</h2></div>
      </div>
      <p id="skill-archive-impact">
        This version will stop being available to ${audience}. If it overrides a broader /${skill.name}, that version
        becomes effective. Its history and assets are kept, and you can restore it later.
      </p>
      <div class="project-dialog-actions actions">
        <button
          class="btn"
          type="button"
          data-dialog-cancel
          ?disabled=${deleting === skill.id}
          @click=${closeArchiveDialog}
        >
          Cancel</button
        ><button
          class="btn danger skill-archive-confirm"
          type="button"
          ?disabled=${deleting === skill.id}
          @click=${() => void performArchive(skill)}
        >
          ${deleting === skill.id ? "Archiving…" : "Archive skill"}
        </button>
      </div>
    </div>
  </div>`;
}

async function saveEdit(): Promise<void> {
  if (!editing || saving) return;
  if (isSharedSkillScope(editing.scopeId) && !reviewMatches(editing.review, editing.description, editing.body)) {
    editing.review = { description: editing.description, body: editing.body };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  saving = true;
  editError = "";
  drawSkills();
  try {
    await api(`/api/skills/${encodeURIComponent(editing.id)}`, {
      method: "PUT",
      body: JSON.stringify({ description: editing.description, body: editing.body }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    editing = null;
    editingTarget = null;
    saving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    editError = errMessage(e, "Failed to save skill.");
    saving = false;
    drawSkills();
  }
}

async function saveCreate(): Promise<void> {
  if (!creating || creatingSaving) return;
  const name = creating.name.trim();
  const description = creating.description.trim();
  const body = creating.body.trim();
  if (!name || !description || !body) {
    createError = "Name, description, and instructions are all required.";
    drawSkills();
    return;
  }
  if (
    isSharedSkillScope(creating.scopeId) &&
    !createReviewMatches(creating.review, name, description, body, creating.scopeId)
  ) {
    creating.review = { name, description, body, scopeId: creating.scopeId };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  creatingSaving = true;
  createError = "";
  drawSkills();
  try {
    await api("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, body, scopeId: creating.scopeId }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    creating = null;
    creatingSaving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    createError = errMessage(e, "Failed to create skill.");
    creatingSaving = false;
    drawSkills();
  }
}

/** The row's overflow button, which survives a redraw and so can take focus back. */
function menuButtonFor(id: string | undefined): HTMLElement | null {
  if (!id) return null;
  return (
    [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-row-menu") ?? [])]
      .find((element) => element.dataset.skillId === id)
      ?.querySelector<HTMLElement>(".session-menu-btn") ?? null
  );
}

function onSkillMenu(s: SkillItem, action: string): void {
  if (action === "archive" || action === "restore") {
    void deleteSkill(s, menuButtonFor(s.id) ?? undefined);
    return;
  }
  if (action === "share" || action === "move" || action === "promote") startShare(s, action);
}

function startShare(s: SkillItem, mode: SkillShareMode): void {
  if (!s.id || sharing) return;
  shareFocusTarget = menuButtonFor(s.id);
  const targets = shareTargets(shareScopes, s, mode);
  sharing = { skill: s, mode, toScope: targets[0]?.scopeId ?? "", permission: "read" };
  shareError = "";
  shareBusy = false;
  drawSkills();
  setSkillsBackgroundInert(true);
  queueMicrotask(() => {
    if (!sharing || appState.currentView !== "skills") return;
    if (skillsPageHost) focusDialogCancel(skillsPageHost);
  });
}

function closeShareDialog(): void {
  if (shareBusy) return;
  const target = shareFocusTarget;
  const skillId = sharing?.skill.id;
  sharing = null;
  shareError = "";
  shareFocusTarget = null;
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    if (sharing || appState.currentView !== "skills") return;
    restoreDialogFocus(target, () => menuButtonFor(skillId));
  });
}

function shareDialog(): TemplateResult {
  const sh = sharing!;
  const targets = shareTargets(shareScopes, sh.skill, sh.mode);
  const chosen = targets.find((t) => t.scopeId === sh.toScope);
  const targetLabel = sh.mode === "promote" ? "everyone in the organization" : (chosen?.name ?? "the context you pick");
  // Promotion has a fixed destination, so it is the one mode that can go ahead
  // without a chosen scope.
  const ready = sh.mode === "promote" || Boolean(sh.toScope);
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeShareDialog()}
  >
    <div
      class="project-dialog skill-share-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-share-title"
      aria-describedby="skill-share-impact"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeShareDialog)}
    >
      <div class="project-dialog-head">
        <div><h2 id="skill-share-title">${shareTitle(sh.mode, sh.skill.name)}</h2></div>
      </div>
      ${
        sh.mode === "promote"
          ? nothing
          : html`<label class="skill-field">
              <span>${sh.mode === "move" ? "Move to" : "Share with"}</span>
              ${
                targets.length
                  ? fieldSelect({
                      className: "skill-share-scope",
                      value: sh.toScope,
                      disabled: shareBusy,
                      onChange: (value) => {
                        sh.toScope = value;
                        drawSkills();
                      },
                      options: targets.map((t) => html`<option value=${t.scopeId}>${t.name}</option>`),
                    })
                  : html`<small class="card-meta"
                      >You are not in another context to ${sh.mode === "move" ? "move" : "share"} this to yet.</small
                    >`
              }
            </label>`
      }
      ${
        sh.mode === "share"
          ? html`<fieldset class="skill-share-permission">
              <legend>Access</legend>
              ${(
                [
                  ["read", "Use it", "They can invoke the skill."],
                  ["write", "Use and edit it", "They can also change the instructions."],
                ] as const
              ).map(
                ([value, label, hint]) =>
                  html`<label class="skill-share-choice">
                    <input
                      type="radio"
                      name="skill-share-permission"
                      value=${value}
                      .checked=${sh.permission === value}
                      ?disabled=${shareBusy}
                      @change=${() => {
                      sh.permission = value;
                      drawSkills();
                    }}
                    /><span><strong>${label}</strong><small class="card-meta">${hint}</small></span>
                  </label>`,
              )}
            </fieldset>`
          : nothing
      }
      <p id="skill-share-impact">${shareImpact(sh.mode, sh.skill, targetLabel)}</p>
      ${shareError ? html`<div class="form-error" role="alert">${shareError}</div>` : nothing}
      <div class="project-dialog-actions actions">
        <button class="btn" type="button" data-dialog-cancel ?disabled=${shareBusy} @click=${closeShareDialog}>
          Cancel</button
        ><button
          class="btn ${sh.mode === "share" ? "primary" : "danger"} skill-share-confirm"
          type="button"
          ?disabled=${shareBusy || !ready}
          @click=${() => void performShare()}
        >
          ${shareConfirmLabel(sh.mode, shareBusy)}
        </button>
      </div>
    </div>
  </div>`;
}

async function performShare(): Promise<void> {
  const sh = sharing;
  if (!sh?.skill.id || shareBusy) return;
  const targetLabel =
    sh.mode === "promote"
      ? "everyone in the organization"
      : (shareTargets(shareScopes, sh.skill, sh.mode).find((t) => t.scopeId === sh.toScope)?.name ?? sh.toScope);
  shareBusy = true;
  shareError = "";
  drawSkills();
  try {
    await api(`/api/skills/${encodeURIComponent(sh.skill.id)}/share`, {
      method: "POST",
      body: JSON.stringify(shareRequest(sh.mode, sh.toScope, sh.permission)),
    });
    const opener = shareFocusTarget;
    const skillId = sh.skill.id;
    sharing = null;
    shareBusy = false;
    shareFocusTarget = null;
    setSkillsBackgroundInert(false);
    // renderSkills clears the notice on entry, so the confirmation is set after
    // it settles rather than before.
    await renderSkills();
    skillsNotice = shareSuccessNotice(sh.mode, sh.skill.name, targetLabel);
    drawSkills();
    // A move re-homes the row, so its old menu button is gone — fall back to
    // the page's own controls rather than leaving focus on the body.
    restoreDialogFocus(
      opener,
      () => menuButtonFor(skillId) ?? skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null,
    );
  } catch (e) {
    if (!sharing) return;
    shareError = errMessage(e, "Failed to share skill.");
    shareBusy = false;
    drawSkills();
  }
}

async function deleteSkill(s: SkillItem, trigger?: HTMLElement): Promise<void> {
  if (!s.id || deleting) return;
  if (s.status === "archived") {
    deleting = s.id;
    try {
      await api(`/api/skills/${encodeURIComponent(s.id)}/restore`, { method: "POST", body: "{}" });
      deleting = null;
      return void renderSkills();
    } catch (e) {
      deleting = null;
      skillsNotice = errMessage(e, "Failed to restore skill.");
      return drawSkills();
    }
  }
  archiveFocusTarget = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  archiveConfirmation = s;
  drawSkills();
  setSkillsBackgroundInert(true);
  queueMicrotask(() => {
    if (archiveConfirmation?.id !== s.id || appState.currentView !== "skills") return;
    if (skillsPageHost) focusDialogCancel(skillsPageHost);
  });
}

async function performArchive(s: SkillItem): Promise<void> {
  if (!s.id || deleting) return;
  const focusTarget = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  deleting = s.id;
  skillsNotice = "";
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>(".list-search input") ??
      skillsPageHost?.querySelector<HTMLElement>(".list-page-action");
    target?.focus();
  });
  try {
    await api(`/api/skills/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    deleting = null;
    await renderSkills();
  } catch (e) {
    deleting = null;
    skillsNotice = errMessage(e, "Failed to archive skill.");
    drawSkills();
    requestAnimationFrame(() => {
      const fallback = focusTarget?.dataset.skillId
        ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-archive-trigger") ?? [])].find(
            (element) => element.dataset.skillId === focusTarget.dataset.skillId,
          )
        : null;
      restoreDialogFocus(
        focusTarget,
        () => fallback ?? skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null,
      );
    });
  }
}

export async function renderSkills(): Promise<void> {
  if (appState.currentView !== "skills") return;
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    archiveConfirmation = null;
    archiveFocusTarget = null;
    sharing = null;
    shareBusy = false;
    shareError = "";
    shareFocusTarget = null;
    resetRowMenus();
    setSkillsBackgroundInert(false);
  }
  const seq = appState.viewRenderSeq;
  const request = skillsRefreshes.begin();
  skillsNotice = "";
  drawSkills(true);
  try {
    const [r, contexts] = await Promise.all([
      api<{ skills: SkillItem[] }>("/api/skills?includeShadowed=1"),
      api<{ contexts?: CoreContext[] }>("/api/contexts").catch(() => ({ contexts: [] })),
    ]);
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillRows = (r.skills ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const personal = appState.me ? `personal:${appState.me.user}` : "";
    createScopes = [
      { scopeId: personal, name: "Personal — only you" },
      ...(contexts.contexts ?? [])
        .filter(
          (context) =>
            context.scopeId !== personal &&
            (context.kind === "group" || (context.kind === "channel" && context.isPrivate)),
        )
        .map((context) => ({ scopeId: context.scopeId, name: context.name || context.scopeId })),
    ].filter((scope) => scope.scopeId);
    // Sharing reaches further than creating does: a public channel is a fine
    // place to lend a skill to, even though core refuses to let one be born
    // there. Personal is kept so a skill can be taken back out of a project.
    shareScopes = [
      { scopeId: personal, name: "Personal — only you", kind: "personal" as const },
      ...(contexts.contexts ?? [])
        .filter((context) => context.scopeId !== personal && context.kind !== "personal")
        .map((context) => ({
          scopeId: context.scopeId,
          name: context.name || context.scopeId,
          kind: context.kind as "channel" | "group",
        })),
    ].filter((scope) => scope.scopeId);
  } catch (e) {
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillsNotice = errMessage(e, "Failed to load skills.");
  }
  if (skillsRefreshes.isCurrent(request)) drawSkills(false);
}
