import { argmax } from "./qwen-asr.ts";

const TDT_BLANK = 8192;
const TOKEN_CLASSES = TDT_BLANK + 1;
const DURATIONS = [0, 1, 2, 3, 4] as const;
const MAX_SYMBOLS_PER_FRAME = 10;

interface TdtStepResult<S> {
  logits: Float32Array;
  state: S;
}

export interface TdtDecodeRequest<S> {
  frames: number;
  initial: S;
  maxTokens: number;
  step(frame: number, token: number, state: S): Promise<TdtStepResult<S>>;
  signal?: AbortSignal;
}

export async function greedyTdt<S>(request: TdtDecodeRequest<S>): Promise<number[]> {
  const tokens: number[] = [];
  let token = TDT_BLANK;
  let state = request.initial;
  let symbols = 0;
  for (let frame = 0; frame < request.frames && tokens.length < request.maxTokens;) {
    request.signal?.throwIfAborted();
    const result = await request.step(frame, token, state);
    const best = argmax(result.logits.subarray(0, TOKEN_CLASSES), false);
    let advance = DURATIONS[argmax(result.logits.subarray(TOKEN_CLASSES, TOKEN_CLASSES + DURATIONS.length), false)];
    if (best === TDT_BLANK) {
      advance ||= 1;
    } else {
      tokens.push(best);
      token = best;
      state = result.state;
      symbols++;
      if (advance === 0 && symbols >= MAX_SYMBOLS_PER_FRAME) advance = 1;
    }
    if (advance > 0) symbols = 0;
    frame += advance;
  }
  return tokens;
}
