import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { choiceGroup, saveFooter } from "./setting-controls.ts";
import type { SettingsState } from "./settings.ts";

type Member = { principalId: string; displayName?: string };

export function fastModeAccessDraft(data: Record<string, any>) {
  const people: string[] | null = data.fastModeAccess?.people ?? null;
  return { audience: people ? "people" : "everyone", people: people ?? [], adding: "" };
}

export function fastModeAccessBody(draft: Record<string, any>, validate: boolean) {
  if (draft.audience !== "people") return { people: null };
  if (validate && !draft.people.length) throw new Error("Add at least one person, or choose Everyone.");
  return { people: [...draft.people] };
}

function addPerson(s: SettingsState) {
  const id = String(s.draft.adding || "").trim();
  if (!id || /\s/.test(id)) return;
  const folded = id.includes("@") ? id.toLowerCase() : id;
  if (!s.draft.people.includes(folded)) s.draft.people = [...s.draft.people, folded];
  s.draft.adding = "";
  s.changed();
}

export function fastModeAccessCard(s: SettingsState) {
  const directory: Member[] = s.context.fastModeAccess?.directory ?? [];
  const nameOf = (id: string) =>
    directory.find((m) => m.principalId === id || m.principalId.toLowerCase() === id)?.displayName;
  const people: string[] = s.draft.people ?? [];
  const limited = s.draft.audience === "people";
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !s.available, dirty: s.dirty })}
    id="card-fast-mode-access"
  >
    <div class="head">
      <h2>Fast mode access</h2>
      <p>
        Who may run turns in fast mode. Anyone else, including their scheduled jobs and sub-agents, runs at normal speed
        even when a runtime above has fast mode on, and their model picker hides the fast toggle.
      </p>
    </div>
    <div class="body">
      ${choiceGroup(
        {
          name: "fast-mode-access",
          value: s.draft.audience,
          onChange: (event: Event) => s.change("audience", (event.target as HTMLInputElement).value),
        },
        [
          ["everyone", "Everyone", "Anyone in the organization may use fast mode."],
          ["people", "Only these people", "Only the people listed below may use fast mode."],
        ],
      )}
      ${
        limited
          ? html`<div class="model-add-row" style="margin-top: 12px">
                <div class="model-add-field">
                  <label for="fast-mode-access-add">Add a person</label
                  ><input
                    type="text"
                    id="fast-mode-access-add"
                    list="fast-mode-access-options"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="Name, email, or Slack ID"
                    .value=${s.draft.adding}
                    @input=${(e: Event) => {
                      s.draft.adding = (e.target as HTMLInputElement).value;
                    }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      addPerson(s);
                    }}
                  /><datalist id="fast-mode-access-options">
                    ${repeat(
                      directory,
                      (m) => m.principalId,
                      (m) => html`<option value=${m.principalId} label=${m.displayName || m.principalId}></option>`,
                    )}
                  </datalist>
                </div>
                <button type="button" id="fast-mode-access-add-button" @click=${() => addPerson(s)}>
                  + Add person
                </button>
              </div>
              <div id="fast-mode-access-list" class="model-list">
                ${
                  people.length
                    ? nothing
                    : html`<p class="hint" id="fast-mode-access-empty">No one yet. Add at least one person.</p>`
                }
                ${repeat(
                  people,
                  (id) => id,
                  (id) =>
                    html`<span data-person=${id} class="model-chip"
                      ><span>${nameOf(id) ? `${nameOf(id)} (${id})` : id}</span
                      ><button
                        type="button"
                        aria-label=${"Remove " + id}
                        @click=${() =>
                          s.change(
                            "people",
                            people.filter((p) => p !== id),
                          )}
                      >
                        ×
                      </button></span
                    >`,
                )}
              </div>`
          : nothing
      }
    </div>
    ${saveFooter(s)}
  </section>`;
}
