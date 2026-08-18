/**
 * The bundle entry, and nothing else.
 *
 * This file exists to decide ONE thing before any application code is evaluated: whether this
 * page is `/share/<id>` — read by a stranger with no account — or the signed-in app. It must do
 * that with dynamic imports, because a static `import "./app-main"` would be evaluated before
 * this module's body ever ran, and ./shell's module body installs the sign-in handler while its
 * boot() replaces #app with an auth gate on a 401. That is the bug this split fixes: a share URL
 * used to render the signed-in app's sign-in wall and share-view.ts was never loaded at all.
 *
 * The stylesheets stay here so both routes are styled and so their order cannot drift: dockview's
 * sheet must load before shell.css, which overrides parts of it.
 */
import "dockview-core/dist/styles/dockview.css";
import "./shell.css";

/**
 * Anchored, and deliberately duplicated from share-view.ts's SHARE_PATH_RE rather than imported.
 * Importing share-view here to reuse the matcher would pull the share page into the entry chunk
 * for every signed-in load, which is the mirror image of the problem this file solves. The two
 * are pinned to each other by test/share-view.test.ts.
 */
const SHARE_PATH = /^\/share\/[A-Za-z0-9-]{32,80}$/;

const BASE = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");
const routePath =
  BASE && window.location.pathname.startsWith(BASE)
    ? window.location.pathname.slice(BASE.length)
    : window.location.pathname;

if (SHARE_PATH.test(routePath)) {
  void import("./share-view").then((m) => {
    m.startShareView();
  });
} else {
  void import("./app-main");
}
