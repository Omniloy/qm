import { html, nothing, type TemplateResult } from "lit";
import { MoreHorizontal } from "lucide";
import { icon } from "./ui";
import type { RowActionSpec } from "./drive-mount";

/**
 * The overflow menu on a list row.
 *
 * A row can only keep one action visible before its layout starts fighting
 * itself at narrow widths, so everything beyond the primary action lives here.
 * Deliberately shared: Drive folder rows and file rows must behave identically,
 * and two hand-rolled menus would drift.
 *
 * Reuses the `.session-menu*` markup the sessions and apps lists already use,
 * so this inherits their styling and their keyboard behaviour rather than
 * introducing a third look for the same control.
 */

/** Which menu is open, as `${kind}:${id}`. At most one across the page. */
let openKey: string | null = null;

/**
 * Close the open menu unless the event landed inside one.
 *
 * Called from the document-level click and Escape handlers in main.ts, which
 * is where every other menu in this app is dismissed from. Returns whether
 * anything changed, so the caller can skip a redraw.
 */
export function closeRowMenu(target?: Element | null): boolean {
  if (!openKey || target?.closest(".row-menu")) return false;
  openKey = null;
  return true;
}

/** Drop menu state when the view is torn down, so it cannot reopen on return. */
export function resetRowMenus(): void {
  openKey = null;
}

export function rowMenuTpl(
  key: string,
  label: string,
  actions: readonly RowActionSpec[],
  onSelect: (id: string) => void,
  rerender: () => void,
): TemplateResult {
  const open = openKey === key;
  return html`<div class="session-menu row-menu">
    <button
      class="session-menu-btn"
      type="button"
      aria-label=${`More actions for ${label}`}
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      @click=${(event: Event) => {
        // Without this the document listener in main.ts sees the same click
        // and closes the menu in the tick it was opened.
        event.stopPropagation();
        openKey = open ? null : key;
        rerender();
      }}
    >
      ${icon(MoreHorizontal, 16)}
    </button>
    ${
      open
        ? html`<div class="session-menu-popover" role="menu" @click=${(event: Event) => event.stopPropagation()}>
            ${actions.map(
              (a) =>
                html`<button
                  class="session-menu-option ${a.danger ? "danger" : ""}"
                  type="button"
                  role="menuitem"
                  ?disabled=${a.disabled}
                  title=${a.reason ?? ""}
                  @click=${() => {
                    openKey = null;
                    onSelect(a.id);
                    rerender();
                  }}
                >
                  <span>${a.label}</span>
                </button>`,
            )}
          </div>`
        : nothing
    }
  </div>`;
}
