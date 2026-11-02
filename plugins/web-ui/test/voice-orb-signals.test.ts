import assert from "node:assert/strict";
import test from "node:test";
import { OMNILOY_PALETTE, OMNILOY_RGB, hexToRgb } from "../src/voice-assistant/orb/palettes.ts";
import { MOTION, OrbSignals, type SignalInput, approach, shapeLevel } from "../src/voice-assistant/orb/signals.ts";
import { ORB_INPUTS_BY_STATE, type VoiceState } from "../src/voice-assistant/protocol.ts";

const DT = 1 / 60;

function input(over: Partial<SignalInput> = {}): SignalInput {
  return {
    status: "connected",
    mode: "idle",
    muted: false,
    working: false,
    input: 0,
    output: 0,
    hover: false,
    press: false,
    pointer: { x: 0, y: 0 },
    reduced: false,
    dark: false,
    ...over,
  };
}

function run(signals: OrbSignals, seconds: number, s: SignalInput) {
  for (let i = 0; i < Math.round(seconds / DT); i++) signals.step(DT, s);
  return signals.frame;
}

function forState(state: VoiceState, over: Partial<SignalInput> = {}): SignalInput {
  return input({ ...ORB_INPUTS_BY_STATE[state], ...over });
}

test("the motion budget keeps the design's constants", () => {
  assert.deepEqual(MOTION, {
    slowAttack: 8,
    slowRelease: 2.5,
    fastAttack: 30,
    fastRelease: 8,
    stateRate: 4,
    speedRate: 1.5,
    scaleRate: 6,
    paletteRate: 2,
    pointerRate: 3,
    breath: 0.008,
    hoverScale: 0.03,
    pressScale: 0.05,
    scaleListen: 0.015,
    scaleSpeak: 0.025,
    thinkRotation: 0.12,
    ringSeconds: 0.9,
    workOrbit: 1.8,
  });
});

test("the orb is painted only in Omniloy blues, as 0-1 RGB", () => {
  assert.deepEqual(OMNILOY_PALETTE, {
    deep: "#0568c4",
    mid: "#0783f0",
    light: "#b6ddff",
    high: "#f2f8ff",
    accent: "#8fb4ff",
  });
  assert.deepEqual(hexToRgb("#0783f0"), [7 / 255, 131 / 255, 240 / 255]);
  assert.deepEqual(new OrbSignals().frame.colors, OMNILOY_RGB);
});

test("approach is frame-rate independent", () => {
  let a = 0;
  for (let i = 0; i < 60; i++) a = approach(a, 1, 4, 1 / 60);
  let b = 0;
  for (let i = 0; i < 30; i++) b = approach(b, 1, 4, 1 / 30);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test("shapeLevel gates room noise and saturates loud speech", () => {
  assert.equal(shapeLevel(0.03), 0);
  assert.equal(shapeLevel(0.06), 0);
  assert.ok(shapeLevel(0.5) > 0.4 && shapeLevel(0.5) < 0.7);
  assert.equal(shapeLevel(5), 1);
});

test("state weights cross-fade over about 700 ms instead of snapping", () => {
  const signals = new OrbSignals();
  const s = forState("listening");
  signals.step(DT, s);
  assert.ok(signals.frame.listen < 0.1, "one frame only starts the fade");
  run(signals, 0.7, s);
  assert.ok(signals.frame.listen > 0.9 && signals.frame.listen < 1);
  run(signals, 1, forState("thinking"));
  assert.ok(signals.frame.think > 0.95);
  assert.ok(signals.frame.listen < 0.05);
});

test("each qm voice state drives the matching orb weight", () => {
  const weights = (state: VoiceState) => run(new OrbSignals(), 2, forState(state));
  assert.ok(weights("listening").listen > 0.99);
  assert.ok(weights("thinking").think > 0.99);
  assert.ok(weights("speaking").speak > 0.99);
  assert.ok(weights("arming").think > 0.99, "loading models reads as thinking");
  const sleeping = weights("sleeping");
  assert.ok(sleeping.listen < 0.01 && sleeping.think < 0.01 && sleeping.speak < 0.01);
  assert.ok(sleeping.awake > 0.98);
  assert.ok(weights("off").awake < 0.01);
});

test("arming fires one bloom and one opening ring", () => {
  const signals = new OrbSignals();
  run(signals, 0.5, forState("off"));
  assert.equal(signals.frame.ring, -1);
  signals.step(DT, forState("arming"));
  assert.ok(signals.frame.ring >= 0);
  run(signals, 0.2, forState("arming"));
  assert.ok(signals.frame.bloom > 0.7);
  run(signals, MOTION.ringSeconds, forState("arming"));
  assert.equal(signals.frame.ring, -1, "the ring runs once");
  run(signals, 3, forState("arming"));
  assert.ok(signals.frame.bloom < 0.01, "the bloom does not repeat while still arming");
});

test("muting drops the user's voice and drains the orb", () => {
  const signals = new OrbSignals();
  run(signals, 1, forState("listening", { input: 0.8 }));
  assert.ok(signals.frame.inSlow > 0.5);
  run(signals, 2, forState("listening", { input: 0.8, muted: true }));
  assert.ok(signals.frame.inSlow < 0.02);
  assert.ok(signals.frame.muted > 0.99);
});

test("the agent's voice speeds the flow and lifts the orb while speaking", () => {
  const quiet = run(new OrbSignals(), 2, forState("speaking"));
  const loud = run(new OrbSignals(), 2, forState("speaking", { output: 0.9 }));
  assert.ok(loud.outSlow > 0.8);
  assert.ok(loud.speed > quiet.speed + 0.05);
  assert.ok(loud.scale > quiet.scale);
});

test("the field rotates only while thinking", () => {
  const listening = run(new OrbSignals(), 2, forState("listening"));
  assert.ok(listening.rot < 0.02);
  const thinking = run(new OrbSignals(), 4, forState("thinking"));
  assert.ok(thinking.rot > 0.3);
});

test("reduced motion holds scale at base, zeroes the lean and calms the flow", () => {
  const signals = new OrbSignals();
  const s = forState("speaking", { reduced: true, output: 0.9, hover: true, pointer: { x: 1, y: 1 } });
  run(signals, 3, s);
  assert.ok(Math.abs(signals.frame.scale - 1) < 1e-3);
  assert.ok(Math.abs(signals.frame.pointer.x) < 1e-6 && Math.abs(signals.frame.pointer.y) < 1e-6);
  assert.equal(signals.frame.calm, 0.3);
});

test("hover lifts and press dips the orb", () => {
  const rest = run(new OrbSignals(), 2, forState("sleeping")).scale;
  const hovered = run(new OrbSignals(), 2, forState("sleeping", { hover: true })).scale;
  const pressed = run(new OrbSignals(), 2, forState("sleeping", { hover: true, press: true })).scale;
  assert.ok(hovered > rest + 0.02);
  assert.ok(pressed < hovered - 0.04);
});

test("the dark flag is passed straight through to the frame", () => {
  const signals = new OrbSignals();
  signals.step(DT, input({ dark: true }));
  assert.equal(signals.frame.dark, true);
  signals.step(DT, input({ dark: false }));
  assert.equal(signals.frame.dark, false);
});

test("working while resting circles an arc around the orb, gives way to speech and stands still under reduced motion", () => {
  const signals = new OrbSignals();
  const resting = run(signals, 2, forState("sleeping", { working: true }));
  assert.ok(resting.work > 0.95);
  const orbit = resting.orbit;
  run(signals, 0.5, forState("listening", { working: true }));
  assert.ok(signals.frame.work > 0.95, "listening keeps the working arc");
  assert.notEqual(signals.frame.orbit, orbit, "the arc travels around the rim");
  run(signals, 2, forState("speaking", { working: true }));
  assert.ok(signals.frame.work < 0.05, "speech owns the orb while it plays");
  run(signals, 2, forState("sleeping", { working: true, reduced: true }));
  assert.ok(signals.frame.work > 0.95 && signals.frame.spin < 0.05);
  const still = signals.frame.orbit;
  run(signals, 1, forState("sleeping", { working: true, reduced: true }));
  assert.ok(Math.abs(signals.frame.orbit - still) < 0.01, "reduced motion shows a steady ring, not a moving arc");
  run(signals, 2, forState("sleeping"));
  assert.ok(signals.frame.work < 0.05);
});
