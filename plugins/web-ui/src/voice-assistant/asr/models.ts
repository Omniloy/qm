import type { AsrVariant, GpuSupport, ModelFile } from "../protocol.ts";

const REPO = "jiangzhuo9357/Qwen3-ASR-0.6B-ONNX";
const REVISION = "4a01b95fafe2c9e3af77e33c18bbb7de349c62f6";

export interface AsrModelPaths {
  encoder: string;
  decoderInit: string;
  decoderStep: string;
  decoderWeights: string;
  embedTokens: string;
  embedScales: string;
  vocab: string;
}

const SHARED_PATHS = {
  embedTokens: "embed_tokens.int8.bin",
  embedScales: "embed_scales.f32.bin",
  vocab: "vocab.json",
};

const VARIANT_PATHS: Readonly<Record<AsrVariant, Omit<AsrModelPaths, keyof typeof SHARED_PATHS>>> = {
  q4: {
    encoder: "encoder.onnx",
    decoderInit: "decoder_init.int4.onnx",
    decoderStep: "decoder_step.int4.onnx",
    decoderWeights: "decoder_weights.int4.data",
  },
  q4f16: {
    encoder: "encoder.fp16.onnx",
    decoderInit: "decoder_init.q4f16.onnx",
    decoderStep: "decoder_step.q4f16.onnx",
    decoderWeights: "decoder_weights.q4f16.data",
  },
};

export function asrPaths(variant: AsrVariant): AsrModelPaths {
  return { ...VARIANT_PATHS[variant], ...SHARED_PATHS };
}

export const ASR_MODEL_FILES: readonly ModelFile[] = [
  {
    repo: REPO,
    revision: REVISION,
    path: "embed_tokens.int8.bin",
    bytes: 155582464,
    sha256: "9ec07c97a15cb9defb675656edeed0370bc3e7b2c478d1eefe6f948fc6516513",
    role: "asr",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "embed_scales.f32.bin",
    bytes: 607744,
    sha256: "acce138a5f06f1233faa4a8a359903b3c303efc0ce37818ad8cf0f9be11fc9b3",
    role: "asr",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "vocab.json",
    bytes: 2776833,
    sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    role: "asr",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "encoder.onnx",
    bytes: 745766355,
    sha256: "333be56046eec5b60324f2a4ef4f0cfe7c24f5843481ad24b2c26738e1d055bb",
    role: "asr",
    variant: "q4",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "decoder_init.int4.onnx",
    bytes: 353078,
    sha256: "6da098fb828cacaeb09d5f72098079dc84c40f84030be0559025565c0b3479b5",
    role: "asr",
    variant: "q4",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "decoder_step.int4.onnx",
    bytes: 354803,
    sha256: "750fae89728bde18c22b3210d4704b2298ddb37c2c9a5b97bad03d76c4243624",
    role: "asr",
    variant: "q4",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "decoder_weights.int4.data",
    bytes: 382035968,
    sha256: "848e805e53fcba626c2f78d4cb8b43c380674b3c8874435ca27de1d10d138e0f",
    role: "asr",
    variant: "q4",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "encoder.fp16.onnx",
    bytes: 376261247,
    sha256: "af2a517a3d873a401ec9f64a81711e3d780fc8b085fd36f9366f9ac17a54411b",
    role: "asr",
    variant: "q4f16",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "decoder_init.q4f16.onnx",
    bytes: 348427,
    sha256: "328a14a46d7284bb6dc5242bc9f6029b013a6f2c42579f9e72dadbaa96ba511d",
    role: "asr",
    variant: "q4f16",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "decoder_step.q4f16.onnx",
    bytes: 350380,
    sha256: "27f4588874d1e50a539aed8de424107a8b934a1a5b13368c3a36b467ffcf2024",
    role: "asr",
    variant: "q4f16",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "decoder_weights.q4f16.data",
    bytes: 344670208,
    sha256: "898d0c82aad4cae494a4241639c73f9c8e79486fea3b4bac918883397b8f0bcc",
    role: "asr",
    variant: "q4f16",
  },
];

export function asrFilesFor(variant: AsrVariant): readonly ModelFile[] {
  return ASR_MODEL_FILES.filter((file) => file.variant === undefined || file.variant === variant);
}

export function asrVariantFor(gpu: GpuSupport): AsrVariant {
  return gpu.shaderF16 ? "q4f16" : "q4";
}
