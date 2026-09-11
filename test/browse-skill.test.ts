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

const openBlock = (): string => /if a\.cmd == "open":[\s\S]*?if a\.cmd == "status":/.exec(CLI)?.[0] ?? "";

/* ----------------------------------------------------------- the surface */

test("every verb the skill documents actually exists in the CLI", () => {
  // A documented verb that argparse does not know is a dead end the agent only
  // discovers mid-task, having already opened a browser.
  const verbs = [
    "open",
    "go",
    "snapshot",
    "read",
    "click",
    "type",
    "key",
    "scroll",
    "screenshot",
    "status",
    "close",
    "cookies",
    "storage",
    "net",
  ];
  for (const v of verbs) {
    assert.match(SKILL, new RegExp(`browser\\.py ${v}\\b`), `SKILL.md documents ${v}`);
    assert.match(CLI, new RegExp(`sub\\.add_parser\\("${v}"`), `browser.py implements ${v}`);
  }
});

test("the extension routes to the relay, not a provider doc", () => {
  // The bug this guards: BROWSE_PROVIDER=extension fell through to the hosted
  // -provider branch (read a doc that does not exist) instead of attaching to
  // the person's own Chrome over the relay.
  assert.match(CLI, /chosen == "extension"/);
  assert.match(CLI, /QM_RELAY_URL/);
  assert.match(SKILL, /\*\*`extension`\*\*/);
});

test("the credential verbs exist for curl-based skills and warn about the secret", () => {
  // cookies/storage/net let a skill read the session out of the browser and
  // then call an API directly. HttpOnly is the whole reason `cookies` beats
  // page script, so the doc has to say so, and the values are secrets that
  // must not reach the conversation.
  assert.match(CLI, /Network\.getCookies/);
  assert.match(CLI, /def watch\(/);
  assert.match(SKILL, /HttpOnly/);
  assert.match(SKILL, /What these return are secrets/);
});

test("the browser surface carries no provider concepts", () => {
  // The verb set is the expensive-to-undo decision: once skills call these,
  // changing them means rewriting every caller. Keeping it plain CDP is what
  // lets the same calls run against a hosted session or a browser driven
  // through an extension.
  for (const leak of ["anchor", "kernel", "browserbase", "live_view", "api-key", "API_KEY"]) {
    assert.doesNotMatch(CLI, new RegExp(leak, "i"), `browser.py must not mention ${leak}`);
  }
  // The pane verb takes the viewer URL as an argument rather than knowing how
  // to get one, which is the line that keeps it provider-free.
  assert.match(CLI, /sub\.add_parser\("pane"/);
  assert.match(CLI, /--provider/);
});

/* ------------------------------------- the built-in browser is gone */

test("no built-in browser, no local launch, no streamed pane", () => {
  // The interactive built-in browser and everything that served it are deleted:
  // the sandbox Chromium launch, the watchdog that owned it, and the streamed
  // pane it fed. Leaving any of it behind is a path back to the browser we
  // removed.
  assert.doesNotMatch(CLI, /built-in/, "no built-in browser framing remains");
  assert.doesNotMatch(CLI, /force[-_]built[-_]in/, "the --force-built-in escape hatch is gone");
  assert.doesNotMatch(CLI, /def spawn_chromium/, "nothing launches a local chromium");
  assert.doesNotMatch(CLI, /def watchdog/, "the watchdog is gone");
  assert.doesNotMatch(CLI, /def register\(/, "there is no streamed session to register");
  assert.doesNotMatch(CLI, /"viewer": "stream"/, "no stream viewer is producible");
  assert.doesNotMatch(CLI, /from[-_]pane/, "the from-pane input bypass is gone");
  assert.doesNotMatch(CLI, /sub\.add_parser\("frame"/, "the frame verb is gone");
  assert.doesNotMatch(CLI, /sub\.add_parser\("watch"/, "the watchdog verb is gone");
  assert.doesNotMatch(SKILL, /built-in/, "the skill no longer mentions a built-in browser");
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

/* ------------------------------------------------------- pane and control */

test("the agent is refused while a person holds the wheel", () => {
  // The calls are short, so a single check before each one is enough and there
  // is no long action to interrupt.
  const guard =
    /if a\.cmd in \("go", "click", "type", "type-secret", "key", "scroll"\)[\s\S]{0,500}/.exec(CLI)?.[0] ?? "";
  assert.match(guard, /human_control/);
  assert.match(guard, /Wait for them to hand it back/);
});

test("registering a pane persists the session so the wheel guard can query core", () => {
  const pane = /if a\.cmd == "pane":[\s\S]{0,2600}/.exec(CLI)?.[0] ?? "";
  assert.match(pane, /state\["sessionId"\] = a\.session/);
  assert.match(pane, /state\["registered"\] = True/);
});

test("an unknown control mode lets the agent carry on", () => {
  // A browser nobody registered still has to be drivable, and failing closed on
  // a lookup error would strand every task whenever MiniOmni hiccups.
  const cm = /def control_mode\([\s\S]{0,700}/.exec(CLI)?.[0] ?? "";
  assert.match(cm, /return "agent"/);
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

const typeSecretParser = (): string =>
  /pts = sub\.add_parser\("type-secret"[\s\S]*?pk = sub\.add_parser\("key"\)/.exec(CLI)?.[0] ?? "";
const typeSecretBlock = (): string => /elif a\.cmd == "type-secret":[\s\S]*?elif a\.cmd == "key":/.exec(CLI)?.[0] ?? "";

test("type-secret takes a keychain id and no literal-password argument", () => {
  // The whole point: the agent never handles the literal, so the verb must not
  // accept one as text.
  const parser = typeSecretParser();
  assert.ok(parser.length > 0, "the type-secret parser exists");
  assert.match(parser, /--keychain", required=True/);
  assert.doesNotMatch(parser, /add_argument\("text"/, "type-secret must not take a positional password");
  assert.doesNotMatch(parser, /--text-b64/, "and no base64 password argument either");
});

test("type-secret fetches the value from the fill endpoint and refuses an origin mismatch", () => {
  const block = typeSecretBlock();
  assert.match(block, /\/v1\/keychain\/fill/);
  assert.match(block, /"credentialId": a\.keychain/);
  assert.match(block, /same_origin\(here, origin\)/);
  assert.match(block, /Refusing to fill/);
  const checks = block.match(/on_pinned_site\(\)/g) ?? [];
  assert.ok(checks.length >= 2, "origin is re-checked after the field is focused, closing the fetch/type gap");
});

test("type-secret never prints or echoes the value — only an ok/fail line", () => {
  const block = typeSecretBlock();
  // The value only ever flows into the input pipeline, never to stdout.
  assert.match(block, /Input\.insertText", text=payload\["value"\]/);
  assert.doesNotMatch(block, /print\([^)]*payload\[/, "the value must never be printed");
  assert.doesNotMatch(block, /print\([^)]*value/, "no variable named value reaches a print");
});

test("the skill warns the value is observable and gates the fill on the person's yes", () => {
  assert.match(SKILL, /type-secret --keychain/);
  assert.match(SKILL, /best-effort, not model-blind/);
  assert.match(SKILL, /environment can observe the value/i);
  assert.match(SKILL, /proceed only after they say yes/i);
  // The everyone-else rule survives untouched.
  assert.match(SKILL, /never type or ask\s+for it yourself/i);
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

/* --------------------------------------------- opening, with nothing to launch */

test("open refuses when no browser is connected, rather than launching one", () => {
  // There is no browser of our own any more. With neither the extension relay
  // nor a --cdp endpoint, `open` must say what to connect and stop — never fall
  // through to a launch that no longer exists.
  const open = openBlock();
  assert.match(open, /No browser is connected for this person/);
  assert.doesNotMatch(open, /start_watchdog|spawn_chromium/, "and it does not try to launch anything");
});

test("a relay with no shared tab stops the turn rather than switching browsers", () => {
  const open = openBlock();
  assert.match(open, /via_extension/, "the extension path is distinguished from a hosted --cdp");
  assert.match(open, /not sharing a tab/);
  assert.match(open, /Do NOT quietly attach to a different browser/);
  assert.match(open, /clear_state\(\)/, "and it leaves no remote state behind to be reused");
});

test("the skill tells the agent to ask rather than switch browsers on its own", () => {
  assert.match(SKILL, /stop and ask/i);
  assert.match(SKILL, /Do \*\*not\*\* attach to a different browser on your own/);
});

test("a temp file per process, so concurrent writes cannot interleave", () => {
  assert.match(CLI, /STATE_FILE \+ f"\.\{os\.getpid\(\)\}\.tmp"/);
});

/* ---------------------------------------------- when a site refuses us */

test("a blocked site is recoverable, not just explained", () => {
  // Detecting a block and saying so is only half an answer. The same verbs
  // have to work against a hosted browser, or the fallback is advice rather
  // than a path.
  assert.match(SKILL, /open --cdp/);
  assert.match(SKILL, /the same verbs/i);
  assert.match(CLI, /po\.add_argument\("--cdp"/);
});

test("driving a remote browser is the same protocol, addressed differently", () => {
  // A remote endpoint speaks browser-level CDP, so commands must name their
  // page. That session id is the ONLY difference — if it grew into a second
  // code path the two would drift.
  assert.match(CLI, /def attach_remote/);
  assert.match(CLI, /Target\.attachToTarget/);
  assert.match(CLI, /flatten=True/);
  assert.match(CLI, /msg\["sessionId"\] = self\.session_id/);
});

test("wss is supported, because every hosted endpoint uses it", () => {
  // Found by pointing it at a real hosted browser: the client spoke only ws://
  // and the fallback failed at the first connection.
  assert.match(CLI, /u\.scheme not in \("ws", "wss"\)/);
  assert.match(CLI, /ssl\.create_default_context\(\)\.wrap_socket/);
  // Credentials often ride in the query string with no path at all.
  assert.match(CLI, /\(u\.path or "\/"\) \+ \(f"\?\{u\.query\}"/);
});

test("closing a browser we did not start does not claim to have stopped it", () => {
  // Otherwise someone believes it ended while it bills on somewhere else.
  assert.match(CLI, /running somewhere else/);
  assert.match(CLI, /bills until its own timeout/);
});

/* ------------------------------------------- found by deploying and using it */

test("a file is fetched rather than navigated to, which is what breaks the bridge", () => {
  assert.match(SKILL, /Never navigate to a file/);
  assert.match(SKILL, /download URL/);
  const dl = /if a\.cmd == "download":[\s\S]*?if a\.cmd in \("tabs", "tab"\):/.exec(CLI)?.[0] ?? "";
  assert.ok(dl.length > 0, "the verb exists");
  assert.match(dl, /Fetch\.enable/);
  assert.match(dl, /Fetch\.takeResponseBodyAsStream/);
  assert.match(dl, /IO\.read/);
  assert.match(dl, /Fetch\.failRequest/, "the browser must never turn it into a download");
  assert.match(dl, /Fetch\.disable/, "a pattern left armed hangs every matching request");
});

test("a sign-in wall is not saved as if it were the file", () => {
  const dl = /if a\.cmd == "download":[\s\S]*?if a\.cmd in \("tabs", "tab"\):/.exec(CLI)?.[0] ?? "";
  assert.match(dl, /text\/html/);
  assert.match(dl, /returned a web page, not a file/);
});

test("a tab the shared one opens is followed, and others can be picked", () => {
  assert.match(SKILL, /A new tab is not lost/);
  assert.match(CLI, /qm\.listTabs/);
  assert.match(CLI, /qm\.switchTab/);
});

test("a file with no findable URL is caught by clicking for it", () => {
  assert.match(SKILL, /Often there is no URL to find/);
  const dl = /if a\.cmd == "download":[\s\S]*?if a\.cmd in \("tabs", "tab"\):/.exec(CLI)?.[0] ?? "";
  assert.match(dl, /--click/);
  assert.match(dl, /Fetch\.continueRequest/, "traffic that is not the file must not be held up");
});

test("events are kept rather than dropped while waiting for a reply", () => {
  const call = /def call\(self, method[\s\S]{0,900}/.exec(CLI)?.[0] ?? "";
  assert.match(call, /self\.events\.append/, "an interception event routinely beats the reply over a relay");
  assert.doesNotMatch(call, /Events are not interesting/);
});

test("a file behind a link is fetched, never opened in the tab", () => {
  assert.match(SKILL, /opens in the browser/);
  assert.match(CLI, /def href_behind/);
  const dl = /if a\.cmd == "download":[\s\S]*?if a\.cmd in \("tabs", "tab"\):/.exec(CLI)?.[0] ?? "";
  assert.match(dl, /href_behind/, "a link's href beats clicking it");
});

test("a click made for a download does not wait for the page afterwards", () => {
  assert.match(CLI, /def click_without_waiting/);
  const dl = /if a\.cmd == "download":[\s\S]*?if a\.cmd in \("tabs", "tab"\):/.exec(CLI)?.[0] ?? "";
  assert.match(dl, /click_without_waiting/);
  assert.doesNotMatch(dl, /do_click\(/);
});

test("a document that is not a web page counts as a file", () => {
  const dl = /if a\.cmd == "download":[\s\S]*?if a\.cmd in \("tabs", "tab"\):/.exec(CLI)?.[0] ?? "";
  assert.match(dl, /resourceType/);
  assert.match(dl, /Document/);
});

test("a download that lands in a new tab says where it went", () => {
  const dl = /if a\.cmd == "download":[\s\S]*?if a\.cmd in \("tabs", "tab"\):/.exec(CLI)?.[0] ?? "";
  assert.match(dl, /new_tab_url/);
  assert.match(dl, /opened a new tab instead/);
  assert.match(CLI, /def new_tab_url/);
});

test("waiting for an interception cannot end in a socket traceback", () => {
  const wait = /def wait_event\([\s\S]{0,900}/.exec(CLI)?.[0] ?? "";
  assert.match(wait, /socket\.timeout|TimeoutError/);
});
