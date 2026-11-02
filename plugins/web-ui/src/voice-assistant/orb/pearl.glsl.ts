import { simplexNoise3D } from "./noise.glsl.ts";

export const pearlFragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec2 uRes;
uniform float uDisc;
uniform float uScale;
uniform float uTime;
uniform float uPhase;
uniform float uRot;
uniform float uIn;
uniform float uOut;
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uLight;
uniform vec3 uHigh;
uniform vec3 uAccent;
uniform float uDark;
uniform float uBloom;
uniform float uRing;
uniform vec2 uPointer;
uniform float uHover;
uniform float uMuted;

${simplexNoise3D}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 2; i++) {
    sum += amp * snoise(p);
    p = p * 1.9 + 17.0;
    amp *= 0.24;
  }
  return sum;
}

vec3 ramp(float f) {
  vec3 c = uDeep;
  c = mix(c, uMid, smoothstep(0.0, 0.5, f));
  c = mix(c, uLight, smoothstep(0.3, 0.85, f));
  c = mix(c, uHigh, smoothstep(0.7, 1.05, f));
  return c;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float radius = uDisc * uScale;
  vec2 uv = p / radius;
  float r = length(uv);
  float aa = 3.0 / (uRes.x * radius);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, r);

  float z = sqrt(max(0.0, 1.0 - r * r));
  vec2 s = uv * (1.0 + 0.16 * (1.0 - z));
  float c = cos(uRot), sn = sin(uRot);
  s = mat2(c, -sn, sn, c) * s;

  s *= 1.0 + 0.18 * uIn * uListen * (1.0 - r);
  s *= 1.0 - 0.14 * uOut * uSpeak;

  float t = uPhase;
  vec2 q = vec2(snoise(vec3(s * 0.34, t)), snoise(vec3(s * 0.34 + vec2(4.1, 1.7), t * 0.9 + 2.0)));
  float warp = 0.5 + uOut * 0.18 + uIn * 0.1;
  float f = fbm(vec3(s * 0.68 + q * warp, t * 0.7 + 5.0));
  float x = f * (2.6 + uOut * 0.5);
  f = 0.5 + 0.5 * x / (1.0 + abs(x));

  vec3 col = ramp(f);

  float under = fbm(vec3(s * 0.8 + uv * (1.0 - z) * 0.25 - q * 0.2, t * 0.45 + 13.0));
  float ux = under * 1.4;
  col = mix(col, ramp(0.5 + 0.5 * ux / (1.0 + abs(ux)) - 0.1), 0.12);

  float sheen = snoise(vec3(s * 0.4 - q * 0.3, t * 0.5 + 9.0)) * 0.5 + 0.5;
  col = mix(col, uAccent, smoothstep(0.6, 0.95, sheen) * 0.42);
  col = mix(col, mix(col, uAccent, 0.5), smoothstep(0.62, 0.95, f) * 0.35);

  vec2 hc = vec2(0.07 * sin(t * 0.7), 0.1 + 0.05 * cos(t * 0.53)) + uPointer * 0.06;
  float heart = exp(-dot(uv - hc, uv - hc) * 4.5);
  col = mix(col, uHigh, heart * (0.12 + uSpeak * (0.12 + uOut * 0.6) + uThink * 0.06 + uBloom * 0.35));

  col = mix(col, uHigh, smoothstep(0.6, 1.0, r) * (0.1 + uIn * 0.45) * uListen);

  float sweep = fract(uTime / 2.4) * 3.4 - 1.7;
  float band = exp(-pow(dot(uv, vec2(0.8, 0.6)) - sweep, 2.0) * 5.0);
  col = mix(col, uHigh, band * 0.45 * uThink);
  float thinkLuma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(thinkLuma), 0.18 * uThink);

  col *= 0.8 + 0.2 * z;
  vec2 key = vec2(-0.4, 0.45) + uPointer * 0.16;
  col = mix(col, uHigh, 0.1 * (1.0 - smoothstep(0.0, 0.95, length(uv - key))));
  vec2 sp = vec2(-0.4, 0.48) + uPointer * 0.12;
  col = mix(col, uHigh, exp(-dot(uv - sp, uv - sp) * 22.0) * 0.2);

  float lit = max(0.0, dot(uv / max(r, 1e-4), vec2(-0.6, 0.8)));
  col = mix(col, uHigh, smoothstep(0.94, 0.995, r) * lit * mix(0.18, 0.1, uDark));

  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma), 0.4 * uMuted);

  float outside = max(r - 1.0, 0.0);
  float halo = exp(-outside * 6.5) * (1.0 - smoothstep(0.12, 0.32, outside))
             * (0.07 + uOut * 0.12 * uSpeak + uIn * 0.05 * uListen) * (1.0 + 0.6 * uHover) * (1.0 + 2.0 * uBloom) * (1.0 - disc);

  float ringR = 1.0 + max(uRing, 0.0) * 0.36;
  float ring = step(0.0, uRing) * pow(1.0 - clamp(uRing, 0.0, 1.0), 2.0) * exp(-pow((r - ringR) * 26.0, 2.0)) * 0.32 * (1.0 - disc);
  halo += ring;
  vec3 haloCol = mix(mix(uMid, uLight, 0.6), mix(uDeep, uMid, 0.7), uDark);

  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;

  outColor = vec4(col * disc + haloCol * halo, disc + halo);
}
`;
