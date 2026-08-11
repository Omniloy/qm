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

const openBlock = (): string => /if a\.cmd == "open":[\s\S]*?if a\.cmd == "watch":/.exec(CLI)?.[0] ?? "";

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

test("the extension routes to the relay, not a provider doc or the local browser", () => {
  // The bug this guards: BROWSE_PROVIDER=extension fell through to the hosted
  // -provider branch (read a doc that does not exist) or to the local launch,
  // instead of attaching to the person's own Chrome over the relay.
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
  // lets the same calls run against a local Chromium, a hosted session, or a
  // browser driven through an extension.
  // Provider names, a provider's own field names, and key material. Core's
  // own field names are not on this list: browser.py already speaks core's
  // browser-session API, and `liveViewUrl` is what that API calls the viewer
  // it is handed — naming it says nothing about which provider produced it.
  for (const leak of ["anchor", "kernel", "browserbase", "live_view", "api-key", "API_KEY"]) {
    assert.doesNotMatch(CLI, new RegExp(leak, "i"), `browser.py must not mention ${leak}`);
  }
  // The pane verb takes the viewer URL as an argument rather than knowing how
  // to get one, which is the line that keeps it provider-free.
  assert.match(CLI, /sub\.add_parser\("pane"/);
  assert.match(CLI, /--provider/);
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
  // They asked to browse. If MiniOmni cannot be reached the picture is gone, but the
  // task is still doable, and refusing would be the wrong trade.
  assert.match(CLI, /never as "no browser"/);
  const open = /outcome, why = register\(state\)[\s\S]{0,1400}/.exec(CLI)?.[0] ?? "";
  assert.match(open, /Browsing still works/);
  // The distinction that matters: "no room" is obeyed, "cannot reach MiniOmni" is not.
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
  // a lookup error would strand every task whenever MiniOmni hiccups.
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
  const open = openBlock();
  const claimAt = open.indexOf("register(state)");
  const launchAt = open.indexOf("start_watchdog");
  assert.ok(claimAt > 0 && launchAt > 0, "both steps are in open");
  assert.ok(claimAt < launchAt, "the claim comes first");
  assert.match(open, /outcome == "full"/);
});

test("a relay with no shared tab stops the turn rather than switching browsers", () => {
  const open = openBlock();
  assert.match(open, /via_extension/, "the extension path is distinguished from a hosted --cdp");
  assert.match(open, /not sharing a tab/);
  assert.match(open, /Do NOT quietly switch to the built-in browser/);
  assert.match(open, /clear_state\(\)/, "and it leaves no remote state behind to be reused");
});

test("the skill tells the agent to ask rather than fall back on its own", () => {
  assert.match(SKILL, /stop and ask/i);
  assert.match(SKILL, /Do \*\*not\*\* fall back to the built-in browser on your own/);
});

test("forcing the built-in browser lets go of a browser somewhere else", () => {
  const open = openBlock();
  const forceAt = open.indexOf("a.force_built_in:");
  const reuseAt = open.indexOf("Reusing it");
  assert.ok(forceAt > 0 && reuseAt > 0, "both branches are in open");
  assert.ok(forceAt < reuseAt, "the stale remote record is dropped before the reuse check");
  assert.match(open, /billing until its own timeout/, "and a hosted browser we let go of is not left silent");
});

test("the browser is not closed the moment the answer is ready", () => {
  assert.match(SKILL, /Do not close it just because your answer is ready/);
  assert.match(SKILL, /reaped automatically once it has been idle/);
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
  const open = openBlock();
  assert.match(open, /with OpenLock\(\):/);
  // The loser must reuse rather than fail — it is what it would have done had
  // it arrived a moment later.
  assert.match(open, /already open[\s\S]{0,80}Reusing it/);
});

test("a lock from a container that no longer exists cannot wedge the profile", () => {
  // The worst bug of the build, and it only appears after a restart. Chromium
  // guards a profile with a symlink naming the host holding it — here
  // "21a7194ab74a-379", a container that had been destroyed. The profile lives
  // on a volume that outlives its container, so that lock was permanent:
  // chromium refused to start forever, dying instantly with an error nobody
  // saw, while the pane sat on "waiting for the browser".
  assert.match(CLI, /def clear_profile_lock/);
  const fn = /def clear_profile_lock\([\s\S]{0,1400}/.exec(CLI)?.[0] ?? "";
  assert.match(fn, /SingletonLock/);
  assert.match(fn, /SingletonSocket/);
  assert.match(fn, /SingletonCookie/);
  // Only when nothing is actually listening: a running browser's lock is real.
  assert.match(fn, /if alive\(DEBUG_PORT\):\s*\n\s*return/);
  assert.match(CLI, /clear_profile_lock\(\)/);
});

test("the frame follows the scroll, instead of photographing the page top", () => {
  // Reported from real use: "when I scrolled it turned into a white screen".
  // Page.captureScreenshot's clip is in PAGE coordinates, so clipping at the
  // document origin while the viewport sits further down captures an unpainted
  // region. Measured on a scrolled article: a 43KB screenshot became 2.7KB of
  // blank. It also silently broke clicking, since the picture no longer showed
  // the part of the page that input events were being sent to.
  const frame = /elif a\.cmd == "frame":[\s\S]{0,2000}/.exec(CLI)?.[0] ?? "";
  assert.match(frame, /sx: scrollX, sy: scrollY/);
  assert.match(frame, /"x": size\["sx"\], "y": size\["sy"\]/);
});

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
