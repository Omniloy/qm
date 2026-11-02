import { html, nothing, type TemplateResult } from "lit";
import { errMessage } from "../../chassis/src/errors.ts";
import { fieldSelect } from "./ui.ts";
import {
  ANNOUNCE_SCOPES,
  ASR_ENGINE_IDS,
  MIC_MODES,
  PTT_STYLES,
  TTS_ENGINE_IDS,
  VOICE_LANGUAGES,
  type AnnounceScope,
  type AsrEngineId,
  type MicMode,
  type ModelFile,
  type PttStyle,
  type TtsEngineId,
  type VoiceLanguage,
  type VoiceSettings,
} from "./voice-assistant/protocol.ts";
import {
  WAKE_PHRASE_MAX_CHARS,
  cleanWakePhrase,
  currentVoiceSettings,
  loadVoiceSettings,
  onVoiceSettingsChange,
  saveVoiceSettings,
} from "./voice-assistant/settings-store.ts";
import { ALL_VOICES_OPTION, languageForVoice, pickerVoices, voiceOptions } from "./voice-assistant/voice-picker.ts";

export interface VoiceModelsApi {
  voiceModelStatus(settings: VoiceSettings): Promise<{
    gpu: { webgpu: boolean };
    files: readonly ModelFile[];
    totalBytes: number;
    missingBytes: number;
    asrEngine: AsrEngineId;
  }>;
  downloadVoiceModels(
    files: readonly ModelFile[],
    onProgress: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  deleteVoiceModels(): Promise<void>;
  startVoice(takeover?: boolean): Promise<void>;
  stopVoice(): void;
}

type ModelPhase = "unknown" | "checking" | "missing" | "ready" | "downloading" | "unsupported" | "error";

interface ModelState {
  phase: ModelPhase;
  files: readonly ModelFile[];
  totalBytes: number;
  missingBytes: number;
  progress: number;
  error: string;
  asrEngine: AsrEngineId | null;
}

const COPY = {
  es: {
    title: "Asistente de voz",
    note: (size: string) =>
      `Habla con Omni diciendo la frase de activación o pulsando para hablar. La voz se procesa en tu navegador; la primera vez descarga ${size}.`,
    off: "Desactivado",
    on: "Activado",
    models: "Modelos de voz",
    checking: "Comprobando los modelos de este dispositivo…",
    ready: (size: string) => `Descargados en este dispositivo (${size}).`,
    missing: (size: string) => `Faltan ${size} por descargar en este dispositivo.`,
    downloading: (percent: number) => `Descargando… ${percent}%`,
    unsupported: "Este navegador no admite WebGPU, que el asistente de voz necesita. Prueba con Chrome o Edge.",
    storage: "No hay espacio suficiente en este dispositivo para los modelos de voz.",
    unavailable: "El servidor no tiene acceso a estos modelos de voz. Pide que configuren HF_TOKEN o elige otro motor.",
    download: "Descargar",
    cancel: "Cancelar",
    remove: "Eliminar",
    retry: "Reintentar",
    wake: "Frase de activación",
    wakeNote: "Lo que dices para que Omni empiece a escucharte.",
    wakeInvalid: `Escribe una frase de hasta ${WAKE_PHRASE_MAX_CHARS} caracteres.`,
    language: "Idioma de voz",
    announce: "Avisos de tareas",
    announceNote: "Omni te avisa en voz alta cuando una tarea termina o necesita tu aprobación.",
    scopes: { all: "Todas mis tareas", voice: "Solo las de voz" } satisfies Record<AnnounceScope, string>,
    voice: "Voz",
    micMode: "Modo de micrófono",
    micModeNote: "Con el micrófono abierto, Omni espera la frase de activación. Si no, pulsa para hablar.",
    micModes: { open: "Micrófono abierto", push: "Pulsar para hablar" } satisfies Record<MicMode, string>,
    ptt: "Pulsar para hablar",
    pttNote: "Usa la barra espaciadora fuera de los campos de texto, o el orbe.",
    pttStyles: { hold: "Mantener pulsado", toggle: "Pulsar para empezar y parar" } satisfies Record<PttStyle, string>,
    tts: "Voz sintética",
    ttsEngines: { "phonon-40m": "Phonon 40M (por defecto)", "supertonic-3": "Supertonic 3" } satisfies Record<
      TtsEngineId,
      string
    >,
    asr: "Reconocimiento de voz",
    asrEngines: { "phonon-2.5": "Phonon 2.5 (por defecto)", "qwen3-asr-0.6b": "Qwen3-ASR 0.6B" } satisfies Record<
      AsrEngineId,
      string
    >,
    asrFallback: (wanted: string, used: string) => `${wanted} no está disponible en este dispositivo; se usa ${used}.`,
    saveFailed: "No se han podido guardar los ajustes de voz.",
  },
  en: {
    title: "Voice assistant",
    note: (size: string) =>
      `Talk to Omni by saying the wake phrase or pushing to talk. Speech is processed in your browser; the first time it downloads ${size}.`,
    off: "Off",
    on: "On",
    models: "Voice models",
    checking: "Checking the models on this device…",
    ready: (size: string) => `Downloaded on this device (${size}).`,
    missing: (size: string) => `${size} still to download on this device.`,
    downloading: (percent: number) => `Downloading… ${percent}%`,
    unsupported: "This browser does not support WebGPU, which the voice assistant needs. Try Chrome or Edge.",
    storage: "There is not enough storage on this device for the voice models.",
    unavailable:
      "The server has no access to these voice models. Ask for HF_TOKEN to be configured, or pick another engine.",
    download: "Download",
    cancel: "Cancel",
    remove: "Remove",
    retry: "Retry",
    wake: "Wake phrase",
    wakeNote: "What you say to make Omni start listening.",
    wakeInvalid: `Enter a phrase of up to ${WAKE_PHRASE_MAX_CHARS} characters.`,
    language: "Voice language",
    announce: "Task announcements",
    announceNote: "Omni tells you out loud when a task finishes or needs your approval.",
    scopes: { all: "All my tasks", voice: "Voice tasks only" } satisfies Record<AnnounceScope, string>,
    voice: "Voice",
    micMode: "Microphone mode",
    micModeNote: "With the open mic, Omni waits for the wake phrase. Otherwise, push to talk.",
    micModes: { open: "Open mic", push: "Push to talk" } satisfies Record<MicMode, string>,
    ptt: "Push to talk",
    pttNote: "Use Space outside text fields, or the orb.",
    pttStyles: { hold: "Hold to talk", toggle: "Press to start and stop" } satisfies Record<PttStyle, string>,
    tts: "Speech voice engine",
    ttsEngines: { "phonon-40m": "Phonon 40M (default)", "supertonic-3": "Supertonic 3" } satisfies Record<
      TtsEngineId,
      string
    >,
    asr: "Speech recognition",
    asrEngines: { "phonon-2.5": "Phonon 2.5 (default)", "qwen3-asr-0.6b": "Qwen3-ASR 0.6B" } satisfies Record<
      AsrEngineId,
      string
    >,
    asrFallback: (wanted: string, used: string) =>
      `${wanted} is not available on this device; ${used} is used instead.`,
    saveFailed: "Couldn't save the voice settings.",
  },
} as const;

const LANGUAGE_NAMES: Record<VoiceLanguage, string> = { es: "Español", en: "English" };

const ASR_NAMES: Record<AsrEngineId, string> = { "phonon-2.5": "Phonon 2.5", "qwen3-asr-0.6b": "Qwen3-ASR 0.6B" };

const models: ModelState = {
  phase: "unknown",
  files: [],
  totalBytes: 0,
  missingBytes: 0,
  progress: 0,
  error: "",
  asrEngine: null,
};
let download: AbortController | null = null;
let settingsError = "";
let wakeError = "";
let loaded = false;
let allVoices = false;
let redrawRows: () => void = () => undefined;

const loadVoiceModule = (): Promise<VoiceModelsApi> => import("./voice-assistant/index.ts");

export function formatBytes(bytes: number, language: VoiceLanguage): string {
  const gb = bytes / 1e9;
  const mb = bytes / 1e6;
  const value = gb >= 1 ? gb.toFixed(1) : mb.toFixed(mb >= 10 ? 0 : 1);
  return `${language === "es" ? value.replace(".", ",") : value} ${gb >= 1 ? "GB" : "MB"}`;
}

const TYPICAL_DOWNLOAD_BYTES = 1_000_000_000;

function sizeLabel(language: VoiceLanguage): string {
  return formatBytes(models.totalBytes || TYPICAL_DOWNLOAD_BYTES, language);
}

async function checkModels(api: () => Promise<VoiceModelsApi>, redraw: () => void): Promise<void> {
  if (models.phase === "checking" || models.phase === "downloading") return;
  models.phase = "checking";
  redraw();
  try {
    const status = await (await api()).voiceModelStatus(currentVoiceSettings());
    models.files = status.files;
    models.totalBytes = status.totalBytes;
    models.missingBytes = status.missingBytes;
    models.asrEngine = status.asrEngine;
    models.phase = status.missingBytes > 0 ? "missing" : "ready";
    if (!status.gpu.webgpu) models.phase = "unsupported";
    models.error = "";
  } catch (error) {
    models.phase = "error";
    models.error = errMessage(error);
  }
  redraw();
}

function downloadError(message: string, copy: (typeof COPY)[VoiceLanguage]): string {
  if (message === "voice_storage_full") return copy.storage;
  return /^model_download_failed:.*:503$/.test(message) ? copy.unavailable : message;
}

async function downloadModels(
  api: () => Promise<VoiceModelsApi>,
  redraw: () => void,
  startAfter: boolean,
): Promise<void> {
  if (models.phase !== "missing" && models.phase !== "error") return;
  const controller = new AbortController();
  download = controller;
  models.phase = "downloading";
  models.progress = 0;
  models.error = "";
  redraw();
  try {
    const voice = await api();
    await voice.downloadVoiceModels(
      models.files,
      (fraction) => {
        models.progress = fraction;
        redraw();
      },
      controller.signal,
    );
    models.phase = "ready";
    models.missingBytes = 0;
    if (startAfter && currentVoiceSettings().enabled) void voice.startVoice(true);
  } catch (error) {
    if (controller.signal.aborted) {
      models.phase = "missing";
    } else {
      models.phase = "error";
      const copy = COPY[currentVoiceSettings().language];
      models.error = downloadError(errMessage(error), copy);
    }
  } finally {
    if (download === controller) download = null;
  }
  redraw();
}

async function removeModels(api: () => Promise<VoiceModelsApi>, redraw: () => void): Promise<void> {
  try {
    const voice = await api();
    voice.stopVoice();
    await voice.deleteVoiceModels();
  } catch (error) {
    models.error = errMessage(error);
  }
  models.phase = "unknown";
  await checkModels(api, redraw);
}

const MODEL_SETTINGS: ReadonlySet<keyof VoiceSettings> = new Set(["voice", "language", "ttsEngine", "asrEngine"]);

async function save(
  patch: Partial<VoiceSettings>,
  redraw: () => void,
  api?: () => Promise<VoiceModelsApi>,
): Promise<void> {
  settingsError = "";
  redraw();
  try {
    await saveVoiceSettings(patch);
  } catch {
    settingsError = COPY[currentVoiceSettings().language].saveFailed;
  }
  redraw();
  const changesModels = Object.keys(patch).some((key) => MODEL_SETTINGS.has(key as keyof VoiceSettings));
  if (api && changesModels && models.phase !== "downloading") {
    models.phase = "unknown";
    await checkModels(api, redraw);
  }
}

function requestNotifications(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => "default");
}

async function setEnabled(enabled: boolean, api: () => Promise<VoiceModelsApi>, redraw: () => void): Promise<void> {
  if (enabled === currentVoiceSettings().enabled) return;
  if (enabled) requestNotifications();
  else download?.abort();
  await save({ enabled }, redraw);
  if (!enabled || !currentVoiceSettings().enabled) return;
  if (models.phase === "unknown" || models.phase === "checking") await checkModels(api, redraw);
  if (models.phase === "missing") await downloadModels(api, redraw, true);
  else if (models.phase === "ready") void (await api()).startVoice(true);
}

function choice<T extends string>(
  label: string,
  values: readonly T[],
  current: T,
  name: (value: T) => string,
  pick: (value: T) => void,
): TemplateResult {
  return html`<div class="settings-choice" role="radiogroup" aria-label=${label}>
    ${values.map(
      (value) =>
        html`<button
          class="settings-choice-option ${current === value ? "selected" : ""}"
          type="button"
          role="radio"
          aria-checked=${current === value ? "true" : "false"}
          data-value=${value}
          @click=${() => pick(value)}
        >
          <span>${name(value)}</span>
        </button>`,
    )}
  </div>`;
}

function settingRow(title: string, note: string | null, control: TemplateResult): TemplateResult {
  return html`<div class="settings-row">
    <div class="settings-row-copy">
      <div class="settings-row-title">${title}</div>
      ${note ? html`<div class="settings-row-note">${note}</div>` : nothing}
    </div>
    ${control}
  </div>`;
}

function engineSelect<T extends string>(
  className: string,
  label: string,
  values: readonly T[],
  current: T,
  name: (value: T) => string,
  pick: (value: T) => void,
): TemplateResult {
  return fieldSelect({
    className,
    ariaLabel: label,
    value: current,
    options: values.map((value) => html`<option value=${value} ?selected=${value === current}>${name(value)}</option>`),
    onChange: (value) => {
      const picked = values.find((option) => option === value);
      if (picked && picked !== current) pick(picked);
    },
  });
}

function modelAction(
  copy: (typeof COPY)[VoiceLanguage],
  api: () => Promise<VoiceModelsApi>,
  redraw: () => void,
): TemplateResult | typeof nothing {
  if (models.phase === "missing" || models.phase === "error")
    return html`<button
      class="btn settings-row-action voice-models-download"
      type="button"
      @click=${() => void downloadModels(api, redraw, true)}
    >
      ${models.phase === "error" ? copy.retry : copy.download}
    </button>`;
  if (models.phase === "downloading")
    return html`<button
      class="btn settings-row-action voice-models-cancel"
      type="button"
      @click=${() => download?.abort()}
    >
      ${copy.cancel}
    </button>`;
  if (models.phase === "ready")
    return html`<button
      class="settings-theme-link voice-models-remove"
      type="button"
      @click=${() => void removeModels(api, redraw)}
    >
      ${copy.remove}
    </button>`;
  return nothing;
}

function modelsRow(
  copy: (typeof COPY)[VoiceLanguage],
  language: VoiceLanguage,
  api: () => Promise<VoiceModelsApi>,
  redraw: () => void,
): TemplateResult {
  const percent = Math.floor(models.progress * 100);
  const notes: Record<ModelPhase, string | TemplateResult> = {
    unknown: copy.checking,
    checking: copy.checking,
    ready: copy.ready(formatBytes(models.totalBytes, language)),
    missing: copy.missing(formatBytes(models.missingBytes, language)),
    downloading: copy.downloading(percent),
    unsupported: copy.unsupported,
    error: html`<span class="settings-row-error" role="alert">${models.error}</span>`,
  };
  const note = notes[models.phase];
  const action = modelAction(copy, api, redraw);
  return html`<div class="settings-row voice-models-row">
    <div class="settings-row-copy">
      <div class="settings-row-title">${copy.models}</div>
      <div class="settings-row-note">${note}</div>
      ${
        models.phase === "downloading"
          ? html`<progress
              class="voice-models-progress"
              max="100"
              .value=${percent}
              aria-label=${copy.models}
            ></progress>`
          : nothing
      }
    </div>
    ${action}
  </div>`;
}

function wakeRow(copy: (typeof COPY)[VoiceLanguage], settings: VoiceSettings, redraw: () => void): TemplateResult {
  const commit = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const phrase = cleanWakePhrase(input.value);
    if (!phrase) {
      wakeError = copy.wakeInvalid;
      redraw();
      return;
    }
    wakeError = "";
    input.value = phrase;
    if (phrase !== settings.wakePhrase) void save({ wakePhrase: phrase }, redraw);
    else redraw();
  };
  return html`<div class="settings-row">
    <div class="settings-row-copy">
      <div class="settings-row-title">${copy.wake}</div>
      <div class="settings-row-note">
        ${wakeError ? html`<span class="settings-row-error" role="alert">${wakeError}</span>` : copy.wakeNote}
      </div>
    </div>
    <input
      class="settings-voice-input voice-wake-input"
      type="text"
      autocomplete="off"
      maxlength=${WAKE_PHRASE_MAX_CHARS}
      aria-label=${copy.wake}
      .value=${settings.wakePhrase}
      @change=${commit}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  </div>`;
}

export function voiceSettingsRows(
  redraw: () => void,
  api: () => Promise<VoiceModelsApi> = loadVoiceModule,
): TemplateResult {
  redrawRows = redraw;
  if (!loaded) {
    loaded = true;
    onVoiceSettingsChange(() => redrawRows());
    void loadVoiceSettings().then(redraw, () => undefined);
  }
  if (models.phase === "unknown") void checkModels(api, redraw);
  const settings = currentVoiceSettings();
  const language = settings.language;
  const copy = COPY[language];
  const voices = pickerVoices(settings);
  return html`
    <div class="settings-row voice-enable-row">
      <div class="settings-row-copy">
        <div class="settings-row-title">${copy.title}</div>
        <div class="settings-row-note">${copy.note(sizeLabel(language))}</div>
        ${settingsError ? html`<div class="settings-row-error" role="alert">${settingsError}</div>` : nothing}
      </div>
      ${choice(
        copy.title,
        ["off", "on"] as const,
        settings.enabled ? "on" : "off",
        (v) => (v === "on" ? copy.on : copy.off),
        (v) => void setEnabled(v === "on", api, redraw),
      )}
    </div>
    ${
      settings.enabled
        ? html`
            ${modelsRow(copy, language, api, redraw)}
            ${settingRow(
              copy.micMode,
              copy.micModeNote,
              choice(
                copy.micMode,
                MIC_MODES,
                settings.micMode,
                (v) => copy.micModes[v],
                (v) => void save({ micMode: v }, redraw),
              ),
            )}
            ${
              settings.micMode === "push"
                ? settingRow(
                    copy.ptt,
                    copy.pttNote,
                    choice(
                      copy.ptt,
                      PTT_STYLES,
                      settings.pttStyle,
                      (v) => copy.pttStyles[v],
                      (v) => void save({ pttStyle: v }, redraw),
                    ),
                  )
                : wakeRow(copy, settings, redraw)
            }
            ${settingRow(
              copy.language,
              null,
              choice(
                copy.language,
                VOICE_LANGUAGES,
                language,
                (v) => LANGUAGE_NAMES[v],
                (v) => void save({ language: v }, redraw, api),
              ),
            )}
            ${settingRow(
              copy.announce,
              copy.announceNote,
              choice(
                copy.announce,
                ANNOUNCE_SCOPES,
                settings.announceScope,
                (v) => copy.scopes[v],
                (v) => void save({ announceScope: v }, redraw),
              ),
            )}
            ${settingRow(
              copy.voice,
              null,
              fieldSelect({
                className: "voice-voice-select",
                ariaLabel: copy.voice,
                value: settings.voice,
                options: voiceOptions(voices, { language, voice: settings.voice, showAll: allVoices }),
                onChange: (value) => {
                  if (value === ALL_VOICES_OPTION) {
                    allVoices = true;
                    redraw();
                    return;
                  }
                  allVoices = false;
                  if (value !== settings.voice && voices.some((voice) => voice.id === value))
                    void save({ voice: value, language: languageForVoice(settings, value) }, redraw, api);
                  else redraw();
                },
              }),
            )}
            ${settingRow(
              copy.tts,
              null,
              engineSelect(
                "voice-tts-select",
                copy.tts,
                TTS_ENGINE_IDS,
                settings.ttsEngine,
                (v) => copy.ttsEngines[v],
                (v) => void save({ ttsEngine: v }, redraw, api),
              ),
            )}
            ${settingRow(
              copy.asr,
              models.asrEngine && models.asrEngine !== settings.asrEngine
                ? copy.asrFallback(ASR_NAMES[settings.asrEngine], ASR_NAMES[models.asrEngine])
                : null,
              engineSelect(
                "voice-asr-select",
                copy.asr,
                ASR_ENGINE_IDS,
                settings.asrEngine,
                (v) => copy.asrEngines[v],
                (v) => void save({ asrEngine: v }, redraw, api),
              ),
            )}
          `
        : nothing
    }
  `;
}
