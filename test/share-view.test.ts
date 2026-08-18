/**
 * Source-level guards on the anonymous share page.
 *
 * These are deliberately text assertions rather than behavioural ones. The behavioural suite lives
 * at plugins/web-ui/test/share-view.test.ts, where jsdom and DOMPurify exist; what it cannot prove
 * is the *absence* of an import, and absence is the entire safety property here. Every rule below
 * is one that a plausible, well-meaning refactor breaks:
 *
 *   - importing `./chat` to reuse its renderer drags in shell.ts's sign-in redirect AND silently
 *     relocates the only DOMPurify install in the client (chat.ts's module body) away from the
 *     page that needs it;
 *   - reaching for core-bridge's `api()` because it is the house helper turns any 401 into a
 *     full-app auth gate via reportSigninRequired (core-bridge.ts:462);
 *   - linking an attachment at /api/files/:id/content because that is what the product does hands
 *     a link holder a route that re-checks their ACL and 404s.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/**
 * Comments are stripped before scanning: this file's own prose names the very identifiers and
 * routes it forbids, and a guard that trips on the explanation of the guard is a guard nobody
 * keeps.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SHARE_VIEW = "plugins/web-ui/src/share-view.ts";
const MAIN = "plugins/web-ui/src/main.ts";
const src = code(read(SHARE_VIEW));
const sanitizeSrc = code(read("plugins/web-ui/src/markdown-sanitize.ts"));
const mainSrc = code(read(MAIN));

/** Relative/bare module specifiers this file imports at runtime (type-only imports erased). */
function runtimeImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)";/gm)) out.push(m[1]!);
  for (const m of text.matchAll(/^import\s+"([^"]+)";/gm)) out.push(m[1]!);
  return out;
}

test("the share page never imports chat.ts, shell.ts, sessions.ts or core-bridge.ts", () => {
  const banned = ["./chat", "./shell", "./sessions", "./core-bridge", "./conv-types", "./session-list"];
  for (const spec of runtimeImports(src)) {
    const bare = spec.replace(/\.ts$/, "");
    assert.ok(
      !banned.includes(bare),
      `${SHARE_VIEW} imports ${spec}; that module (or its module body) mounts the signed-in app ` +
        `and its sign-in redirect on a page anonymous readers load`,
    );
  }
});

/* ------------------------------------------------------------------ the entry split */

test("the bundle entry routes /share/<id> without statically importing the app", () => {
  // The CRITICAL failure this pins: main.ts used to be `import { bootSafely } from "./shell"`,
  // and shell.ts's module body installs the sign-in handler while boot() replaces #app with an
  // auth gate on a 401. Static imports are evaluated before the importing module's body, so no
  // runtime check inside main.ts could have prevented it — a share URL rendered a login wall and
  // share-view.ts was tree-shaken out of the bundle entirely.
  for (const spec of runtimeImports(mainSrc)) {
    const bare = spec.replace(/\.ts$/, "");
    assert.ok(
      bare.endsWith(".css") || !["./shell", "./chat", "./sessions", "./app-main", "./share-view"].includes(bare),
      `${MAIN} statically imports ${spec}; the route decision has to come first, so both branches must be dynamic`,
    );
  }
  assert.match(mainSrc, /import\("\.\/share-view"\)/, "main.ts must dynamically import the share page");
  assert.match(mainSrc, /import\("\.\/app-main"\)/, "main.ts must dynamically import the signed-in app");
  assert.match(mainSrc, /SHARE_PATH\s*=\s*\/\^/, "the route match must be anchored, not a prefix test");
  assert.ok(!/pathname\.startsWith\("\/share/.test(mainSrc), "a prefix test is one typo from the authed app");
});

test("index.html still has exactly one entry, and it is the router shim", () => {
  const html = read("plugins/web-ui/index.html");
  const entries = [...html.matchAll(/<script\s+type="module"\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(entries, ["/src/main.ts"], "the split lives inside main.ts, not in a second html entry");
});

test("the app body moved to app-main.ts rather than staying reachable from the entry", () => {
  const appMain = code(read("plugins/web-ui/src/app-main.ts"));
  assert.ok(appMain.includes("bootSafely()"), "app-main.ts must be the thing that boots the signed-in app");
  assert.ok(!mainSrc.includes("bootSafely"), "main.ts must not boot anything itself");
});

/**
 * Everything the share chunk pulls in, walked rather than asserted about one file.
 *
 * The banned-import test above proves share-view.ts does not name ./chat. It does not prove the
 * chunk is clean: one module two hops away importing ./shell would put the sign-in handler back
 * on the page and nothing in a single-file check would notice. This walks the graph the bundler
 * would, from the share branch of main.ts.
 */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    for (const spec of runtimeImports(code(read(rel)))) {
      if (!spec.startsWith(".")) continue;
      if (spec.endsWith(".css")) continue;
      const parts = `${dir}/${spec.replace(/\.ts$/, "")}`.split("/");
      const out: string[] = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") out.pop();
        else out.push(part);
      }
      queue.push(`${out.join("/")}.ts`);
    }
  }
  return seen;
}

test("the whole share chunk — not just its entry file — is free of the signed-in app", () => {
  const reachable = reachableFrom(SHARE_VIEW);
  for (const banned of [
    "plugins/web-ui/src/shell.ts",
    "plugins/web-ui/src/chat.ts",
    "plugins/web-ui/src/sessions.ts",
    "plugins/web-ui/src/core-bridge.ts",
    "plugins/web-ui/src/conversations.ts",
  ]) {
    assert.ok(!reachable.has(banned), `the share page transitively loads ${banned}`);
  }
  // And the install site really is on that graph, which is the claim the comments make.
  assert.ok(reachable.has("plugins/web-ui/src/markdown-sanitize.ts"));
});

test("the share page installs the markdown sanitizer for itself", () => {
  assert.ok(
    /from "\.\/markdown-sanitize(\.ts)?"/.test(src),
    "share-view.ts must import ./markdown-sanitize explicitly — chat.ts is not there to do it",
  );
  const installedHere = /^installMarkdownSanitizer\(\);\s*$/m.test(src);
  const installedByModule = /^installMarkdownSanitizer\(\);\s*$/m.test(sanitizeSrc);
  assert.ok(
    installedHere || installedByModule,
    "nothing installs DOMPurify on the share path: either markdown-sanitize.ts must install in " +
      "its own module body, or share-view.ts must call installMarkdownSanitizer() itself",
  );
});

test("the share page uses bare fetch, never core-bridge's api()", () => {
  assert.ok(/\bfetch\(/.test(src) || /fetchImpl/.test(src), "the page must fetch something");
  assert.ok(
    !/\bapi</.test(src) && !/[^.\w]api\(/.test(src),
    "api() reports a 401 to setSigninRequiredHandler, which re-renders all of #app as an auth gate",
  );
  assert.ok(!/reportSigninRequired/.test(src));
});

test("the share page opens no delivery stream", () => {
  assert.ok(!/EventSource/.test(src), "a stranger's browser would retry an SSE connection forever");
});

test("the share page talks to exactly one path prefix", () => {
  assert.ok(src.includes("/api/public/shares/"));
  for (const forbidden of ["/api/files/", "/api/sessions", "/api/runtime-config", "/api/deliveries", '"/me"']) {
    assert.ok(!src.includes(forbidden), `${SHARE_VIEW} references ${forbidden}`);
  }
});

test("the share path matcher is anchored, not a prefix test", () => {
  assert.ok(/\/\^\\\/share\\\//.test(src.replace(/\s/g, "")) || /SHARE_PATH_RE\s*=\s*\/\^/.test(src));
  assert.ok(!/pathname\.startsWith\("\/share/.test(src), "a prefix test is one typo from the authed relay");
});

test("the live share polls on a ten-second interval", () => {
  assert.match(src, /POLL_MS\s*=\s*10_000/);
});

test("the three access states are all rendered, and only the member state gets a session id", () => {
  for (const state of ["anonymous", "member", "outsider"]) {
    assert.ok(src.includes(`"${state}"`), `access state ${state} is not handled`);
  }
  assert.match(src, /You're viewing a shared conversation/);
  assert.match(src, /you don't have access to this project/);
  assert.match(src, /Open in \$\{BRAND\.productName\}/);
  // sessionId is the one field core withholds from non-members; it must only ever build the
  // "Open in <product>" link, never a fetch path.
  const sessionIdUses = [...src.matchAll(/sessionId/g)].length;
  assert.ok(sessionIdUses > 0 && !/shares\/\$\{[^}]*sessionId/.test(src));
});

test("the payload the page reads carries no threadRef, scopeId or principal id", () => {
  for (const leak of ["threadRef", "scopeId", "principalId", "sharerId"]) {
    assert.ok(!src.includes(leak), `${SHARE_VIEW} expects ${leak} in the share payload; core must never send it`);
  }
});

test("the standing disclosure about what is and isn't shared is verbatim", () => {
  // "in the transcript" is the load-bearing half. A log the agent wrote from command output ships
  // as a downloadable attachment on this very page, so the unqualified sentence the page used to
  // carry ("command output ... aren't included") was false beside its own download chips. This is
  // word for word the dialog's SHARE_BULLET_CONTENTS qualifier.
  assert.ok(
    src.includes(
      "Messages and attached files are shared. Tool activity, command output, and thinking are not shown in the transcript.",
    ),
    "a copy edit that softens or drops this sentence must fail the build, not ship quietly",
  );
  assert.ok(!src.includes("aren't included"), "the unqualified claim contradicts the page's own download chips");
});

test("the share page carries no capability-token plumbing", () => {
  // The share id IS the secret; core mints no `?t=`. Threading one through was a parameter no
  // server read — and, because the dialog gated Copy on receiving one, a link nobody could copy.
  assert.ok(!/shareToken|withToken|\bt=\b/.test(src), "there is no capability token on a share URL");
  assert.ok(!src.includes('get("t")'));
});

test("the public payload the page reads carries no mimetype", () => {
  // SharedFileDownload omits it in core so that serving an attacker-chosen content type is
  // structurally impossible. The field is the first thing a "preview images inline" change would
  // reach for, so the page does not model it either.
  assert.ok(!src.includes("mimetype"), "a shared attachment is a download chip and nothing else");
});
