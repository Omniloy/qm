import type { LevelBus, OrbMode, OrbStatus } from "../protocol.ts";
import { createFullscreenTriangle } from "./gl.ts";
import { createPearl, type Pearl, type Surface } from "./pearl.ts";
import { OrbSignals } from "./signals.ts";

const CANVAS_TO_DISC = 1.5;

export interface OrbRead {
  status: OrbStatus;
  mode: OrbMode;
  muted: boolean;
  hover: boolean;
  press: boolean;
  dark: boolean;
}

export interface OrbRenderer {
  dispose(): void;
}

export function createOrbRenderer(
  canvas: HTMLCanvasElement,
  read: () => OrbRead,
  levels: Pick<LevelBus, "read">,
): OrbRenderer {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) throw new Error("WebGL2 unavailable");

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const signals = new OrbSignals();
  const lean = { x: 0, y: 0 };
  const surface: Surface = {
    gl,
    triangle: createFullscreenTriangle(gl),
    width: 1,
    height: 1,
    disc: 1 / CANVAS_TO_DISC,
  };
  let pearl: Pearl | null = createPearl(gl);

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = surface.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = surface.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  let dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onDpr = () => {
    resize();
    dprQuery.removeEventListener("change", onDpr);
    dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDpr);
  };
  dprQuery.addEventListener("change", onDpr);
  resize();

  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const radius = r.width / (2 * CANVAS_TO_DISC);
    if (radius <= 0) return;
    const x = (e.clientX - (r.left + r.width / 2)) / (radius * 3);
    const y = -(e.clientY - (r.top + r.height / 2)) / (radius * 3);
    const k = Math.min(1, 1 / Math.max(Math.hypot(x, y), 1e-6));
    lean.x = x * k;
    lean.y = y * k;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });

  let lost = false;
  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    pearl = null;
  };
  const onRestored = () => {
    try {
      surface.triangle = createFullscreenTriangle(gl);
      pearl = createPearl(gl);
      lost = false;
    } catch {
      pearl = null;
    }
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  let raf = 0;
  let last = performance.now();
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(Math.max(now - last, 0) / 1000, 1 / 20);
    last = now;
    if (lost || !pearl) return;
    const state = read();
    const f = signals.step(dt, {
      status: state.status,
      mode: state.mode,
      muted: state.muted,
      input: levels.read("input"),
      output: levels.read("output"),
      hover: state.hover,
      press: state.press,
      pointer: lean,
      reduced: reduced.matches,
      dark: state.dark,
    });
    pearl.render(f, surface);
  };
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      pearl?.dispose();
      pearl = null;
      observer.disconnect();
      dprQuery.removeEventListener("change", onDpr);
      window.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
