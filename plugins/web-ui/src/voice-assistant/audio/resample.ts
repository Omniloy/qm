export type Resampler = (input: Float32Array) => Float32Array;

export function createLinearResampler(inputRate: number, outputRate: number): Resampler {
  assertRates(inputRate, outputRate);
  if (inputRate === outputRate) return (input) => input;
  const step = inputRate / outputRate;
  let previous = 0;
  let position = 1;
  return (input) => {
    if (input.length === 0) return input;
    const out = new Float32Array(Math.ceil((input.length + 1) / step) + 1);
    let written = 0;
    let t = position;
    while (t <= input.length) {
      const index = Math.floor(t);
      const fraction = t - index;
      const a = index === 0 ? previous : input[index - 1];
      const b = fraction > 0 && index < input.length ? input[index] : a;
      out[written++] = a + (b - a) * fraction;
      t += step;
    }
    previous = input[input.length - 1];
    position = t - input.length;
    return out.subarray(0, written);
  };
}

export function createDownsampler(inputRate: number, outputRate: number): Resampler {
  assertRates(inputRate, outputRate);
  if (inputRate === outputRate) return (input) => input;
  if (outputRate > inputRate) return createLinearResampler(inputRate, outputRate);
  const ratio = inputRate / outputRate;
  let boundary = inputRate;
  let sum = 0;
  let count = 0;
  return (input) => {
    const out = new Float32Array(Math.ceil(input.length / ratio) + 1);
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i];
      count++;
      if ((i + 1) * outputRate >= boundary) {
        out[written++] = sum / count;
        sum = 0;
        count = 0;
        boundary += inputRate;
      }
    }
    boundary -= input.length * outputRate;
    return out.subarray(0, written);
  };
}

function assertRates(inputRate: number, outputRate: number): void {
  if (!(inputRate > 0) || !(outputRate > 0) || !Number.isFinite(inputRate) || !Number.isFinite(outputRate)) {
    throw new RangeError(`invalid sample rates ${inputRate} -> ${outputRate}`);
  }
}
