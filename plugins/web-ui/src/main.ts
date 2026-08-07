import "dockview-core/dist/styles/dockview.css";
import "./shell.css";
import { bootSafely } from "./shell";
import { closeFormMenus } from "./ui";
import { redrawFilesPage } from "./files";
import { allConversations } from "./conversations";
import { closeOpenSessionMenu, renderList, sessionsState } from "./sessions";
import { closeDeployMenu } from "./deploys";
import { closeRowMenu } from "./row-actions";

function closeComposerMenus(keepOpenWithin: Element | null): boolean {
  let changed = false;
  for (const conv of allConversations()) {
    if (keepOpenWithin && conv.state.host?.contains(keepOpenWithin)) continue;
    if (!conv.composer.closeMenus()) continue;
    changed = true;
    conv.redraw();
  }
  return changed;
}

document.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  const inside = target?.closest(".menu-control, .composer-wrap") ?? null;
  closeComposerMenus(inside);
  if (!target?.closest(".form-menu-control")) closeFormMenus();
  if (sessionsState.openMenuId && !target?.closest(".session-menu")) {
    sessionsState.openMenuId = null;
    renderList();
  }
  closeDeployMenu(target);
  if (closeRowMenu(target)) redrawFilesPage();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeComposerMenus(null);
  closeOpenSessionMenu();
  closeDeployMenu(null, true);
  if (closeRowMenu(null)) redrawFilesPage();
  closeFormMenus();
});

void bootSafely();
