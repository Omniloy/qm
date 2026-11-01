export interface TokenDecoder {
  decode(ids: readonly number[]): string;
}

function unicodeToByte(): Map<string, number> {
  const printable = (b: number) => (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || b >= 174;
  const map = new Map<string, number>();
  let shifted = 0;
  for (let b = 0; b < 256; b++) {
    map.set(String.fromCodePoint(printable(b) ? b : 256 + shifted++), b);
  }
  return map;
}

export function createTokenDecoder(vocabBytes: Uint8Array): TokenDecoder {
  const vocab = JSON.parse(new TextDecoder().decode(vocabBytes)) as Record<string, number>;
  const byteOf = unicodeToByte();
  const tokens: (Uint8Array | undefined)[] = [];
  for (const [token, id] of Object.entries(vocab)) {
    const bytes = Array.from(token, (char) => byteOf.get(char));
    if (bytes.length > 0 && bytes.every((byte) => byte !== undefined)) tokens[id] = Uint8Array.from(bytes);
  }
  return {
    decode(ids) {
      const parts = ids.map((id) => tokens[id]).filter((bytes) => bytes !== undefined);
      const out = new Uint8Array(parts.reduce((sum, bytes) => sum + bytes.length, 0));
      let offset = 0;
      for (const bytes of parts) {
        out.set(bytes, offset);
        offset += bytes.length;
      }
      return new TextDecoder().decode(out);
    },
  };
}
