import { api, withBase } from "../core-bridge.ts";
import { asrFilesFor, asrVariantFor } from "./asr/models.ts";
import { ensureModelFiles, missingModelFiles, requestPersistentStorage, voiceStorageEstimate } from "./model-cache.ts";
import {
  MODEL_PROXY_PREFIX,
  modelFileKey,
  type AsrEngineId,
  type GpuSupport,
  type ModelFile,
  type TtsEngineId,
  type VoiceSettings,
} from "./protocol.ts";
import { FALLBACK_ASR_ENGINE, FALLBACK_TTS_ENGINE, runnableVoiceSettings } from "./settings-store.ts";
import { ttsFilesFor } from "./tts/models.ts";

export interface VoiceModelStatus {
  gpu: GpuSupport;
  files: readonly ModelFile[];
  totalBytes: number;
  missingBytes: number;
  asrEngine: AsrEngineId;
  ttsEngine: TtsEngineId;
}

const failedEngines = new Set<AsrEngineId | TtsEngineId>();
let gatedAccess: Promise<boolean> | null = null;

export function gatedModelsAvailable(): Promise<boolean> {
  gatedAccess ??= api<{ gatedModels?: unknown }>("/api/voice/access").then(
    (access) => access.gatedModels !== false,
    () => {
      gatedAccess = null;
      return true;
    },
  );
  return gatedAccess;
}

export function fallBackFrom(engine: AsrEngineId | TtsEngineId): boolean {
  if (engine === FALLBACK_ASR_ENGINE || engine === FALLBACK_TTS_ENGINE || failedEngines.has(engine)) return false;
  failedEngines.add(engine);
  return true;
}

export function effectiveVoiceSettings(settings: VoiceSettings, gatedModels: boolean): VoiceSettings {
  return runnableVoiceSettings(settings, gatedModels, failedEngines);
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

export function voiceModelFiles(
  gpu: GpuSupport,
  settings: Pick<VoiceSettings, "asrEngine" | "ttsEngine" | "voice">,
): readonly ModelFile[] {
  const { asrEngine } = settings;
  return [...asrFilesFor(asrEngine, asrVariantFor(asrEngine, gpu)), ...ttsFilesFor(settings.ttsEngine, settings.voice)];
}

function totalBytes(files: readonly ModelFile[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

export async function voiceModelStatus(chosen: VoiceSettings): Promise<VoiceModelStatus> {
  const [gpu, gatedModels] = await Promise.all([detectGpu(), gatedModelsAvailable()]);
  const settings = effectiveVoiceSettings(chosen, gatedModels);
  const files = voiceModelFiles(gpu, settings);
  const missing = typeof caches === "undefined" ? files : await missingModelFiles(files);
  return {
    gpu,
    files,
    totalBytes: totalBytes(files),
    missingBytes: totalBytes(missing),
    asrEngine: settings.asrEngine,
    ttsEngine: settings.ttsEngine,
  };
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
