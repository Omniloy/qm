import { api, withBase } from "../core-bridge.ts";
import { asrFilesFor, asrVariantFor } from "./asr/models.ts";
import {
  deleteVoiceModels as deleteCachedVoiceModels,
  ensureModelFiles,
  missingModelFiles,
  requestPersistentStorage,
  voiceStorageEstimate,
} from "./model-cache.ts";
import {
  DEFAULT_VOICE_ORG_CONFIG,
  MODEL_PROXY_PREFIX,
  modelFileKey,
  type AsrEngineId,
  type GpuSupport,
  type ModelFile,
  type TtsEngineId,
  type VoiceAccess,
  type VoicePreferences,
  type VoiceSettings,
} from "./protocol.ts";
import {
  FALLBACK_ASR_ENGINE,
  FALLBACK_TTS_ENGINE,
  parseVoiceOrgConfig,
  runnableVoiceSettings,
} from "./settings-store.ts";
import { VOICE_MODEL_FILES } from "./models.ts";
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
const FALLBACK_ACCESS: VoiceAccess = { gatedModels: true, config: { ...DEFAULT_VOICE_ORG_CONFIG } };
const GATED_MODEL_FILES = VOICE_MODEL_FILES.filter((file) => file.gated);
let access: Promise<VoiceAccess> | null = null;

function gatedModelsCached(): Promise<boolean> {
  return missingModelFiles(GATED_MODEL_FILES).then(
    (missing) => missing.length === 0,
    () => false,
  );
}

export function voiceAccess(): Promise<VoiceAccess> {
  access ??= api<{ gatedModels?: unknown; config?: unknown }>("/api/voice/access").then(
    async (body) => ({
      gatedModels: body.gatedModels !== false || (await gatedModelsCached()),
      config: parseVoiceOrgConfig(body.config),
    }),
    () => {
      access = null;
      return FALLBACK_ACCESS;
    },
  );
  return access;
}

export function forgetVoiceAccess(): void {
  access = null;
}

export async function deleteVoiceModels(): Promise<void> {
  await deleteCachedVoiceModels();
  forgetVoiceAccess();
}

export function fallBackFrom(engine: AsrEngineId | TtsEngineId): boolean {
  if (engine === FALLBACK_ASR_ENGINE || engine === FALLBACK_TTS_ENGINE || failedEngines.has(engine)) return false;
  failedEngines.add(engine);
  return true;
}

export function effectiveVoiceSettings(preferences: VoicePreferences, current: VoiceAccess): VoiceSettings {
  return runnableVoiceSettings({ ...preferences, ...current.config }, current.gatedModels, failedEngines);
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
  settings: Pick<VoiceSettings, "asrEngine" | "ttsEngine" | "voice" | "micMode">,
): readonly ModelFile[] {
  const { asrEngine } = settings;
  const asr = settings.micMode === "off" ? [] : asrFilesFor(asrEngine, asrVariantFor(asrEngine, gpu));
  return [...asr, ...ttsFilesFor(settings.ttsEngine, settings.voice)];
}

function totalBytes(files: readonly ModelFile[]): number {
  return files.reduce((sum, file) => sum + file.bytes, 0);
}

export async function voiceModelStatus(preferences: VoicePreferences): Promise<VoiceModelStatus> {
  const [gpu, current] = await Promise.all([detectGpu(), voiceAccess()]);
  const settings = effectiveVoiceSettings(preferences, current);
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
