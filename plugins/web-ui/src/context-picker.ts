import { html, nothing, type TemplateResult } from "lit";
import { errMessage } from "../../chassis/src/errors";
import { contextsState, personalScopeId, scopeTitle } from "./contexts";

/**
 * "Change context" for a Drive folder or a file.
 *
 * One dialog for both, because the question is identical — which conversations
 * can reach this thing — even though the two moves are implemented very
 * differently underneath. Two dialogs would drift in wording, and the wording
 * is the part that matters: moving a folder into a project does not lend
 * anyone your Google access, and people reasonably assume it does.
 */

type MoveKind = "folder" | "file" | "conversation";

export interface MoveTarget {
  /** Shown in the heading. */
  label: string;
  /** Where it is now. */
  current: string;
  /** Performs the move. Rejects with a message the dialog will show. */
  move: (scopeId: string) => Promise<void>;
  /** Folders carry the extra warning about whose Google account is used. */
  kind: MoveKind;
}

let open: MoveTarget | null = null;
let choice = "";
let busy = false;
let error = "";

export function openContextPicker(target: MoveTarget, rerender: () => void): void {
  open = target;
  choice = target.current;
  busy = false;
  error = "";
  rerender();
}

export function resetContextPicker(): void {
  open = null;
  choice = "";
  busy = false;
  error = "";
}

/** Contexts this person could move something into, current one included. */
function movableContexts(kind: MoveKind): Array<{ scopeId: string; title: string }> {
  const personal = personalScopeId();
  return contextsState.list
    .filter((c) =>
      kind === "conversation"
        ? c.scopeId === personal || Boolean(c.project)
        : c.scopeId === personal || c.kind === "channel" || c.kind === "group",
    )
    .map((c) => ({ scopeId: c.scopeId, title: scopeTitle(c.scopeId, c.name) }))
    .sort((a, b) => {
      if (a.scopeId === personal) return -1;
      if (b.scopeId === personal) return 1;
      return a.title.localeCompare(b.title);
    });
}

function moveLabel(kind: MoveKind): string {
  if (kind === "folder") return "Move folder";
  return kind === "file" ? "Move file" : "Move conversation";
}

export function contextPickerTpl(rerender: () => void): TemplateResult | typeof nothing {
  const t = open;
  if (!t) return nothing;

  const close = (): void => {
    resetContextPicker();
    rerender();
  };

  const options = movableContexts(t.kind);
  const destination = options.find((o) => o.scopeId === choice);
  const moving = Boolean(destination) && choice !== t.current;
  const conversation = t.kind === "conversation";

  return html`<div
    class="kc-dialog-scrim"
    @click=${(e: Event) => {
      if (e.target === e.currentTarget) close();
    }}
  >
    <section class="kc-confirm drive-picker">
      <header class="drive-picker-head"><h2>Change context</h2></header>
      <p class="drive-note">
        ${conversation ? html`Where “${t.label}” lives.` : html`Which conversations can reach “${t.label}”.`}
      </p>

      <div class="context-choices">
        ${options.map(
          (o) =>
            html`<label class="context-choice ${o.scopeId === choice ? "active" : ""}">
              <input
                type="radio"
                name="move-context"
                .checked=${o.scopeId === choice}
                @change=${() => {
                  choice = o.scopeId;
                  error = "";
                  rerender();
                }}
              />
              <span>${o.title}</span>
              ${o.scopeId === t.current ? html`<span class="badge">now</span>` : nothing}
            </label>`,
        )}
      </div>

      ${
        moving && t.kind === "folder" && destination
          ? html`<p class="drive-note">
              Everyone in ${destination.title} will see this folder. Each of them reaches it with their own Google
              account, so they see only what they can already open — moving it here does not share your access.
            </p>`
          : nothing
      }
      ${
        moving && t.kind === "file" && destination
          ? html`<p class="drive-note">
              Everyone in ${destination.title} will be able to open this file. You stay its owner.
            </p>`
          : nothing
      }
      ${
        moving && conversation && destination
          ? html`<p class="drive-note">
              ${
                destination.scopeId === personalScopeId()
                  ? html`Only you will see this conversation — everyone else in ${scopeTitle(t.current)} loses it.`
                  : html`Everyone in ${destination.title} will see this conversation and can continue it.`
              }
              Its files and memories stay behind in ${scopeTitle(t.current)}’s workspace, and any share link for it
              stops working.
            </p>`
          : nothing
      }
      ${error ? html`<p class="drive-note warning">${error}</p>` : nothing}

      <footer class="drive-picker-foot">
        <button class="btn" type="button" @click=${close}>Cancel</button>
        <button
          class="primary"
          type="button"
          ?disabled=${busy || !moving}
          @click=${async () => {
            busy = true;
            error = "";
            rerender();
            try {
              await t.move(choice);
              resetContextPicker();
            } catch (e) {
              error = errMessage(e);
            } finally {
              busy = false;
              rerender();
            }
          }}
        >
          ${busy ? "Moving…" : moveLabel(t.kind)}
        </button>
      </footer>
    </section>
  </div>`;
}
