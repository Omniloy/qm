import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { swallowAs } from "../util/errors.ts";
import { collectBytes, spoolBytes, type ByteSource } from "../util/bytes.ts";
import { bodyToReadable, isNoSuchKey, s3Client, type S3Send } from "../persistence/s3.ts";

export type { ByteSource } from "../util/bytes.ts";

interface PutBytesResult {
  blobKey: string;
  sizeBytes: number;
  sha256: string;
}

interface OpenBytes {
  sizeBytes: number;
  stream: Readable;
}

interface PutBytesOptions {
  maxBytes?: number;
  beforeCommit?: (blobKey: string) => Promise<void>;
}

export interface DurableByteStore {
  put(source: ByteSource, opts?: PutBytesOptions): Promise<PutBytesResult>;
  open(blobKey: string): Promise<OpenBytes | null>;
  delete(blobKey: string): Promise<void>;
}

export class ByteSourceTooLargeError extends Error {
  constructor() {
    super("file exceeds the size limit");
    this.name = "ByteSourceTooLargeError";
  }
}

const BLOB_KEY = /^files\/(?:[0-9a-f]{64}|uploads\/[0-9a-f]{32})$/;
const keyFor = (sha256: string): string => `files/${sha256}`;

function collect(source: ByteSource, maxBytes?: number): Promise<{ data: Buffer; sha256: string }> {
  return collectBytes(source, {
    ...(maxBytes != null ? { maxBytes } : {}),
    tooLarge: () => new ByteSourceTooLargeError(),
  });
}

export function createMemoryDurableByteStore(): DurableByteStore {
  const blobs = new Map<string, Buffer>();
  return {
    async put(source, opts) {
      const { data, sha256 } = await collect(source, opts?.maxBytes);
      const blobKey = keyFor(sha256);
      await opts?.beforeCommit?.(blobKey);
      if (!blobs.has(blobKey)) blobs.set(blobKey, data);
      return { blobKey, sizeBytes: data.length, sha256 };
    },
    async open(blobKey) {
      const hit = blobs.get(blobKey);
      if (!hit) return null;
      return { sizeBytes: hit.length, stream: Readable.from(hit) };
    },
    async delete(blobKey) {
      blobs.delete(blobKey);
    },
  };
}

export function createLocalDurableByteStore(dir: string): DurableByteStore {
  const base = join(dir, "files");
  let ensured: Promise<unknown> | null = null;
  const ensureDir = (): Promise<unknown> => (ensured ??= mkdir(base, { recursive: true }));

  return {
    async put(source, opts) {
      await ensureDir();
      const partPath = join(base, `${randomUUID()}.part`);
      try {
        const { sha256, sizeBytes } = await spoolBytes(source, partPath, {
          ...(opts?.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
          tooLarge: () => new ByteSourceTooLargeError(),
        });
        await opts?.beforeCommit?.(keyFor(sha256));
        await rename(partPath, join(base, sha256));
        return { blobKey: keyFor(sha256), sizeBytes, sha256 };
      } finally {
        await rm(partPath, { force: true });
      }
    },

    async open(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return null;
      const path = join(base, blobKey.slice("files/".length));
      let st;
      try {
        st = await stat(path);
      } catch (err) {
        if (err != null && typeof err === "object" && (err as { code?: string }).code === "ENOENT") return null;
        throw err;
      }
      if (!st.isFile()) return null;
      return { sizeBytes: st.size, stream: createReadStream(path) };
    },

    async delete(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return;
      await rm(join(base, blobKey.slice("files/".length)), { force: true }).catch(
        swallowAs("files: delete", undefined),
      );
    },
  };
}

export interface S3DurableByteOptions {
  bucket: string;
  region?: string;
  prefix?: string;
  _client?: S3Send;
}

export function createS3DurableByteStore(options: S3DurableByteOptions): DurableByteStore {
  const bucket = options.bucket;
  const prefix = options.prefix ?? "";
  const s3Key = (blobKey: string): string => prefix + blobKey;
  const client = options._client ?? s3Client(options.region);

  return {
    async put(source, opts) {
      const dir = await mkdtemp(join(tmpdir(), "qm-files-"));
      const path = join(dir, "upload");
      let uploadId: string | undefined;
      let Key: string | undefined;
      try {
        const { sha256, sizeBytes } = await spoolBytes(source, path, {
          ...(opts?.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
          tooLarge: () => new ByteSourceTooLargeError(),
        });
        const blobKey = keyFor(sha256);
        await opts?.beforeCommit?.(blobKey);
        Key = s3Key(blobKey);
        if (sizeBytes === 0) {
          await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: Buffer.alloc(0) }));
        } else {
          const started = (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key }))) as {
            UploadId?: string;
          };
          if (!started.UploadId) throw new Error("S3 did not return an upload ID");
          uploadId = started.UploadId;
          const parts: Array<{ ETag: string; PartNumber: number }> = [];
          const partSize = Math.max(16 * 1024 * 1024, Math.ceil(sizeBytes / 10000));
          for (let offset = 0; offset < sizeBytes; offset += partSize) {
            const length = Math.min(partSize, sizeBytes - offset);
            const body = createReadStream(path, { start: offset, end: offset + length - 1 });
            try {
              const done = (await client.send(
                new UploadPartCommand({
                  Bucket: bucket,
                  Key,
                  UploadId: uploadId,
                  PartNumber: parts.length + 1,
                  Body: body,
                  ContentLength: length,
                }),
              )) as { ETag?: string };
              if (!done.ETag) throw new Error("S3 did not return a part ETag");
              parts.push({ ETag: done.ETag, PartNumber: parts.length + 1 });
            } finally {
              body.destroy();
            }
          }
          await client.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
            }),
          );
        }
        return { blobKey, sizeBytes, sha256 };
      } catch (error) {
        if (uploadId && Key)
          await client
            .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId: uploadId }))
            .catch(swallowAs("files: abort upload", undefined));
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async open(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return null;
      let r: { Body?: unknown; ContentLength?: number };
      try {
        r = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key(blobKey) }))) as {
          Body?: unknown;
          ContentLength?: number;
        };
      } catch (err) {
        if (isNoSuchKey(err)) return null;
        throw err;
      }
      if (r.Body == null) return null;
      return { sizeBytes: r.ContentLength ?? 0, stream: bodyToReadable(r.Body) };
    },

    async delete(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key(blobKey) }));
    },
  };
}
