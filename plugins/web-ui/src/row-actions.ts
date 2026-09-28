import { html, nothing, type TemplateResult } from "lit";
import { MoreHorizontal } from "lucide";
import { icon } from "./ui";
import type { RowActionSpec } from "./drive-mount";

let openMenu: { key: string; rerender: () => void } | null = null;

export function closeRowMenu(target: Element | null): void {
  if (!openMenu || target?.closest(".row-menu")) return;
  const { rerender } = openMenu;
  openMenu = null;
  if (document.querySelector(".row-menu .session-menu-popover")) rerender();
}

export function resetRowMenus(): void {
  openMenu = null;
}

export function rowMenuTpl(
  key: string,
  label: string,
  actions: readonly RowActionSpec[],
  onSelect: (id: string) => void,
  rerender: () => void,
): TemplateResult {
  const open = openMenu?.key === key;
  return html`<div class="session-menu row-menu">
    <button
      class="session-menu-btn"
      type="button"
      aria-label=${`More actions for ${label}`}
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      @click=${(event: Event) => {
        event.stopPropagation();
        openMenu = open ? null : { key, rerender };
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
                    openMenu = null;
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
