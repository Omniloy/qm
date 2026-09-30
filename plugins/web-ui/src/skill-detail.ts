import { html, nothing, render, type TemplateResult } from "lit";
import { api, ApiError } from "./core-bridge";
import type { SkillItem } from "./composer";
import { errMessage } from "../../chassis/src/errors";
import { isArchivedSkill } from "./skill-registry";
import { listBackLink } from "./list-page";
import { markdown } from "./message-markdown";
import { relTime } from "./ui";

export interface SkillDetailActions {
  home: (skill: SkillItem) => string;
  scopeLabel?: (scopeId: string) => string;
  onBack: () => void;
  onEdit: (skill: SkillItem) => void;
}

type DetailLoad = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; skill: SkillItem };

let detailRequestSeq = 0;

export async function renderSkillDetail(host: HTMLElement, row: SkillItem, actions: SkillDetailActions): Promise<void> {
  const request = ++detailRequestSeq;
  const paint = (load: DetailLoad): void => {
    render(detailTpl(row, load, actions), host);
  };
  if (!row.id) {
    paint({ state: "failed", message: "This skill has no id, so its instructions can't be loaded." });
    return;
  }
  paint({ state: "loading" });
  try {
    const { skill } = await api<{ skill: SkillItem }>(`/api/skills/${encodeURIComponent(row.id)}`);
    if (request !== detailRequestSeq) return;
    paint({ state: "ready", skill: { ...row, ...skill } });
  } catch (e) {
    if (request !== detailRequestSeq) return;
    const missing = e instanceof ApiError && e.status === 404;
    paint({
      state: "failed",
      message: missing
        ? "This skill no longer exists, or you can no longer see it."
        : errMessage(e, "Failed to load skill details."),
    });
  }
}

function authorLabel(createdBy: string | undefined): string {
  if (!createdBy) return "Unknown";
  if (createdBy.startsWith("system:")) return "Built-in";
  if (createdBy.startsWith("pack:")) return "Skill pack";
  return createdBy;
}

export function ownerLabel(skill: Pick<SkillItem, "ownerName" | "ownedByViewer">): string {
  if (skill.ownedByViewer) return "You";
  return skill.ownerName ?? "Unknown";
}

function sharedWithTpl(skill: SkillItem, actions: SkillDetailActions): TemplateResult | typeof nothing {
  const label = actions.scopeLabel ?? ((scopeId: string) => scopeId);
  const shares = (skill.sharedWith ?? []).filter((g) => !g.scopeId.startsWith("org:"));
  const chips = [...(skill.orgWide ? ["Everyone"] : []), ...shares.map((g) => label(g.scopeId))];
  if (!chips.length) return nothing;
  return field("Shared with", chips.join(", "));
}

function field(label: string, value: unknown): TemplateResult {
  return html`<div class="field">
    <label>${label}</label>
    <div class="value">${value}</div>
  </div>`;
}

function filesValue(skill: SkillItem, load: DetailLoad): unknown {
  if (load.state !== "ready") return skill.assetCount ?? 0;
  if (!skill.files?.length) return "None";
  return html`<ul class="skill-detail-files">
    ${skill.files.map((file) => html`<li><code>${file.path}</code>${file.executable ? " (executable)" : ""}</li>`)}
  </ul>`;
}

function loadedTpl(skill: SkillItem, load: DetailLoad): TemplateResult {
  if (load.state === "loading") return html`<p class="card-meta skill-detail-status">Loading instructions…</p>`;
  if (load.state === "failed") return html`<div class="form-error" role="alert">${load.message}</div>`;
  return html`${field("Created by", authorLabel(skill.createdBy))}
    ${
      skill.updatedAt
        ? field(
            "Updated",
            html`<time title=${new Date(skill.updatedAt).toLocaleString()}>${relTime(skill.updatedAt)}</time>`,
          )
        : nothing
    }
    <div class="field skill-detail-instructions">
      <label>Instructions</label>
      ${skill.body ? markdown(skill.body) : html`<div class="value card-meta">No instructions.</div>`}
    </div>`;
}

function detailTpl(row: SkillItem, load: DetailLoad, actions: SkillDetailActions): TemplateResult {
  const skill = load.state === "ready" ? load.skill : row;
  const archived = isArchivedSkill(skill);
  const canEdit = load.state === "ready" && skill.editable === true && !archived;
  return html`<div class="resource-detail">
    ${listBackLink("Skills", actions.onBack)}
    <div class="resource-heading">
      <h2 dir="auto">/${skill.name}</h2>
      ${archived ? html`<span class="badge">Archived</span>` : nothing}
      ${canEdit ? html`<button class="btn skill-detail-edit" type="button" @click=${() => actions.onEdit(skill)}>Edit</button>` : nothing}
    </div>
    <div class="field">
      <label>Description</label>
      <div class="value" dir="auto">${skill.description}</div>
    </div>
    ${field("Home", actions.home(skill))} ${field("Owner", ownerLabel(skill))} ${sharedWithTpl(skill, actions)}
    ${field("Version", skill.version ?? 1)}
    ${field("Source", skill.source === "pack" ? `Pack ${skill.pack?.upstreamName ?? "source"}` : "Local")}
    ${field("Capabilities", skill.requiredCapabilities?.length ? skill.requiredCapabilities.join(", ") : "None required")}
    ${field("Files", filesValue(skill, load))} ${loadedTpl(skill, load)}
  </div>`;
}
