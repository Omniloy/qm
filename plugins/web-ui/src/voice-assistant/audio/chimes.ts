export type ChimeKind = "wake" | "announce" | "error" | "thinking";

const KEY_HZ = 698.46;

const PARTIALS = [
  { ratio: 1, gain: 1, decay: 1.5 },
  { ratio: 2, gain: 0.32, decay: 0.9 },
  { ratio: 2.76, gain: 0.2, decay: 0.6 },
  { ratio: 5.4, gain: 0.06, decay: 0.28 },
] as const;

export interface ChimeNote {
  frequency: number;
  at: number;
  level: number;
}

export function chimeNotes(kind: ChimeKind): ChimeNote[] {
  switch (kind) {
    case "wake":
      return [
        { frequency: KEY_HZ, at: 0, level: 0.045 },
        { frequency: KEY_HZ * 1.5, at: 0.11, level: 0.035 },
      ];
    case "announce":
      return [
        { frequency: KEY_HZ * 1.5, at: 0, level: 0.035 },
        { frequency: KEY_HZ * 2, at: 0.11, level: 0.03 },
      ];
    case "thinking":
      return [{ frequency: KEY_HZ / 2, at: 0, level: 0.02 }];
    case "error":
      return [
        { frequency: KEY_HZ * 1.5, at: 0, level: 0.03 },
        { frequency: KEY_HZ, at: 0.12, level: 0.035 },
      ];
  }
}

export function playChime(context: AudioContext, destination: AudioNode, kind: ChimeKind): void {
  for (const note of chimeNotes(kind)) bell(context, destination, note);
}

function bell(context: AudioContext, destination: AudioNode, note: ChimeNote): void {
  const start = context.currentTime + note.at;
  const out = context.createGain();
  out.gain.value = note.level;
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 4200;
  out.connect(tone).connect(destination);
  for (const partial of PARTIALS) {
    const osc = context.createOscillator();
    const envelope = context.createGain();
    osc.type = "sine";
    osc.frequency.value = note.frequency * partial.ratio;
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(partial.gain, start + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + partial.decay);
    osc.connect(envelope).connect(out);
    if (partial === PARTIALS[0]) osc.onended = () => out.disconnect();
    osc.start(start);
    osc.stop(start + partial.decay + 0.05);
  }
}
