import {
  CAPTURE_PROCESSOR,
  PLAYBACK_PROCESSOR,
  SPEECH_FRAME_SAMPLES,
  SPEECH_SAMPLE_RATE,
  type CaptureProcessorOptions,
  type CaptureWorkletIn,
  type MicrophoneHealth,
} from "../protocol.ts";
import captureUrl from "./capture.worklet.ts?worker&url";
import { analyserLevel, levelBus } from "./levels.ts";
import playbackUrl from "./playback.worklet.ts?worker&url";

export interface AudioGraph {
  readonly context: AudioContext;
  readonly framePort: MessagePort | null;
  readonly playback: AudioWorkletNode;
  readonly output: AudioNode;
  microphone(): MicrophoneHealth;
  reconnectMicrophone(force: boolean): void;
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

interface Capture {
  framePort: MessagePort;
  health(): MicrophoneHealth;
  setEnabled(enabled: boolean): void;
  reconnect(force: boolean): void;
  close(): void;
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function connectCapture(context: AudioContext, stream: MediaStream, onHealth: () => void): Capture {
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
  const channel = new MessageChannel();
  const attach: CaptureWorkletIn = { type: "attach", port: channel.port1 };
  capture.port.postMessage(attach, [channel.port1]);
  levelBus.attach("input", analyserLevel(inputMeter));

  let enabled = true;
  let closed = false;
  let current: { stream: MediaStream; source: MediaStreamAudioSourceNode; listeners: AbortController } | null = null;
  let reconnecting: Promise<void> | null = null;
  let blocked = false;

  const tracks = () => current?.stream.getAudioTracks() ?? [];
  const health = (): MicrophoneHealth => {
    const live = tracks().filter((track) => track.readyState === "live");
    if (live.length === 0) return blocked ? "blocked" : "lost";
    return live.every((track) => track.muted) ? "silent" : "live";
  };

  const release = () => {
    if (!current) return;
    current.listeners.abort();
    current.source.disconnect();
    stopStream(current.stream);
    current = null;
  };

  const reconnect = () => {
    reconnecting ??= navigator.mediaDevices
      .getUserMedia({ audio: MIC_CONSTRAINTS })
      .then(
        (next) => {
          if (closed) stopStream(next);
          else use(next);
        },
        (error: unknown) => {
          blocked = (error as { name?: unknown } | null)?.name === "NotAllowedError";
          onHealth();
        },
      )
      .finally(() => {
        reconnecting = null;
      });
  };

  const use = (next: MediaStream) => {
    release();
    blocked = false;
    const listeners = new AbortController();
    for (const track of next.getAudioTracks()) {
      track.enabled = enabled;
      track.addEventListener("mute", onHealth, { signal: listeners.signal });
      track.addEventListener("unmute", onHealth, { signal: listeners.signal });
      track.addEventListener(
        "ended",
        () => {
          onHealth();
          reconnect();
        },
        { signal: listeners.signal },
      );
    }
    const source = context.createMediaStreamSource(next);
    source.connect(capture);
    source.connect(inputMeter);
    current = { stream: next, source, listeners };
    onHealth();
  };

  use(stream);
  return {
    framePort: channel.port2,
    health,
    setEnabled(next) {
      enabled = next;
      for (const track of tracks()) track.enabled = next;
    },
    reconnect(force) {
      if (force || health() !== "live") reconnect();
    },
    close() {
      closed = true;
      const detach: CaptureWorkletIn = { type: "detach" };
      capture.port.postMessage(detach);
      release();
    },
  };
}

export async function createAudioGraph(
  microphone: boolean,
  onMicrophone: () => void = () => undefined,
): Promise<AudioGraph> {
  const context = new AudioContext({ latencyHint: "interactive" });
  const wake = () => {
    if (context.state !== "running" && context.state !== "closed") void context.resume().catch(() => undefined);
  };
  wake();
  context.addEventListener("statechange", wake);
  const media = microphone ? navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS }) : Promise.resolve(null);
  try {
    const [stream] = await Promise.all([
      media,
      microphone ? context.audioWorklet.addModule(captureUrl) : undefined,
      context.audioWorklet.addModule(playbackUrl),
    ]);
    const capture = stream ? connectCapture(context, stream, onMicrophone) : null;

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

    levelBus.attach("output", analyserLevel(outputMeter));

    let closed = false;
    return {
      context,
      framePort: capture?.framePort ?? null,
      playback,
      output: destination,
      microphone: () => capture?.health() ?? "live",
      reconnectMicrophone(force) {
        wake();
        capture?.reconnect(force);
      },
      setMuted: (muted) => capture?.setEnabled(!muted),
      async close() {
        if (closed) return;
        closed = true;
        context.removeEventListener("statechange", wake);
        levelBus.attach("input", null);
        levelBus.attach("output", null);
        capture?.close();
        playback.disconnect();
        audio.pause();
        audio.srcObject = null;
        await context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    stopStream(await media.catch(() => null));
    await context.close().catch(() => undefined);
    throw error;
  }
}
