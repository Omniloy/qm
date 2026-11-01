import { withBase } from "../core-bridge.ts";
import { asrFilesFor, asrVariantFor } from "./asr/models.ts";
import { ensureModelFiles, missingModelFiles, requestPersistentStorage, voiceStorageEstimate } from "./model-cache.ts";
import { MODEL_PROXY_PREFIX, modelFileKey, type GpuSupport, type ModelFile } from "./protocol.ts";
import { TTS_MODEL_FILES } from "./tts/models.ts";

export interface VoiceModelStatus {
  gpu: GpuSupport;
  files: readonly ModelFile[];
  totalBytes: number;
  missingBytes: number;
}

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter(): Promise<{ features: { has(feature: string): boolean } } | null> };
};

export async function detectGpu(): Promise<GpuSupport> {
  const gpu = (navigator as GpuNavigator).gpu;
  if (!gpu) return { webgpu: false, shaderF16: false };
  try {
    const adapter = await gpu.requestAdapter();
    return adapter
      ? { webgpu: true, shaderF16: adapter.features.has("shader-f16") }
      : { webgpu: false, shaderF16: false };
  } catch {
    return { webgpu: false, shaderF16: false };
  }
}

export function voiceModelFiles(gpu: GpuSupport): readonly ModelFile[] {
  return [...asrFilesFor(asrVariantFor(gpu)), ...TTS_MODEL_FILES];
}

function totalBytes(files: readonly ModelFile[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

export async function voiceModelStatus(): Promise<VoiceModelStatus> {
  const gpu = await detectGpu();
  const files = voiceModelFiles(gpu);
  const missing = typeof caches === "undefined" ? files : await missingModelFiles(files);
  return { gpu, files, totalBytes: totalBytes(files), missingBytes: totalBytes(missing) };
}

export async function downloadVoiceModels(
  files: readonly ModelFile[],
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const missing = await missingModelFiles(files);
  const needed = totalBytes(missing);
  if (needed === 0) return;
  await requestPersistentStorage().catch(() => false);
  const { usage, quota } = await voiceStorageEstimate();
  if (quota > 0 && quota - usage < needed) throw new Error("voice_storage_full");
  const done = new Map<string, number>();
  await ensureModelFiles(missing, {
    url: (file) => withBase(MODEL_PROXY_PREFIX + modelFileKey(file)),
    signal,
    onProgress: (progress) => {
      done.set(progress.key, progress.loaded);
      let loaded = 0;
      for (const value of done.values()) loaded += value;
      onProgress(Math.min(1, loaded / needed));
    },
  });
  onProgress(1);
}
