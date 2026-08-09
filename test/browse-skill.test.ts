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
  // just signed in to create. Asking and reaping both go through one function,
  // so a person closing a browser and a watchdog reaping one behave the same.
  const verb = /if a\.cmd == "close":[\s\S]{0,1600}/.exec(CLI)?.[0] ?? "";
  assert.match(verb, /close_browser\(state/);
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

/* ------------------------------------------------------- pane and control */

test("a local browser registers as streamed, carrying no URL", () => {
  // Core refuses a liveViewUrl on a streamed viewer precisely so a CDP URL
  // cannot be pasted where a viewer URL belongs. Sending one here would turn
  // that protection into a failed registration and a missing pane.
  const reg = /def register\([\s\S]{0,1200}/.exec(CLI)?.[0] ?? "";
  assert.match(reg, /"viewer": "stream"/);
  assert.doesNotMatch(reg, /liveViewUrl/, "a streamed browser has no viewer URL to send");
  assert.match(reg, /"provider": "local"/);
});

test("losing the pane never costs the person the browser", () => {
  // They asked to browse. If QM cannot be reached the picture is gone, but the
  // task is still doable, and refusing would be the wrong trade.
  assert.match(CLI, /never as "no browser"/);
  const open = /outcome, why = register\(state\)[\s\S]{0,1400}/.exec(CLI)?.[0] ?? "";
  assert.match(open, /Browsing still works/);
  // The distinction that matters: "no room" is obeyed, "cannot reach QM" is not.
  assert.match(open, /outcome == "full"/);
  assert.match(open, /outcome == "ok"/);
});

test("the agent is refused while a person holds the wheel", () => {
  // Replaces the old parking loop: the calls are short, so a single check
  // before each one is enough and there is no long action to interrupt.
  const guard = /if a\.cmd in \("go", "click", "type", "key", "scroll"\)[\s\S]{0,500}/.exec(CLI)?.[0] ?? "";
  assert.match(guard, /not a\.from_pane/);
  assert.match(guard, /human_control/);
  assert.match(guard, /Wait for them to hand it back/);
});

test("input relayed from the pane is not blocked by that check", () => {
  // The person IS the wheel; refusing their own click would deadlock takeover.
  assert.match(CLI, /--from-pane/);
  assert.match(CLI, /they ARE the wheel/);
});

test("an unknown control mode lets the agent carry on", () => {
  // A browser nobody registered still has to be drivable, and failing closed on
  // a lookup error would strand every task whenever QM hiccups.
  const cm = /def control_mode\([\s\S]{0,700}/.exec(CLI)?.[0] ?? "";
  assert.match(cm, /return "agent"/);
});

test("a frame carries the viewport size, so a click lands where it was aimed", () => {
  // The pane scales the image to fit. Without the true viewport size it cannot
  // map a click back to page coordinates, and every click misses.
  const frame = /elif a\.cmd == "frame":[\s\S]{0,1800}/.exec(CLI)?.[0] ?? "";
  assert.match(frame, /"w": size\["w"\]/);
  assert.match(frame, /"h": size\["h"\]/);
  assert.match(frame, /clip=/, "downscaled on the way out rather than in the pane");
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

/* ------------------------------------------------ closing what nobody wants */

test("the browser is claimed before it is started", () => {
  // A browser costs about 1.25 GB. Registering first means a refusal arrives
  // while there is still nothing to throw away.
  const open = /if a\.cmd == "open":[\s\S]{0,2600}/.exec(CLI)?.[0] ?? "";
  const claimAt = open.indexOf("register(state)");
  const launchAt = open.indexOf("start_watchdog");
  assert.ok(claimAt > 0 && launchAt > 0, "both steps are in open");
  assert.ok(claimAt < launchAt, "the claim comes first");
  assert.match(open, /outcome == "full"/);
});

test("a refusal to open is passed on as news, not as a failure", () => {
  assert.match(CLI, /Nothing is broken and nothing is lost/);
});

test("an idle browser is closed gracefully, and killed only if it refuses", () => {
  // Measured: a hard kill discards the cookies chromium has not yet flushed,
  // which is exactly the sign-in someone just completed.
  const close = /def close_browser\([\s\S]{0,1400}/.exec(CLI)?.[0] ?? "";
  const graceAt = close.indexOf("Browser.close");
  const killAt = close.indexOf("pkill");
  assert.ok(graceAt > 0 && killAt > 0);
  assert.ok(graceAt < killAt, "ask first");
  assert.match(close, /deliberately last/);
});

test("the watchdog owns the browser rather than orphaning it", () => {
  // Measured: chromium orphaned to PID 1 leaves ~14 dead process entries per
  // session, because PID 1 here is the exec daemon and reaps nobody. Owning
  // the tree took that to zero across three open/reap cycles.
  const spawn = /def spawn_chromium\([\s\S]{0,900}/.exec(CLI)?.[0] ?? "";
  assert.doesNotMatch(spawn, /start_new_session=True/, "chromium stays a child of the watchdog");
  assert.match(CLI, /PR_SET_CHILD_SUBREAPER/);
  assert.match(CLI, /def reap_orphans/);
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

test("two writers share the state file without erasing each other", () => {
  // `open` records the session it claimed; the watchdog records the port once
  // chromium is listening. They race. A plain write means whoever finishes
  // second wins — which is how the port went missing and every later call
  // reported no browser at all.
  assert.match(CLI, /def merge_state/);
  const merge = /def merge_state\([\s\S]{0,700}/.exec(CLI)?.[0] ?? "";
  assert.match(merge, /state = read_state\(\) or \{\}/);
  assert.match(merge, /state\.update\(fields\)/);
  // touch() runs on every verb, so it is the most frequent clobberer.
  const touch = /def touch\([\s\S]{0,500}/.exec(CLI)?.[0] ?? "";
  assert.match(touch, /merge_state\(/);
});

test("a fresh browser is never idle before anyone has used it", () => {
  // Observed on the deployed stack: a stale lastUsedAt from a previous session
  // made the watchdog reap a brand-new browser within seconds, and the pane sat
  // on "waiting for the browser" forever while chromium was still running.
  assert.match(
    CLI,
    /last = max\(state\.get\("lastUsedAt", 0\), started\)/,
    "idleness is measured from the later of last-use and start",
  );
  assert.match(CLI, /started = time\.time\(\)/);
});

test("a temp file per process, so concurrent writes cannot interleave", () => {
  assert.match(CLI, /STATE_FILE \+ f"\.\{os\.getpid\(\)\}\.tmp"/);
});

test("two turns opening at once do not each start a browser", () => {
  // Reproduced on the deployed stack: both saw an empty state file, both
  // launched a watchdog, and when one decided its browser was idle it closed
  // the port the other was still using. The second turn's browser died under
  // it while every call reported success.
  assert.match(CLI, /class OpenLock/);
  assert.match(CLI, /fcntl\.flock\(self\.fd, fcntl\.LOCK_EX\)/);
  const open = /if a\.cmd == "open":[\s\S]{0,2800}/.exec(CLI)?.[0] ?? "";
  assert.match(open, /with OpenLock\(\):/);
  // The loser must reuse rather than fail — it is what it would have done had
  // it arrived a moment later.
  assert.match(open, /already open[\s\S]{0,80}Reusing it/);
});
