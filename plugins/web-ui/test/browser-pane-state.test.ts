import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  endedNote,
  paneVisible,
  paneStatus,
  paneActions,
  primaryAction,
  timeLeft,
  composerNote,
  frameInterval,
  toPageCoords,
  type LiveSession,
  dropStaleFrame,
} from "../src/browser-pane-state.ts";

const NOW = 1_800_000_000_000;
const THREAD = "dm:ada:t1";

const s = (over: Partial<LiveSession> = {}): LiveSession => ({
  provider: "anchor",
  sessionId: "s1",
  threadRef: THREAD,
  viewer: "iframe",
  liveViewUrl: "https://live.anchorbrowser.io/inspector.html?sessionId=s1",
  controlMode: "agent",
  expiresAt: NOW + 20 * 60_000,
  ...over,
});

test("a browser shows only in the conversation that opened it", () => {
  // A person has one browser. Bolting a pane onto every other conversation
  // would be noise, and would imply each chat had its own.
  assert.equal(paneVisible(s(), THREAD, NOW), true);
  assert.equal(paneVisible(s(), "dm:ada:other", NOW), false);
  assert.equal(paneVisible(null, THREAD, NOW), false);
  assert.equal(paneVisible(s(), null, NOW), false);
});

test("an expired browser shows nothing rather than a dead frame", () => {
  assert.equal(paneVisible(s({ expiresAt: NOW - 1 }), THREAD, NOW), false);
});

test("the status says who is driving, and human control is the loud one", () => {
  assert.deepEqual(paneStatus(s()), { label: "Agent working", human: false });
  assert.deepEqual(paneStatus(s({ controlMode: "human_control" })), { label: "You have control", human: true });
});

test("the inline button is always the opposite of the current state", () => {
  // One button, one meaning. Offering both at once is how people click the
  // wrong one.
  assert.equal(primaryAction(s()).id, "take");
  assert.equal(primaryAction(s()).label, "Take control");
  assert.equal(primaryAction(s({ controlMode: "human_control" })).id, "release");
  assert.equal(primaryAction(s({ controlMode: "human_control" })).label, "Give back to agent");
});

test("time left appears only when it is nearly up", () => {
  // A countdown running for the whole session reads as a threat rather than
  // information.
  assert.equal(timeLeft(s(), NOW), null);
  assert.equal(timeLeft(s({ expiresAt: NOW + 4 * 60_000 }), NOW), "4 min left");
  assert.equal(timeLeft(s({ expiresAt: NOW - 1 }), NOW), "ending");
});

test("minimize sits far from end session, and end session is the destructive one", () => {
  const ids = paneActions(s()).map((a) => a.id);
  assert.deepEqual(ids, ["minimize", "open", "release", "end"]);
  const end = paneActions(s()).find((a) => a.id === "end");
  assert.equal(end?.danger, true, "ending loses whatever is half-finished on screen");
  assert.equal(paneActions(s()).find((a) => a.id === "minimize")?.danger, undefined);
});

test("giving control back is offered only when someone has it", () => {
  const whenAgent = paneActions(s()).find((a) => a.id === "release");
  assert.equal(whenAgent?.disabled, true);
  assert.ok(whenAgent?.reason);
  assert.equal(paneActions(s({ controlMode: "human_control" })).find((a) => a.id === "release")?.disabled, false);
});

test("the composer says the agent is parked, so a typed follow-up is not swallowed", () => {
  assert.equal(composerNote(s()), null);
  assert.match(composerNote(s({ controlMode: "human_control" })) ?? "", /paused/);
  assert.equal(composerNote(null), null);
});

test("the live view is sized to the browser's own shape, not the chat's width", () => {
  // Seen on the deployed pane: a full-width frame with a fixed height is about
  // 3:1, so a 16:9 picture letterboxes into the middle and most of the box is
  // dead black. A big pane showing a small browser reads as broken.
  const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  const rule = /\.browser-pane-view\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(rule, /aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(rule, /margin-inline:\s*auto/, "and it stays centred when the chat is wider");
});

test("a browser that goes away says why it went", () => {
  // The first time one died mid-task the pane simply vanished, and the person
  // watching concluded the feature was broken. Three reasons, three sentences.
  assert.match(endedNote("expired"), /timed out/i);
  assert.match(endedNote("lost"), /stopped/i);
  assert.match(endedNote("ended"), /closed/i);
  // Each one reassures about the thing people actually worry about losing.
  assert.match(endedNote("expired"), /sign-ins were saved/);
  assert.match(endedNote("ended"), /sign-ins were saved/);
  // Except the crash case, where promising that would be a guess.
  assert.doesNotMatch(endedNote("lost"), /saved/);
});

/* --------------------------------------------------- a browser MiniOmni streams */

test("a click on the picture maps back to the page it came from", () => {
  // Two scalings sit between a person's click and the page: the frame is
  // downscaled to save bandwidth, then laid out at whatever width the pane
  // happens to be. Getting this wrong does not look broken — it looks like the
  // browser ignoring you, or clicking something you did not aim at.
  const viewport = { w: 1280, h: 800 };
  assert.deepEqual(toPageCoords({ x: 0, y: 0 }, { width: 640, height: 400 }, viewport), { x: 0, y: 0 });
  assert.deepEqual(toPageCoords({ x: 640, y: 400 }, { width: 640, height: 400 }, viewport), { x: 1280, y: 800 });
  // The interesting case: half-size render, click in the middle.
  assert.deepEqual(toPageCoords({ x: 320, y: 200 }, { width: 640, height: 400 }, viewport), { x: 640, y: 400 });
});

test("a click is dropped rather than guessed when nothing has been measured", () => {
  // A zero-sized element means the pane has not laid out yet. Dividing by it
  // would send a click to NaN, and CDP would put it at the origin.
  const viewport = { w: 1280, h: 800 };
  assert.equal(toPageCoords({ x: 5, y: 5 }, { width: 0, height: 400 }, viewport), null);
  assert.equal(toPageCoords({ x: 5, y: 5 }, { width: 640, height: 0 }, viewport), null);
  assert.equal(toPageCoords({ x: 5, y: 5 }, { width: 640, height: 400 }, { w: 0, h: 800 }), null);
});

test("frames come faster once a person is steering by them", () => {
  // While the agent drives, the picture is something to glance at. Once someone
  // has the wheel, latency is the whole experience.
  assert.ok(frameInterval(s({ controlMode: "human_control" })) < frameInterval(s({ controlMode: "agent" })));
  // Not faster than a frame takes to produce (~145ms), or requests just queue.
  assert.ok(frameInterval(s({ controlMode: "human_control" })) >= 150);
});

test("a streamed browser carries no URL for the pane to embed", () => {
  // The point of the streamed viewer: there is no bearer material in the pane
  // at all, so nothing here works for whoever finds it.
  const streamed = s({ provider: "local", viewer: "stream", liveViewUrl: undefined });
  assert.equal(streamed.liveViewUrl, undefined);
  assert.equal(paneVisible(streamed, THREAD, NOW), true, "and it still renders");
});

test("a browser with no URL does not offer to open one", () => {
  // Reported from real use: "Open in a new tab" on a streamed browser opened a
  // blank tab, because there is no viewer URL to open — MiniOmni streams the frames
  // instead. An action that cannot work reads as broken, so it is not offered.
  const streamed = s({ provider: "local", viewer: "stream", liveViewUrl: undefined });
  assert.equal(
    paneActions(streamed).find((a) => a.id === "open"),
    undefined,
  );
  // A vendor's viewer still has one, and still offers it.
  assert.ok(paneActions(s()).find((a) => a.id === "open"));
  // The rest of the menu is unchanged either way.
  assert.deepEqual(
    paneActions(streamed).map((a) => a.id),
    ["minimize", "release", "end"],
  );
});

test("a browser that simply ended keeps its last frame on screen", () => {
  assert.equal(
    dropStaleFrame("abc", null),
    false,
    "a short task is over before anyone can look; the last frame is the only record",
  );
});
