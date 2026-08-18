/**
 * The signed-in application.
 *
 * Split out of main.ts so that `/share/<id>` can be served by the same bundle entry without
 * loading any of this. The split is load-bearing rather than cosmetic: line 1 below pulls in
 * ./shell, whose module body installs the sign-in handler and whose boot() renders an auth gate
 * over #app on a 401 — which is exactly what an anonymous reader of a shared conversation would
 * have got. Static imports are evaluated before the importing module's body runs, so a runtime
 * route check inside this file could not have prevented it; the check has to live in main.ts and
 * this file has to be reached by dynamic import.
 */
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
