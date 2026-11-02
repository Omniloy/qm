const WORD_START = "▁";
const CONTROL_PIECE = /^<(unk|pad|\|.*\|)>$/;

export interface PieceDecoder {
  decode(ids: readonly number[]): string;
}

export function createPieceDecoder(vocabBytes: Uint8Array): PieceDecoder {
  const pieces: string[] = [];
  for (const line of new TextDecoder().decode(vocabBytes).split("\n")) {
    const split = line.lastIndexOf(" ");
    if (split > 0) pieces[Number(line.slice(split + 1))] = line.slice(0, split);
  }
  return {
    decode(ids) {
      return ids
        .map((id) => pieces[id] ?? "")
        .filter((piece) => !CONTROL_PIECE.test(piece))
        .join("")
        .replaceAll(WORD_START, " ")
        .trim();
    },
  };
}
