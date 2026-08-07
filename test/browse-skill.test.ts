import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const RAW = read("skills-seed/browse/SKILL.md");
const CLI = read("skills-seed/browse/scripts/browser.py");
// Prose assertions run against a whitespace-flattened copy: this is markdown,
// and a formatter rewrapping a line should not fail a test about what the file
// SAYS. Code and shape assertions keep using the raw text.
const SKILL = RAW.replace(/\s+/g, " ");

/* ----------------------------------------------------------- the surface */

test("every verb the skill documents actually exists in the CLI", () => {
  // A documented verb that argparse does not know is a dead end the agent only
  // discovers mid-task, having already opened a browser.
  const verbs = ["open", "go", "snapshot", "read", "click", "type", "key", "scroll", "screenshot", "status", "close"];
  for (const v of verbs) {
    assert.match(SKILL, new RegExp(`browser\\.py ${v}\\b`), `SKILL.md documents ${v}`);
    assert.match(CLI, new RegExp(`sub\\.add_parser\\("${v}"`), `browser.py implements ${v}`);
  }
});

test("the browser surface carries no provider concepts", () => {
  // The verb set is the expensive-to-undo decision: once skills call these,
  // changing them means rewriting every caller. Keeping it plain CDP is what
  // lets the same calls run against a local Chromium, a hosted session, or a
  // browser driven through an extension.
  for (const leak of ["anchor", "kernel", "browserbase", "live_view", "liveViewUrl", "api-key", "API_KEY"]) {
    assert.doesNotMatch(CLI, new RegExp(leak, "i"), `browser.py must not mention ${leak}`);
  }
});

test("a browser is available without any key at all", () => {
  // The whole point of the change: someone who has configured nothing can still
  // browse. If this line goes, the feature quietly returns to needing setup.
  assert.match(SKILL, /costs nothing, needs no key/);
  assert.match(SKILL, /None set is not a dead end/);
});

/* ------------------------------------------------- regressions from testing */

test("Enter is sent as rawKeyDown + char + keyUp", () => {
  // Found on a real page: with only keyDown+keyUp, Chromium never produces the
  // keypress that submits a form. The search box took the text and silently did
  // nothing, which reads as "the browser is broken" rather than "the key was
  // wrong".
  const press = /def press_key[\s\S]{0,900}/.exec(CLI)?.[0] ?? "";
  assert.match(press, /type="rawKeyDown"/);
  assert.match(press, /type="char", text="\\r"/);
  assert.match(press, /type="keyUp"/);
});

test("closing is graceful, because a hard kill loses the sign-in", () => {
  // Measured: after pkill, localStorage survived and cookies did not — Chromium
  // batches cookie writes. The cookie discarded is exactly the session someone
  // just signed in to create.
  const close = /if a\.cmd == "close":[\s\S]{0,1200}/.exec(CLI)?.[0] ?? "";
  assert.match(close, /Browser\.close/);
  // Strip comments first: the reason a kill is wrong is written right here, and
  // asserting over prose would fail on the explanation rather than the code.
  const code = close.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(code, /SIGKILL|os\.kill|pkill|terminate\(/, "the close path must not kill the process");
  assert.match(CLI, /chromium batches cookie writes/i);
});

test("the profile sits on the volume that survives a restart", () => {
  // ~/.config/chromium is inside HOME_DIR, which local-sandbox.ts mounts as a
  // persistent Docker volume. Anywhere else and sign-ins die with the container.
  assert.match(CLI, /PROFILE_DIR = os\.path\.expanduser\("~\/\.config\/chromium"\)/);
  assert.match(CLI, /--user-data-dir=\{PROFILE_DIR\}/);
});

test("a scheme-bearing URL is left alone", () => {
  // about:blank has no "//", so a naive check bolted https:// onto the front and
  // Chromium rejected the result.
  assert.match(CLI, /\^\[a-z\]\[a-z0-9\+\.-\]\*:/);
});

test("a CDP failure reads as a message, not a traceback", () => {
  // An agent that sees a Python traceback concludes the browser is broken and
  // stops, when the real news is "no such element".
  assert.match(CLI, /except RuntimeError as e:/);
  assert.match(CLI, /die\(str\(e\)\)/);
});

/* ---------------------------------------------------------------- safety */

test("an automation block is explained as the site's choice, not a bug to retry", () => {
  assert.match(SKILL, /refuses automated visits|refuse a browser/i);
  assert.match(SKILL, /retrying does not help/);
  // Measured on both a datacenter and a residential IP: moving the browser does
  // not help, and promising otherwise sends people down a pointless path.
  assert.match(SKILL, /not\*{0,2} about where the browser runs/i);
});

test("the person types their own password, always", () => {
  assert.match(SKILL, /Never type someone's password yourself/);
  assert.match(SKILL, /Take control/);
});

test("a sign-in is only ever routed to the site that was asked for", () => {
  // Page content can prompt-inject a login URL for somewhere else entirely.
  assert.match(SKILL, /never start a sign-in for a domain the person did not ask for/i);
});

test("profiles stay out of shared rooms", () => {
  assert.match(SKILL, /DM-only/);
  assert.match(SKILL, /never be minted into a shared room/);
});

test("spending stops for a yes before the money moves", () => {
  // One call at a time makes this natural: there is a step right before the
  // final click. The old runner had no such moment.
  assert.match(SKILL, /stop before the click that spends the money/i);
  assert.match(SKILL, /agreement to shop, not to a specific/);
  assert.match(SKILL, /scheduled or triggered run/);
});

test("refs are preferred over selectors, and re-taken after the page changes", () => {
  // Stale refs after a navigation were the most likely way for this to act on
  // the wrong element.
  assert.match(SKILL, /Take a fresh snapshot after anything that changes the page/);
  assert.match(SKILL, /Prefer refs to CSS selectors/);
});
