import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;

export async function* asChunks(source: ByteSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  yield* source;
}

export interface CollectedBytes {
  data: Buffer;
  sizeBytes: number;
  sha256: string;
}

type ByteSourceLimit = { maxBytes?: number; tooLarge?: () => Error };

export async function collectBytes(source: ByteSource, opts?: ByteSourceLimit): Promise<CollectedBytes> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of asChunks(source)) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (opts?.maxBytes != null && size > opts.maxBytes) {
      throw opts.tooLarge ? opts.tooLarge() : new Error("byte source exceeds the size limit");
    }
    hash.update(buf);
    chunks.push(buf);
  }
  return { data: Buffer.concat(chunks), sizeBytes: size, sha256: hash.digest("hex") };
}

export async function spoolBytes(
  source: ByteSource,
  path: string,
  opts?: ByteSourceLimit,
): Promise<Omit<CollectedBytes, "data">> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  async function* checked(): AsyncIterable<Uint8Array> {
    for await (const chunk of asChunks(source)) {
      sizeBytes += chunk.byteLength;
      if (opts?.maxBytes != null && sizeBytes > opts.maxBytes)
        throw opts.tooLarge ? opts.tooLarge() : new Error("byte source exceeds the size limit");
      hash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(Readable.from(checked()), createWriteStream(path, { flags: "wx", mode: 0o600 }));
  return { sha256: hash.digest("hex"), sizeBytes };
}
