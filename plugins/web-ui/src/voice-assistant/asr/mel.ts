import { SPEECH_SAMPLE_RATE } from "../protocol.ts";

export const MEL_BINS = 128;
const MEL_N_FFT = 400;
const MEL_HOP = 160;

const FREQ_BINS = MEL_N_FFT / 2 + 1;
const MEL_FMAX = 8_000;
const LOG_FLOOR = 1e-10;
const DYNAMIC_RANGE = 8;

function hzToMel(hz: number): number {
  return hz < 1_000 ? (3 * hz) / 200 : 15 + Math.log(hz / 1_000) / (Math.log(6.4) / 27);
}

function melToHz(mel: number): number {
  return mel < 15 ? (200 * mel) / 3 : 1_000 * Math.exp((Math.log(6.4) / 27) * (mel - 15));
}

export function slaneyFilterbank(nFft = MEL_N_FFT): Float32Array {
  const bins = nFft / 2 + 1;
  const filters = new Float32Array(MEL_BINS * bins);
  const top = hzToMel(MEL_FMAX);
  const edges = Array.from({ length: MEL_BINS + 2 }, (_, i) => melToHz((top * i) / (MEL_BINS + 1)));
  for (let m = 0; m < MEL_BINS; m++) {
    const [left, center, right] = [edges[m], edges[m + 1], edges[m + 2]];
    const norm = 2 / (right - left);
    for (let k = 0; k < bins; k++) {
      const hz = (k * SPEECH_SAMPLE_RATE) / nFft;
      const weight = Math.min((hz - left) / (center - left), (right - hz) / (right - center));
      if (weight > 0) filters[m * bins + k] = weight * norm;
    }
  }
  return filters;
}

function factorize(n: number): number[] {
  const factors: number[] = [];
  let rest = n;
  for (let p = 2; rest > 1; p++) {
    while (rest % p === 0) {
      factors.push(p);
      rest /= p;
    }
  }
  return factors;
}

interface FftPlan {
  factors: number[];
  cos: Float64Array;
  sin: Float64Array;
  scratchRe: Float64Array;
  scratchIm: Float64Array;
}

function fftPlan(n: number): FftPlan {
  const factors = factorize(n);
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = -Math.sin((2 * Math.PI * k) / n);
  }
  const widest = Math.max(...factors);
  return { factors, cos, sin, scratchRe: new Float64Array(widest), scratchIm: new Float64Array(widest) };
}

function fft(
  plan: FftPlan,
  src: Float64Array,
  srcOffset: number,
  stride: number,
  outRe: Float64Array,
  outIm: Float64Array,
  outOffset: number,
  n: number,
  depth: number,
): void {
  if (n === 1) {
    outRe[outOffset] = src[srcOffset];
    outIm[outOffset] = 0;
    return;
  }
  const radix = plan.factors[depth];
  const span = n / radix;
  for (let q = 0; q < radix; q++) {
    fft(plan, src, srcOffset + q * stride, stride * radix, outRe, outIm, outOffset + q * span, span, depth + 1);
  }
  const size = plan.cos.length;
  const twiddleStep = size / n;
  const { scratchRe, scratchIm } = plan;
  for (let k = 0; k < span; k++) {
    for (let q = 0; q < radix; q++) {
      const at = outOffset + q * span + k;
      const t = (q * k * twiddleStep) % size;
      scratchRe[q] = outRe[at] * plan.cos[t] - outIm[at] * plan.sin[t];
      scratchIm[q] = outRe[at] * plan.sin[t] + outIm[at] * plan.cos[t];
    }
    for (let s = 0; s < radix; s++) {
      let re = 0;
      let im = 0;
      for (let q = 0; q < radix; q++) {
        const t = (((q * s) % radix) * size) / radix;
        re += scratchRe[q] * plan.cos[t] - scratchIm[q] * plan.sin[t];
        im += scratchRe[q] * plan.sin[t] + scratchIm[q] * plan.cos[t];
      }
      outRe[outOffset + s * span + k] = re;
      outIm[outOffset + s * span + k] = im;
    }
  }
}

export function powerSpectrum(nFft: number): (frame: Float64Array, power: Float64Array) => void {
  const plan = fftPlan(nFft);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  return (frame, power) => {
    fft(plan, frame, 0, 1, re, im, 0, nFft, 0);
    for (let k = 0; k < power.length; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  };
}

function reflectIndex(i: number, length: number): number {
  if (length === 1) return 0;
  const period = 2 * (length - 1);
  const folded = ((i % period) + period) % period;
  return folded < length ? folded : period - folded;
}

let shared: { filters: Float32Array; window: Float64Array; spectrum: ReturnType<typeof powerSpectrum> } | null = null;

function tables(): NonNullable<typeof shared> {
  shared ??= {
    filters: slaneyFilterbank(),
    window: Float64Array.from({ length: MEL_N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / MEL_N_FFT)),
    spectrum: powerSpectrum(MEL_N_FFT),
  };
  return shared;
}

export function logMel(audio: Float32Array): { data: Float32Array; frames: number } {
  const frames = Math.floor(audio.length / MEL_HOP);
  const data = new Float32Array(MEL_BINS * frames);
  if (frames === 0) return { data, frames };
  const { filters, window, spectrum } = tables();
  const pad = MEL_N_FFT / 2;
  const frame = new Float64Array(MEL_N_FFT);
  const power = new Float64Array(FREQ_BINS);
  let peak = -Infinity;
  for (let f = 0; f < frames; f++) {
    const start = f * MEL_HOP - pad;
    for (let i = 0; i < MEL_N_FFT; i++) frame[i] = audio[reflectIndex(start + i, audio.length)] * window[i];
    spectrum(frame, power);
    for (let m = 0; m < MEL_BINS; m++) {
      let energy = 0;
      const row = m * FREQ_BINS;
      for (let k = 0; k < FREQ_BINS; k++) energy += filters[row + k] * power[k];
      const value = Math.log10(Math.max(energy, LOG_FLOOR));
      data[m * frames + f] = value;
      if (value > peak) peak = value;
    }
  }
  const floor = peak - DYNAMIC_RANGE;
  for (let i = 0; i < data.length; i++) data[i] = (Math.max(data[i], floor) + 4) / 4;
  return { data, frames };
}
