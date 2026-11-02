import type { OrbMode, OrbStatus } from "../protocol.ts";
import { OMNILOY_RGB, type PaletteRGB } from "./palettes.ts";

export const MOTION = {
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
};

export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function shapeLevel(level: number): number {
  const gated = Math.max(0, (level - 0.06) / 0.7);
  return Math.min(1, gated ** 0.85);
}

function baseScale(status: OrbStatus, inCall: boolean): number {
  if (status === "ending") return 0.92;
  return inCall ? 1 : 0.96;
}

export interface SignalInput {
  status: OrbStatus;
  mode: OrbMode;
  muted: boolean;
  input: number;
  output: number;
  hover: boolean;
  press: boolean;
  pointer: { x: number; y: number };
  reduced: boolean;
  dark: boolean;
}

export interface OrbFrame {
  time: number;
  dt: number;
  phase: number;
  rot: number;
  speed: number;
  scale: number;
  inSlow: number;
  outSlow: number;
  listen: number;
  think: number;
  speak: number;
  awake: number;
  muted: number;
  hover: number;
  bloom: number;
  ring: number;
  pointer: { x: number; y: number };
  colors: Readonly<PaletteRGB>;
  dark: boolean;
  calm: number;
}

export class OrbSignals {
  readonly frame: OrbFrame = {
    time: 0,
    dt: 0,
    phase: 7.3,
    rot: 0,
    speed: 0.05,
    scale: 0.94,
    inSlow: 0,
    outSlow: 0,
    listen: 0,
    think: 0,
    speak: 0,
    awake: 0,
    muted: 0,
    hover: 0,
    bloom: 0,
    ring: -1,
    pointer: { x: 0, y: 0 },
    colors: OMNILOY_RGB,
    dark: false,
    calm: 1,
  };
  private lastStatus: OrbStatus | null = null;
  private bloomUntil = -1;

  step(dt: number, s: SignalInput): OrbFrame {
    const f = this.frame;
    f.dt = dt;
    f.time += dt;
    f.dark = s.dark;
    f.calm = s.reduced ? 0.3 : 1;

    if (s.status === "connecting" && this.lastStatus !== null && this.lastStatus !== "connecting") {
      this.bloomUntil = f.time + 0.28;
      f.ring = 0;
    }
    this.lastStatus = s.status;
    const blooming = f.time < this.bloomUntil;
    f.bloom = approach(f.bloom, blooming ? 1 : 0, blooming ? 9 : 2.2, dt);
    if (f.ring >= 0) {
      f.ring += dt / MOTION.ringSeconds;
      if (f.ring > 1) f.ring = -1;
    }

    const tin = s.muted ? 0 : shapeLevel(s.input);
    const tout = shapeLevel(s.output);
    f.inSlow = approach(f.inSlow, tin, tin > f.inSlow ? MOTION.slowAttack : MOTION.slowRelease, dt);
    f.outSlow = approach(f.outSlow, tout, tout > f.outSlow ? MOTION.slowAttack : MOTION.slowRelease, dt);

    const connected = s.status === "connected";
    const inCall = connected || s.status === "connecting";
    f.listen = approach(f.listen, connected && s.mode === "listening" ? 1 : 0, MOTION.stateRate, dt);
    f.think = approach(
      f.think,
      s.status === "connecting" || (connected && s.mode === "thinking") ? 1 : 0,
      MOTION.stateRate,
      dt,
    );
    f.speak = approach(f.speak, connected && s.mode === "speaking" ? 1 : 0, MOTION.stateRate, dt);
    f.awake = approach(f.awake, inCall ? 1 : 0, 2, dt);
    f.muted = approach(f.muted, s.muted && inCall ? 1 : 0, MOTION.stateRate, dt);
    f.hover = approach(f.hover, s.hover ? 1 : 0, 6, dt);

    const easedOut = 1 - (1 - f.outSlow) * (1 - f.outSlow);
    const targetSpeed =
      (0.03 +
        f.awake * 0.015 +
        f.listen * (0.02 + f.inSlow * 0.04) +
        f.think * 0.03 +
        f.speak * (0.03 + easedOut * 0.1)) *
      (1 - 0.5 * f.muted);
    f.speed = approach(f.speed, targetSpeed, MOTION.speedRate, dt);
    f.phase += dt * f.speed * f.calm;
    f.rot += dt * MOTION.thinkRotation * f.think * f.calm;

    const breath = Math.sin((f.time / 8) * Math.PI * 2) * MOTION.breath * f.calm;
    const base = baseScale(s.status, inCall);
    const target = s.reduced
      ? base
      : base +
        breath +
        f.hover * MOTION.hoverScale -
        (s.press ? MOTION.pressScale : 0) +
        f.bloom * 0.03 +
        f.inSlow * f.listen * MOTION.scaleListen +
        f.outSlow * f.speak * MOTION.scaleSpeak;
    f.scale = approach(f.scale, target, s.press ? 14 : MOTION.scaleRate, dt);

    f.pointer.x = approach(f.pointer.x, s.reduced ? 0 : s.pointer.x, MOTION.pointerRate, dt);
    f.pointer.y = approach(f.pointer.y, s.reduced ? 0 : s.pointer.y, MOTION.pointerRate, dt);
    return f;
  }
}
