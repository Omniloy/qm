import { MEL_BINS, powerSpectrum, slaneyFilterbank } from "./mel.ts";

const N_FFT = 512;
const WINDOW = 400;
const HOP = 160;
const PREEMPHASIS = Math.fround(0.97);
const LOG_GUARD = 2 ** -24;
const STD_EPSILON = 1e-5;
const BINS = N_FFT / 2 + 1;
const WINDOW_OFFSET = (N_FFT - WINDOW) / 2;

let shared: { filters: Float32Array; window: Float64Array; spectrum: ReturnType<typeof powerSpectrum> } | null = null;

function tables(): NonNullable<typeof shared> {
  shared ??= {
    filters: slaneyFilterbank(N_FFT),
    window: Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1))),
    spectrum: powerSpectrum(N_FFT),
  };
  return shared;
}

function preemphasize(audio: Float32Array): Float32Array {
  const out = new Float32Array(audio.length);
  out[0] = audio[0];
  for (let i = 1; i < audio.length; i++) out[i] = audio[i] - Math.fround(PREEMPHASIS * audio[i - 1]);
  return out;
}

export function nemoLogMel(audio: Float32Array): { data: Float32Array; frames: number } {
  const frames = Math.floor(audio.length / HOP);
  if (frames < 2) return { data: new Float32Array(0), frames: 0 };
  const { filters, window, spectrum } = tables();
  const signal = preemphasize(audio);
  const data = new Float32Array(frames * MEL_BINS);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  const sum = new Float64Array(MEL_BINS);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - N_FFT / 2 + WINDOW_OFFSET;
    for (let i = 0; i < WINDOW; i++) {
      const at = start + i;
      frame[WINDOW_OFFSET + i] = at >= 0 && at < signal.length ? signal[at] * window[i] : 0;
    }
    spectrum(frame, power);
    for (let m = 0; m < MEL_BINS; m++) {
      let energy = 0;
      const row = m * BINS;
      for (let k = 0; k < BINS; k++) energy += filters[row + k] * power[k];
      data[f * MEL_BINS + m] = Math.log(energy + LOG_GUARD);
      sum[m] += data[f * MEL_BINS + m];
    }
  }
  for (let m = 0; m < MEL_BINS; m++) {
    const mean = sum[m] / frames;
    let squares = 0;
    for (let f = 0; f < frames; f++) squares += (data[f * MEL_BINS + m] - mean) ** 2;
    const scale = 1 / (Math.sqrt(squares / (frames - 1)) + STD_EPSILON);
    for (let f = 0; f < frames; f++) data[f * MEL_BINS + m] = (data[f * MEL_BINS + m] - mean) * scale;
  }
  return { data, frames };
}
