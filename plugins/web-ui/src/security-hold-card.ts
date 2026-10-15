import { html, nothing, type TemplateResult } from "lit";
import { ShieldAlert } from "lucide";
import { icon } from "./ui.ts";
import type { ApprovalDecision, PendingApproval, SecurityHoldView } from "./core-bridge.ts";

interface HoldUiState {
  showBlocked: boolean;
  reporting: boolean;
  sending: boolean;
  reported: boolean;
  note: string;
  error?: string;
}

export interface SecurityHoldActions {
  disabled: boolean;
  decide(decision: ApprovalDecision): void;
  report(requestId: string, note: string): Promise<void>;
  redraw(): void;
}

const holdUi = new Map<string, HoldUiState>();

export function pruneHoldUi(pendingRequestIds: Iterable<string>): void {
  const live = new Set(pendingRequestIds);
  for (const requestId of holdUi.keys()) if (!live.has(requestId)) holdUi.delete(requestId);
}

function focusAfterRender(card: HTMLElement | null, selector: string): void {
  queueMicrotask(() => card?.querySelector<HTMLElement>(selector)?.focus());
}

function uiFor(requestId: string): HoldUiState {
  let state = holdUi.get(requestId);
  if (!state) {
    state = { showBlocked: false, reporting: false, sending: false, reported: false, note: "" };
    holdUi.set(requestId, state);
  }
  return state;
}

function holdTitle(view: SecurityHoldView): TemplateResult {
  const at = view.subject ? view.title.indexOf(view.subject) : -1;
  if (!view.subject || at < 0) return html`${view.title}`;
  return html`${view.title.slice(0, at)}<b>${view.subject}</b>${view.title.slice(at + view.subject.length)}`;
}

function holdHead(view: SecurityHoldView): TemplateResult {
  return html`<div class="hold-head">
    <span class="hold-shield">${icon(ShieldAlert, 18)}</span>
    <div class="hold-heading">
      <div class="hold-title">${holdTitle(view)}</div>
      <span class="hold-category">${view.categoryLabel}</span>
    </div>
  </div>`;
}

export function securityHoldMarker(view: SecurityHoldView): TemplateResult {
  return html`<div class="hold-card hold-marker">${holdHead(view)}</div>`;
}

export function securityHoldCard(
  a: PendingApproval,
  view: SecurityHoldView,
  actions: SecurityHoldActions,
): TemplateResult {
  const ui = uiFor(a.requestId);
  const cardOf = (event: Event): HTMLElement | null =>
    (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(".hold-card") ?? null;
  const sendReport = async (event: Event): Promise<void> => {
    event.preventDefault();
    const card = cardOf(event);
    if (ui.sending) return;
    ui.sending = true;
    ui.error = undefined;
    actions.redraw();
    try {
      await actions.report(a.requestId, ui.note);
      ui.reported = true;
      ui.reporting = false;
      focusAfterRender(card, ".hold-sent");
    } catch {
      ui.error = "Could not send the report. Try again.";
    } finally {
      ui.sending = false;
      actions.redraw();
    }
  };
  return html`<div class="hold-card" role="group" aria-label=${view.title}>
    ${holdHead(view)}
    ${
      ui.reported
        ? html`<div class="hold-sent" role="status" tabindex="-1">
            ${icon(ShieldAlert, 16)}<span
              >Saved for your admins to review as a possible false positive. The content is still blocked; choose
              below.</span
            >
          </div>`
        : nothing
    }
    <div class="hold-body">
      <p class="hold-explain">${view.explanation}</p>
      <dl class="hold-facts">
        ${view.facts.map(
          (fact) =>
            html`<dt>${fact.label}</dt>
              <dd>${fact.value}</dd>`,
        )}
      </dl>
      ${
        view.evidence
          ? html`<div class="hold-quote">
              <span class="hold-quote-label">Text the screener flagged</span><mark>${view.evidence}</mark>
            </div>`
          : nothing
      }
      <div class="hold-choices">
        <div><b>Allow once:</b> ${view.allowEffect}</div>
        <div><b>Keep blocked:</b> ${view.keepEffect}</div>
      </div>
      ${ui.showBlocked && a.summaryDetail ? html`<pre class="hold-blocked">${a.summaryDetail}</pre>` : nothing}
      ${
        ui.reporting && !ui.reported
          ? html`<form class="hold-report" @submit=${sendReport}>
              <p class="hold-report-note">
                Your admins will see the blocked content, the screener's reason and your note. Reporting never releases
                the content.
              </p>
              <label for=${`hold-note-${a.requestId}`}>Why does this look wrong? (optional)</label>
              <textarea
                id=${`hold-note-${a.requestId}`}
                .value=${ui.note}
                placeholder="e.g. This is our own built-in skill doing what it documents."
                @input=${(e: Event) => {
                  ui.note = (e.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
              ${ui.error ? html`<p class="hold-report-error" role="alert">${ui.error}</p>` : nothing}
              <div class="hold-report-row">
                <button
                  type="button"
                  class="approval-btn"
                  ?disabled=${ui.sending}
                  @click=${() => {
                    ui.reporting = false;
                    actions.redraw();
                  }}
                >
                  Cancel
                </button>
                <button type="submit" class="approval-btn primary" ?disabled=${ui.sending}>Send to admins</button>
              </div>
            </form>`
          : nothing
      }
      <div class="hold-actions">
        <div class="hold-links">
          ${
            a.summaryDetail
              ? html`<button
                  type="button"
                  class="hold-link"
                  aria-expanded=${ui.showBlocked ? "true" : "false"}
                  @click=${() => {
                    ui.showBlocked = !ui.showBlocked;
                    actions.redraw();
                  }}
                >
                  ${ui.showBlocked ? "Hide" : "Show"} what was blocked
                </button>`
              : nothing
          }
          ${
            ui.reported
              ? nothing
              : html`<button
                  type="button"
                  class="hold-link"
                  aria-expanded=${ui.reporting ? "true" : "false"}
                  @click=${(event: Event) => {
                    ui.reporting = !ui.reporting;
                    actions.redraw();
                    if (ui.reporting) focusAfterRender(cardOf(event), "textarea");
                  }}
                >
                  Looks wrong? Report a false positive
                </button>`
          }
        </div>
        <div class="approval-actions">
          <button
            type="button"
            class="approval-btn"
            ?disabled=${actions.disabled}
            @click=${() => actions.decide({ requestId: a.requestId, approved: false })}
          >
            Keep blocked
          </button>
          <button
            type="button"
            class="approval-btn primary"
            ?disabled=${actions.disabled}
            @click=${() => actions.decide({ requestId: a.requestId, approved: true, scope: "once" })}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  </div>`;
}
