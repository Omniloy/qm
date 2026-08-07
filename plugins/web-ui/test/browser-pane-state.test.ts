import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paneVisible,
  paneStatus,
  paneActions,
  primaryAction,
  timeLeft,
  composerNote,
  type LiveSession,
} from "../src/browser-pane-state.ts";

const NOW = 1_800_000_000_000;
const THREAD = "dm:ada:t1";

const s = (over: Partial<LiveSession> = {}): LiveSession => ({
  provider: "anchor",
  sessionId: "s1",
  threadRef: THREAD,
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
