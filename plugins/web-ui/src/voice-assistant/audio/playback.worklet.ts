import { PLAYBACK_PROCESSOR, type PlaybackWorkletIn } from "../protocol.ts";
import { createPlaybackQueue, type PlaybackQueue } from "./playback-queue.ts";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

class PlaybackProcessor extends AudioWorkletProcessor {
  private readonly queue: PlaybackQueue;

  constructor(options?: unknown) {
    super(options);
    this.queue = createPlaybackQueue(sampleRate, (message) => this.port.postMessage(message));
    this.port.onmessage = (event: MessageEvent<PlaybackWorkletIn>) => this.queue.handle(event.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0] ?? [];
    const first = channels[0];
    if (!first) return true;
    this.queue.render(first);
    for (let c = 1; c < channels.length; c++) channels[c].set(first);
    return true;
  }
}

registerProcessor(PLAYBACK_PROCESSOR, PlaybackProcessor);
