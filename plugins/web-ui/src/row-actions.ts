import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { MoreHorizontal } from "lucide";
import { icon } from "./ui.ts";
import type { RowActionSpec } from "./drive-mount";

let openMenu: { key: string; rerender: () => void } | null = null;

export function closeRowMenu(target: Element | null): void {
  if (!openMenu || target?.closest(".row-menu")) return;
  const { rerender } = openMenu;
  openMenu = null;
  if (document.querySelector(".row-menu .session-menu-popover")) rerender();
}

export function placeMenuPopover(el?: Element): void {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove("drop-up");
  const margin = 8;
  const scrollport = el.closest(".list, .pane")?.getBoundingClientRect();
  const bottomLimit = Math.min(window.innerHeight, scrollport?.bottom ?? Infinity) - margin;
  const topLimit = Math.max(0, scrollport?.top ?? 0) + margin;
  const rect = el.getBoundingClientRect();
  const anchorTop = el.parentElement?.getBoundingClientRect().top ?? rect.top;
  if (rect.bottom > bottomLimit && anchorTop - 4 - rect.height >= topLimit) {
    el.classList.add("drop-up");
  }
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
        ? html`<div
            class="session-menu-popover"
            role="menu"
            ${ref((el) => queueMicrotask(() => placeMenuPopover(el)))}
            @click=${(event: Event) => event.stopPropagation()}
          >
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
