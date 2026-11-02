import { createProgram } from "./gl.ts";
import { pearlFragment } from "./pearl.glsl.ts";
import type { OrbFrame } from "./signals.ts";

export interface Surface {
  gl: WebGL2RenderingContext;
  triangle: WebGLVertexArrayObject;
  width: number;
  height: number;
  disc: number;
}

export interface Pearl {
  render(frame: OrbFrame, surface: Surface): void;
  dispose(): void;
}

export function createPearl(gl: WebGL2RenderingContext): Pearl {
  const p = createProgram(gl, pearlFragment);
  const u = (name: string) => p.uniform(name);
  return {
    render(f, s) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, s.width, s.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(p.program);
      gl.uniform2f(u("uRes"), s.width, s.height);
      gl.uniform1f(u("uDisc"), s.disc);
      gl.uniform1f(u("uScale"), f.scale);
      gl.uniform1f(u("uTime"), f.time);
      gl.uniform1f(u("uPhase"), f.phase);
      gl.uniform1f(u("uRot"), f.rot);
      gl.uniform1f(u("uIn"), f.inSlow);
      gl.uniform1f(u("uOut"), f.outSlow);
      gl.uniform1f(u("uListen"), f.listen);
      gl.uniform1f(u("uThink"), f.think);
      gl.uniform1f(u("uSpeak"), f.speak);
      gl.uniform1f(u("uWork"), f.work);
      gl.uniform1f(u("uOrbit"), f.orbit);
      gl.uniform1f(u("uSpin"), f.spin);
      gl.uniform3fv(u("uDeep"), f.colors.deep);
      gl.uniform3fv(u("uMid"), f.colors.mid);
      gl.uniform3fv(u("uLight"), f.colors.light);
      gl.uniform3fv(u("uHigh"), f.colors.high);
      gl.uniform3fv(u("uAccent"), f.colors.accent);
      gl.uniform1f(u("uDark"), f.dark ? 1 : 0);
      gl.uniform1f(u("uBloom"), f.bloom);
      gl.uniform1f(u("uRing"), f.ring);
      gl.uniform2f(u("uPointer"), f.pointer.x, f.pointer.y);
      gl.uniform1f(u("uHover"), f.hover);
      gl.uniform1f(u("uMuted"), f.muted);
      gl.bindVertexArray(s.triangle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteProgram(p.program);
    },
  };
}
