import { modelFileKey } from "./protocol.ts";
import type { ModelFile } from "./protocol.ts";
import { ASR_MODEL_FILES } from "./asr/models.ts";
import { TTS_MODEL_FILES } from "./tts/models.ts";

export const VOICE_MODEL_FILES: readonly ModelFile[] = [...ASR_MODEL_FILES, ...TTS_MODEL_FILES];

export const VOICE_MODEL_FILES_BY_KEY: ReadonlyMap<string, ModelFile> = new Map(
  VOICE_MODEL_FILES.map((file) => [modelFileKey(file), file]),
);
