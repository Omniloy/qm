import type { LevelBus, LevelChannel, LevelSource } from "../protocol.ts";

const VOICE_BAND_LOW_HZ = 100;
const VOICE_BAND_HIGH_HZ = 8000;

export function voiceLevel(bins: Uint8Array, sampleRate: number, fftSize: number): number {
  if (bins.length === 0 || !(sampleRate > 0) || !(fftSize > 0)) return 0;
  const hzPerBin = sampleRate / fftSize;
  const from = Math.max(0, Math.round(VOICE_BAND_LOW_HZ / hzPerBin));
  const to = Math.min(bins.length - 1, Math.round(VOICE_BAND_HIGH_HZ / hzPerBin));
  if (to < from) return 0;
  let sum = 0;
  for (let i = from; i <= to; i++) sum += bins[i];
  const mean = sum / ((to - from + 1) * 255);
  return Math.min(1, Math.sqrt(mean) * 1.8);
}

export function createLevelBus(): LevelBus {
  const sources = new Map<LevelChannel, LevelSource>();
  return {
    read(channel) {
      const source = sources.get(channel);
      if (!source) return 0;
      const value = source.level();
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    },
    attach(channel, source) {
      if (source) sources.set(channel, source);
      else sources.delete(channel);
    },
  };
}

export const levelBus: LevelBus = createLevelBus();

export function analyserLevel(analyser: AnalyserNode): LevelSource {
  const bins = new Uint8Array(analyser.frequencyBinCount);
  return {
    level() {
      analyser.getByteFrequencyData(bins);
      return voiceLevel(bins, analyser.context.sampleRate, analyser.fftSize);
    },
  };
}
