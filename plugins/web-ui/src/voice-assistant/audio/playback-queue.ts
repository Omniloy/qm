import type { PlaybackWorkletIn, PlaybackWorkletOut } from "../protocol.ts";
import { createLinearResampler, type Resampler } from "./resample.ts";

const PROGRESS_INTERVAL_S = 0.1;
const FADE_IN_S = 0.01;

interface Chunk {
  utteranceId: string;
  data: Float32Array;
  offset: number;
}

interface Utterance {
  sampleRate: number;
  resample: Resampler;
  ended: boolean;
  played: number;
  pushed: number;
  queued: number;
  sinceProgress: number;
  faded: number;
}

export interface PlaybackQueue {
  handle(message: PlaybackWorkletIn): void;
  render(out: Float32Array): void;
}

export function createPlaybackQueue(outputRate: number, post: (message: PlaybackWorkletOut) => void): PlaybackQueue {
  const chunks: Chunk[] = [];
  const utterances = new Map<string, Utterance>();
  const progressEvery = Math.max(1, Math.round(outputRate * PROGRESS_INTERVAL_S));
  const fadeSamples = Math.max(1, Math.round(outputRate * FADE_IN_S));

  const playedAtSource = (u: Utterance) => Math.round((u.played * u.sampleRate) / outputRate);

  const reportProgress = (utteranceId: string, u: Utterance, playedSamples = playedAtSource(u)) => {
    u.sinceProgress = 0;
    post({ type: "progress", utteranceId, playedSamples: Math.min(playedSamples, u.pushed), sampleRate: u.sampleRate });
  };

  const settle = (utteranceId: string, u: Utterance) => {
    if (!u.ended || u.queued > 0) return;
    reportProgress(utteranceId, u, u.pushed);
    utterances.delete(utteranceId);
    post({ type: "drained", utteranceId });
  };

  const utteranceFor = (utteranceId: string, sampleRate: number) => {
    const existing = utterances.get(utteranceId);
    if (existing) return existing;
    const created: Utterance = {
      sampleRate,
      resample: createLinearResampler(sampleRate, outputRate),
      ended: false,
      played: 0,
      pushed: 0,
      queued: 0,
      sinceProgress: 0,
      faded: 0,
    };
    utterances.set(utteranceId, created);
    return created;
  };

  return {
    handle(message) {
      if (message.type === "flush") {
        for (const [utteranceId, u] of utterances) if (u.played > 0) reportProgress(utteranceId, u);
        chunks.length = 0;
        utterances.clear();
        post({ type: "flushed" });
        return;
      }
      if (message.type === "end") {
        const u = utterances.get(message.utteranceId);
        if (!u) {
          post({ type: "drained", utteranceId: message.utteranceId });
          return;
        }
        u.ended = true;
        settle(message.utteranceId, u);
        return;
      }
      const u = utteranceFor(message.utteranceId, message.sampleRate);
      if (u.ended) return;
      u.pushed += message.pcm.length;
      const data = u.resample(message.pcm);
      if (data.length === 0) return;
      u.queued += 1;
      chunks.push({ utteranceId: message.utteranceId, data, offset: 0 });
    },
    render(out) {
      let i = 0;
      while (i < out.length && chunks.length > 0) {
        const head = chunks[0];
        const u = utterances.get(head.utteranceId);
        if (!u) {
          chunks.shift();
          continue;
        }
        const n = Math.min(out.length - i, head.data.length - head.offset);
        for (let k = 0; k < n; k++) {
          let sample = head.data[head.offset + k];
          if (u.faded < fadeSamples) sample *= u.faded++ / fadeSamples;
          out[i + k] = sample;
        }
        head.offset += n;
        i += n;
        u.played += n;
        u.sinceProgress += n;
        if (u.sinceProgress >= progressEvery) reportProgress(head.utteranceId, u);
        if (head.offset >= head.data.length) {
          chunks.shift();
          u.queued -= 1;
          settle(head.utteranceId, u);
        }
      }
      out.fill(0, i);
    },
  };
}
