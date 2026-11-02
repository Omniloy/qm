import { CAPTURE_PROCESSOR, type CaptureProcessorOptions, type CaptureWorkletIn } from "../protocol.ts";
import { createFrameAssembler, downmix } from "./frames.ts";
import { createDownsampler } from "./resample.ts";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

class CaptureProcessor extends AudioWorkletProcessor {
  private target: MessagePort | null = null;
  private readonly resample: (input: Float32Array) => Float32Array;
  private readonly assemble: (input: Float32Array) => Float32Array[];

  constructor(options: { processorOptions: CaptureProcessorOptions }) {
    super(options);
    const { targetSampleRate, frameSamples } = options.processorOptions;
    this.resample = createDownsampler(sampleRate, targetSampleRate);
    this.assemble = createFrameAssembler(frameSamples);
    this.port.onmessage = (event: MessageEvent<CaptureWorkletIn>) => {
      this.target?.close();
      this.target = event.data.type === "attach" ? event.data.port : null;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const target = this.target;
    const mono = target ? downmix(inputs[0] ?? []) : null;
    if (!target || !mono) return true;
    for (const frame of this.assemble(this.resample(mono))) target.postMessage(frame, [frame.buffer]);
    return true;
  }
}

registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
