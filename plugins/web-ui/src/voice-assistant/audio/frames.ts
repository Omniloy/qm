export type FrameAssembler = (input: Float32Array) => Float32Array[];

export function createFrameAssembler(frameSamples: number): FrameAssembler {
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) throw new RangeError(`invalid frame size ${frameSamples}`);
  let current = new Float32Array(frameSamples);
  let filled = 0;
  return (input) => {
    const frames: Float32Array[] = [];
    let read = 0;
    while (read < input.length) {
      const take = Math.min(frameSamples - filled, input.length - read);
      current.set(input.subarray(read, read + take), filled);
      filled += take;
      read += take;
      if (filled === frameSamples) {
        frames.push(current);
        current = new Float32Array(frameSamples);
        filled = 0;
      }
    }
    return frames;
  };
}

export function downmix(channels: readonly Float32Array[]): Float32Array | null {
  const first = channels[0];
  if (!first) return null;
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i++) out[i] += channel[i] ?? 0;
  }
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return out;
}
