import type { ModelFile, TtsEngineId } from "../protocol.ts";
import { PHONON_VOICES, supportedVoice } from "../voices.ts";

const REPO = "supertone-oss-archive/supertonic-3";
const REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46";

export const SUPERTONIC_MODEL_FILES: readonly ModelFile[] = [
  {
    repo: REPO,
    revision: REVISION,
    path: "onnx/duration_predictor.onnx",
    bytes: 3700147,
    sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "onnx/text_encoder.onnx",
    bytes: 36416150,
    sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "onnx/vector_estimator.onnx",
    bytes: 256534781,
    sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "onnx/vocoder.onnx",
    bytes: 101424195,
    sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "onnx/tts.json",
    bytes: 8253,
    sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "onnx/unicode_indexer.json",
    bytes: 277676,
    sha256: "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/F1.json",
    bytes: 292046,
    sha256: "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/F2.json",
    bytes: 292423,
    sha256: "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/F3.json",
    bytes: 290794,
    sha256: "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/F4.json",
    bytes: 291808,
    sha256: "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/F5.json",
    bytes: 291479,
    sha256: "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/M1.json",
    bytes: 291748,
    sha256: "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/M2.json",
    bytes: 292055,
    sha256: "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/M3.json",
    bytes: 290198,
    sha256: "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/M4.json",
    bytes: 291522,
    sha256: "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303",
    role: "tts",
  },
  {
    repo: REPO,
    revision: REVISION,
    path: "voice_styles/M5.json",
    bytes: 291469,
    sha256: "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2",
    role: "tts",
  },
];

const PHONON_REPO = "gradium/phonon-40m-multilingual";
const PHONON_REVISION = "1537ce46c64f42903e0d608b132ccb073dac46d2";

export const PHONON_TTS_MODEL_FILES: readonly ModelFile[] = [
  {
    repo: PHONON_REPO,
    revision: PHONON_REVISION,
    path: "model.q8.gguf",
    bytes: 74553568,
    sha256: "96fa067813244e0c6c5997b98ec2596b65ec8574b14916b48e97db056ff97e27",
    role: "tts",
    gated: true,
  },
  {
    repo: PHONON_REPO,
    revision: PHONON_REVISION,
    path: "tokenizer.json",
    bytes: 277749,
    sha256: "a5e8c6060bf927ed367314f21355148fdf4acff6fadb94e49c86bc7182449433",
    role: "tts",
    gated: true,
  },
  {
    repo: PHONON_REPO,
    revision: PHONON_REVISION,
    path: "config.json",
    bytes: 4674,
    sha256: "e312ab694d5ec1f79ccea520a2eeec989969ce07e9b4189ae7e9ad8e035ef82e",
    role: "tts",
    gated: true,
  },
];

const PHONON_VOICE_SHA256: Readonly<Record<string, string>> = {
  u2UscyAnHilpiwmf: "edd14cc89944ec7a9b1a87cc6be6f371f1a56791d344d921f850e2106e6dee9e",
  "4701YgRXjkBcg6sL": "74c6bf732b76478e77072d21feca13b0bf0c664eccd2186902a63ba0d9effe59",
  c9wqBDmQiBie5q6Y: "4857d013c7502e4d074778b17122e85919bffa52741a0072e412dd3926853dcb",
  rmLBOdHrfkFym9MM: "6ed37f47fe59674b0c9f2c099ab983d4a847ca14d09aedf80f1608a11148c757",
  "3p0eIGbkmny71GlA": "275928c11b3c8b02e51c72653d060433e1d73a01458ef21b18e9a7f5cbd5205c",
  EQcQFGkYfMn5YJgx: "c419a49606182c98e06c369d0cfb9b66cc0f16bfdbc70490fa7daf2289144986",
  b6FvJAiokjdqIti4: "0bc37938a306a35f6c9f8ea53ccca14c5fc8b5575850f0cd15b352f4c3ce826e",
  tIjCgP8v3RY8UpgM: "fc8828dcdad4a09b7066b9008b108b77976ec4880d531da7761ded9a431bd208",
  FaLVVqpFQcDOtq45: "31a3837cc6705f37f95c27282ebeba71609b32204622245a6436258cd3d3497d",
  "t-_TS1e-0GzDAX02": "25c6df91a261bcb96d9e5152c9b0988398859c0e6f4ee5f08dd577fd3bd0300d",
  Ejb29qHnSOK0cIHY: "471332253b2f76c406e395230453a7a737708cca18461237cfce0239430cb071",
  jvPx8j8zLGQ3utZz: "be8c5f329070f40c39007bea13cee9503fe71599704cfe55c67d6eb51f5e6eb2",
  fghJGlv90qu8OJ36: "60656e9cd518454850a7e6ecacb953572a4a23f0a358fe3b4fb946b67f6bf934",
  KJpIQlbYrZPA4aLq: "b5bcbbce39a6332b2f79067be19688753c28c1fc4053bf41fd4608d54c24e1ee",
  evfxKSxpDIhmsNoq: "549f2a8dec851b967edbbd67b29d2da0799eec9ec2fefb5b0ec8aa99436d3eea",
  qG5BXOJYrKEnXLIX: "3d5590357dbd87b697a14573bbdc1f29e2abc5b6cd8a5e9ed3c98e325dede435",
  Sx8m6WdXBG06zwZT: "8756dddf95fa449d0e5a8649c6a242a460329c53e2f870bbe6ed744d0573a251",
  "s58clrg2fe0MO7Y-": "ab923d4fd9ed09954e3a91c61780bcd536f5bb5787e1d0541cb6ff56dd7ff531",
  VDwnGxAo68C8U8vC: "ccb1b88e3899db1cb7ba71007d08ed56dd743882214f0495b67feab89850ffe0",
  ax7dW1XB0eiMfHgO: "128eeba9b5f5c6d336e1246ae20a40765fba8e5ac268aafa691b98bce1e0acfd",
  F05gqkzX7WhKVpSL: "08159aad0d92cb391361abaf8c4bf6ac0d8358ab1514cce8cf5c89b448395ce5",
  BkuASiOJRrJEB5qA: "d32ad93e71b8c726a8f1aac62f276db82346fc1a74a02cfc18ce2b867cf20a07",
  PwgPEaweQILZdGc4: "91af1c0e9233b3069fab26eabd191e6be4d7825eff5d5e1ce3034fbd8f7fcf24",
  G5HLUsQd659UtRe7: "fba1a4349c3c86aabc58d6570a82fac0ed643e5e7aa97b52a3ede6b792e6d420",
  ALczEazoF4n6PmGl: "f4ebe6b59ebfa09339cb4c15c9c8f0af72fb6cecd9feb1f550dee0d95c8092c1",
  nGzMHMPAWGaJFHOo: "a0c3dcb91b2247eca56536be9ae8e8becc1c807b1136c5fe101552d6a155b24a",
  vjFyp2BcCyTlUmYb: "958ea94da14f46dd48c7f64adac11ed2ad2aa45f7ccd165dfebab5272664402e",
  bXwrkHhURL1VFJdG: "a879938aa9a2df0a8220bdadef88137929f71e887bd91e7db205bd5fa11661d2",
  "4SZHfMpw-p46Ywgs": "6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123",
  NIWIOv5vTi5eRMj8: "444378eb06b7c492b86e8fc7d13e4db1a3c0cf3e68891a960bf6f0a41a13ef35",
  NbpkqMVS3CJeq2j8: "97c7f8c253413574406ab80dd23f49c3ebb2517163b00a9bf86b9c4cf43e7e23",
  LMDIYE0Oa377Qh6Z: "45c582673cb20edb04ddcca2b5a8865ddfb0a82599efadb269021e87d20fbdd4",
  "40QrMVgAxFiUnP9f": "0de1098d1051686a138d068e83ff09deb5053328bc74ec9541a1fdb90bfc24da",
  d9XCyhjo4JhkHF1d: "eab20e4f159b48cfbc01b1885804e24f681f80e7a64f909182763a4e3361bee8",
  qIxlZ7Ei8KvWlyQH: "6e04b84d3ae8751b22bca0a4f63936f9cb648f4f2182b2d0788071ea1c0b68a1",
  _6Aslh2DxfmnRLmP: "beae9e4030efce0a935fcb0f807dc0784d598bcaa87ad4aacb047436b1eaa411",
  "0zLApsZfVLLNaEGl": "dc1341c8937af5534e6bbcc5c0fc5e7c10312229b59061228074f93683fe2261",
  gfP44RlHwr2kEwk7: "bcc207a73b7885e45b49ab633d3377a10158292e3a7cef9cd6764ad107f1cb9b",
  y9bQqIDnyxwqK01t: "21eade9d83b2e66b9364e1b6cd999a3a6704c000a71f27f34e05ace5cdfd58bb",
  GgfEkEJtxZR7gnpy: "eb3cd47418349e618408c16bea7153988b3ad04b41a6033039dd474a9a4dcd23",
  "gDT1nz7Ie36ZhL-C": "1980ab3c35fa98a25b5f3b5e643fd852e14ca8a12a4a26b06aaf1abf2a8c68b1",
  m9MxpY6IUGXtWp76: "a906ebf17e43fded12b3d6bd077abb2df33bc86eff51c1beeb82e5d416527db3",
  "6PWnV0Nq4wu7RVBT": "56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844",
  uem82D50GRv2Dwma: "d41a8f01d6e33450f1ce062d332914da10beee99e585dab531750706f187c48a",
  X6NceqF285Gr04gb: "4de75497fff3030168e8aa6dca23ffeb332b1bc8c25d0bf3507ceadac953ae9c",
  zUCxzrOrugTSis03: "ff1d0735b8b45710462b1d1f846da040f970c6eb62c7c2f36dbfb8e5bde74f1e",
  YyKcxPG7iIgS3jsK: "3169d74b47a54d1eb15e4c243f56393abe9fe90c7e1c308ecf96ee67618b152a",
  JOW0vchyswkQUMDS: "cc9ac1107b0ffce282374a19beb7bfa95847724e6b7afbac991b4ae4277d5e6d",
  Zn7g6NxLqXlJb7Qi: "baea0ea9506f3237a5ebfc61afb7c72dbd189c5603b199ef42fbb00dbda379e0",
  dME3IWyZBvmh1n1q: "09ab315c7f4b72b4d71e66cb756184cedfb1f14d222d096e115bf95bfe7b29dc",
};

export const PHONON_VOICE_FILES: ReadonlyMap<string, ModelFile> = new Map(
  PHONON_VOICES.map((voice) => [
    voice.id,
    {
      repo: "gradium/phonon-voices",
      revision: "0ee17205f254b5abc43b266c8a0f215565c352f7",
      path: `voices/${voice.id}.safetensors`,
      bytes: 256136,
      sha256: PHONON_VOICE_SHA256[voice.id] ?? "",
      role: "tts",
    },
  ]),
);

const SUPERTONIC_VOICE_PREFIX = "voice_styles/";

const ENGINE_FILES: Readonly<
  Record<TtsEngineId, { core: readonly ModelFile[]; voices: ReadonlyMap<string, ModelFile> }>
> = {
  "phonon-40m": { core: PHONON_TTS_MODEL_FILES, voices: PHONON_VOICE_FILES },
  "supertonic-3": {
    core: SUPERTONIC_MODEL_FILES.filter((file) => !file.path.startsWith(SUPERTONIC_VOICE_PREFIX)),
    voices: new Map(
      SUPERTONIC_MODEL_FILES.filter((file) => file.path.startsWith(SUPERTONIC_VOICE_PREFIX)).map((file) => [
        file.path.slice(SUPERTONIC_VOICE_PREFIX.length, -".json".length),
        file,
      ]),
    ),
  },
};

export function ttsWarmupVoice(engine: TtsEngineId): string {
  return supportedVoice(engine, "es", null);
}

export function ttsEngineFiles(engine: TtsEngineId): readonly ModelFile[] {
  return [...ENGINE_FILES[engine].core, ...ENGINE_FILES[engine].voices.values()];
}

export function ttsFilesFor(engine: TtsEngineId, voice: string): readonly ModelFile[] {
  const { core, voices } = ENGINE_FILES[engine];
  const wanted = new Set([ttsWarmupVoice(engine), voice]);
  return [...core, ...[...wanted].flatMap((id) => voices.get(id) ?? [])];
}

export const TTS_MODEL_FILES: readonly ModelFile[] = [
  ...PHONON_TTS_MODEL_FILES,
  ...PHONON_VOICE_FILES.values(),
  ...SUPERTONIC_MODEL_FILES,
];
