import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MODEL_CACHE_NAME,
  deleteVoiceModels,
  ensureModelFiles,
  missingModelFiles,
  modelCacheRequest,
  readModelFile,
  requestPersistentStorage,
  voiceStorageEstimate,
} from "../src/voice-assistant/model-cache.ts";
import {
  ASR_MODEL_FILES,
  PHONON_ASR_MODEL_FILES,
  PHONON_ASR_PATHS,
  QWEN_ASR_MODEL_FILES,
  asrFilesFor,
  asrPaths,
  asrVariantFor,
} from "../src/voice-assistant/asr/models.ts";
import { VOICE_MODEL_FILES, VOICE_MODEL_FILES_BY_KEY } from "../src/voice-assistant/models.ts";
import { ASR_VARIANTS, modelFileKey } from "../src/voice-assistant/protocol.ts";
import type { ModelFile, ModelProgress } from "../src/voice-assistant/protocol.ts";

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, new Response(await response.arrayBuffer(), { headers: response.headers }));
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    const existing = this.stores.get(name);
    if (existing) return existing;
    const created = new FakeCache();
    this.stores.set(name, created);
    return created;
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

const realFetch = globalThis.fetch;
let storage: FakeCacheStorage;
let fetched: string[];

function fileFor(
  path: string,
  payload: Uint8Array,
  sha256 = createHash("sha256").update(payload).digest("hex"),
): ModelFile {
  return { repo: "acme/model", revision: "a".repeat(40), path, bytes: payload.byteLength, sha256, role: "asr" };
}

function serve(bodies: Record<string, Uint8Array>, status = 200): void {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    const body = bodies[url];
    if (!body || status !== 200) return new Response("nope", { status: status === 200 ? 404 : status });
    const half = Math.ceil(body.byteLength / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.slice(0, half));
        controller.enqueue(body.slice(half));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
}

const urlFor = (file: ModelFile) => `https://app.test/api/voice/models/${modelFileKey(file)}`;

beforeEach(() => {
  storage = new FakeCacheStorage();
  fetched = [];
  Object.defineProperty(globalThis, "caches", { value: storage, configurable: true, writable: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the cache key is a synthetic base-independent URL built from repo@revision/path", () => {
  const file = fileFor("onnx/encoder.onnx", new Uint8Array([1]));
  assert.equal(
    modelCacheRequest(file).url,
    `https://voice-models.qm.invalid/acme/model@${"a".repeat(40)}/onnx/encoder.onnx`,
  );
});

test("ensureModelFiles downloads, verifies and caches missing files with progress", async () => {
  const payload = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
  const file = fileFor("weights.bin", payload);
  serve({ [urlFor(file)]: payload });
  const progress: ModelProgress[] = [];
  await ensureModelFiles([file], { url: urlFor, onProgress: (p) => progress.push(p) });
  assert.deepEqual(
    progress.map((p) => p.loaded),
    [0, 500, 1000],
  );
  assert.ok(progress.every((p) => p.total === 1000 && p.key === modelFileKey(file)));
  assert.deepEqual(await readModelFile(file), payload);
  assert.deepEqual(await missingModelFiles([file]), []);
  assert.ok(storage.stores.has(MODEL_CACHE_NAME));
});

test("files already cached are not fetched again", async () => {
  const payload = new Uint8Array([9, 8, 7]);
  const file = fileFor("vocab.json", payload);
  serve({ [urlFor(file)]: payload });
  await ensureModelFiles([file], { url: urlFor });
  await ensureModelFiles([file], { url: urlFor });
  assert.equal(fetched.length, 1);
});

test("a sha256 mismatch throws and caches nothing", async () => {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const file = fileFor("tampered.bin", payload, "0".repeat(64));
  serve({ [urlFor(file)]: payload });
  await assert.rejects(
    ensureModelFiles([file], { url: urlFor }),
    /model_integrity_failed:acme\/model@a+\/tampered\.bin/,
  );
  assert.deepEqual(await missingModelFiles([file]), [file]);
});

test("a body longer or shorter than the manifest size throws model_size_mismatch", async () => {
  const declared = fileFor("short.bin", new Uint8Array(10));
  serve({ [urlFor(declared)]: new Uint8Array(4) });
  await assert.rejects(ensureModelFiles([declared], { url: urlFor }), /model_size_mismatch/);
  serve({ [urlFor(declared)]: new Uint8Array(20) });
  await assert.rejects(ensureModelFiles([declared], { url: urlFor }), /model_size_mismatch/);
  assert.deepEqual(await missingModelFiles([declared]), [declared]);
});

test("an upstream error status throws model_download_failed", async () => {
  const file = fileFor("gone.bin", new Uint8Array(3));
  serve({}, 502);
  await assert.rejects(ensureModelFiles([file], { url: urlFor }), /model_download_failed:.*:502/);
});

test("an aborted signal stops before downloading", async () => {
  const file = fileFor("abort.bin", new Uint8Array(3));
  serve({ [urlFor(file)]: new Uint8Array(3) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ensureModelFiles([file], { url: urlFor, signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetched.length, 0);
});

test("readModelFile never downloads and reports the missing key", async () => {
  const file = fileFor("absent.bin", new Uint8Array(3));
  serve({ [urlFor(file)]: new Uint8Array(3) });
  await assert.rejects(readModelFile(file), new RegExp(`^Error: model_missing:${modelFileKey(file)}$`));
  assert.equal(fetched.length, 0);
});

test("deleteVoiceModels drops the whole cache", async () => {
  const payload = new Uint8Array([5]);
  const file = fileFor("one.bin", payload);
  serve({ [urlFor(file)]: payload });
  await ensureModelFiles([file], { url: urlFor });
  await deleteVoiceModels();
  assert.deepEqual(await missingModelFiles([file]), [file]);
});

test("storage helpers degrade to false and zero without a StorageManager", async () => {
  assert.equal(await requestPersistentStorage(), false);
  assert.deepEqual(await voiceStorageEstimate(), { usage: 0, quota: 0 });
});

test("the ASR manifests pin one revision per engine with sha256 and sizes for every file", () => {
  assert.ok(ASR_MODEL_FILES.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.ok(ASR_MODEL_FILES.every((f) => f.role === "asr" && Number.isInteger(f.bytes) && f.bytes > 0));
  assert.ok(QWEN_ASR_MODEL_FILES.every((f) => /^[0-9a-f]{40}$/.test(f.revision)));
  assert.equal(new Set(QWEN_ASR_MODEL_FILES.map((f) => f.revision)).size, 1);
  assert.equal(new Set(PHONON_ASR_MODEL_FILES.map((f) => f.revision)).size, 1);
});

test("each ASR variant resolves every path it needs to a manifest entry", () => {
  for (const variant of ASR_VARIANTS) {
    const files = asrFilesFor("qwen3-asr-0.6b", variant);
    assert.deepEqual(Object.values(asrPaths(variant)).sort(), files.map((f) => f.path).sort());
    assert.ok(files.every((f) => f.variant === undefined || f.variant === variant));
    assert.deepEqual(
      asrFilesFor("phonon-2.5", variant)
        .map((f) => f.path)
        .sort(),
      Object.values(PHONON_ASR_PATHS).sort(),
    );
  }
  assert.equal(asrVariantFor("qwen3-asr-0.6b", { webgpu: true, shaderF16: true }), "q4f16");
  assert.equal(asrVariantFor("qwen3-asr-0.6b", { webgpu: true, shaderF16: false }), "q4");
  assert.equal(asrVariantFor("phonon-2.5", { webgpu: true, shaderF16: true }), "q4");
});

test("the voice model allowlist is keyed by repo@revision/path with no duplicates", () => {
  assert.equal(VOICE_MODEL_FILES_BY_KEY.size, VOICE_MODEL_FILES.length);
  for (const file of VOICE_MODEL_FILES) assert.equal(VOICE_MODEL_FILES_BY_KEY.get(modelFileKey(file)), file);
  assert.ok(ASR_MODEL_FILES.every((f) => VOICE_MODEL_FILES_BY_KEY.has(modelFileKey(f))));
});
