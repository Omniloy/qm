import {
  CAPTURE_PROCESSOR,
  PLAYBACK_PROCESSOR,
  SPEECH_FRAME_SAMPLES,
  SPEECH_SAMPLE_RATE,
  type CaptureProcessorOptions,
  type CaptureWorkletIn,
} from "../protocol.ts";
import captureUrl from "./capture.worklet.ts?worker&url";
import { analyserLevel, levelBus } from "./levels.ts";
import playbackUrl from "./playback.worklet.ts?worker&url";

export interface AudioGraph {
  readonly context: AudioContext;
  readonly framePort: MessagePort;
  readonly playback: AudioWorkletNode;
  readonly output: AudioNode;
  setMuted(muted: boolean): void;
  close(): Promise<void>;
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

function meter(context: AudioContext): AnalyserNode {
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.55;
  return analyser;
}

export async function createAudioGraph(): Promise<AudioGraph> {
  const context = new AudioContext({ latencyHint: "interactive" });
  void context.resume().catch(() => undefined);
  const media = navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  try {
    const [stream] = await Promise.all([
      media,
      context.audioWorklet.addModule(captureUrl),
      context.audioWorklet.addModule(playbackUrl),
    ]);
    const tracks = stream.getAudioTracks();

    const source = context.createMediaStreamSource(stream);
    const processorOptions: CaptureProcessorOptions = {
      targetSampleRate: SPEECH_SAMPLE_RATE,
      frameSamples: SPEECH_FRAME_SAMPLES,
    };
    const capture = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions,
    });
    const inputMeter = meter(context);
    source.connect(capture);
    source.connect(inputMeter);

    const channel = new MessageChannel();
    const attach: CaptureWorkletIn = { type: "attach", port: channel.port1 };
    capture.port.postMessage(attach, [channel.port1]);

    const playback = new AudioWorkletNode(context, PLAYBACK_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const destination = context.createMediaStreamDestination();
    const outputMeter = meter(context);
    playback.connect(destination);
    playback.connect(outputMeter);

    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = destination.stream;
    void audio.play().catch(() => undefined);

    levelBus.attach("input", analyserLevel(inputMeter));
    levelBus.attach("output", analyserLevel(outputMeter));

    let closed = false;
    return {
      context,
      framePort: channel.port2,
      playback,
      output: destination,
      setMuted(muted) {
        for (const track of tracks) track.enabled = !muted;
      },
      async close() {
        if (closed) return;
        closed = true;
        levelBus.attach("input", null);
        levelBus.attach("output", null);
        const detach: CaptureWorkletIn = { type: "detach" };
        capture.port.postMessage(detach);
        source.disconnect();
        playback.disconnect();
        audio.pause();
        audio.srcObject = null;
        for (const track of tracks) track.stop();
        await context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    const stream = await media.catch(() => null);
    for (const track of stream?.getTracks() ?? []) track.stop();
    await context.close().catch(() => undefined);
    throw error;
  }
}
