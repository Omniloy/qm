import { modelFileKey } from "./protocol.ts";
import type { ModelFile, ModelProgress } from "./protocol.ts";

export const MODEL_CACHE_NAME = "qm-voice-models-v1";

const CACHE_ORIGIN = "https://voice-models.qm.invalid/";

export function modelCacheRequest(file: ModelFile): Request {
  return new Request(new URL(modelFileKey(file), CACHE_ORIGIN));
}

export async function readModelFile(file: ModelFile): Promise<Uint8Array> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  const hit = await cache.match(modelCacheRequest(file));
  if (!hit) throw new Error(`model_missing:${modelFileKey(file)}`);
  return new Uint8Array(await hit.arrayBuffer());
}

export async function missingModelFiles(files: readonly ModelFile[]): Promise<ModelFile[]> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  const hits = await Promise.all(files.map((file) => cache.match(modelCacheRequest(file))));
  return files.filter((_, i) => hits[i] === undefined);
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function download(
  file: ModelFile,
  url: string,
  onProgress: ((p: ModelProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = modelFileKey(file);
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error(`model_download_failed:${key}:${response.status}`);
  const bytes = new Uint8Array(file.bytes);
  const reader = response.body.getReader();
  let loaded = 0;
  onProgress?.({ key, loaded, total: file.bytes });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > file.bytes) {
      await reader.cancel();
      throw new Error(`model_size_mismatch:${key}`);
    }
    bytes.set(value, loaded);
    loaded += value.byteLength;
    onProgress?.({ key, loaded, total: file.bytes });
  }
  if (loaded !== file.bytes) throw new Error(`model_size_mismatch:${key}`);
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== file.sha256) throw new Error(`model_integrity_failed:${key}`);
  return bytes;
}

export async function ensureModelFiles(
  files: readonly ModelFile[],
  opts: { url(file: ModelFile): string; onProgress?(p: ModelProgress): void; signal?: AbortSignal },
): Promise<void> {
  const cache = await caches.open(MODEL_CACHE_NAME);
  for (const file of await missingModelFiles(files)) {
    opts.signal?.throwIfAborted();
    const bytes = await download(file, opts.url(file), opts.onProgress, opts.signal);
    await cache.put(
      modelCacheRequest(file),
      new Response(bytes, {
        headers: { "content-type": "application/octet-stream", "content-length": String(file.bytes) },
      }),
    );
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  const storage = globalThis.navigator.storage as StorageManager | undefined;
  if (!storage) return false;
  if (await storage.persisted()) return true;
  return typeof storage.persist === "function" ? storage.persist() : false;
}

export async function voiceStorageEstimate(): Promise<{ usage: number; quota: number }> {
  const storage = globalThis.navigator.storage as StorageManager | undefined;
  const estimate = storage ? await storage.estimate() : {};
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

export async function deleteVoiceModels(): Promise<void> {
  await caches.delete(MODEL_CACHE_NAME);
}
