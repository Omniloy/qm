import { html, nothing, type TemplateResult } from "lit";
import { errMessage } from "../../chassis/src/errors.ts";
import { fieldSelect } from "./ui.ts";
import {
  ANNOUNCE_SCOPES,
  SUPERTONIC_VOICES,
  VOICE_LANGUAGES,
  type AnnounceScope,
  type ModelFile,
  type SupertonicVoice,
  type VoiceLanguage,
  type VoiceSettings,
} from "./voice-assistant/protocol.ts";
import {
  WAKE_PHRASE_MAX_CHARS,
  cleanWakePhrase,
  currentVoiceSettings,
  loadVoiceSettings,
  saveVoiceSettings,
} from "./voice-assistant/settings-store.ts";

export interface VoiceModelsApi {
  voiceModelStatus(): Promise<{
    gpu: { webgpu: boolean };
    files: readonly ModelFile[];
    totalBytes: number;
    missingBytes: number;
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
}

const COPY = {
  es: {
    title: "Asistente de voz",
    note: (size: string) =>
      `Habla con Omni diciendo la frase de activación. La voz se procesa en tu navegador; la primera vez descarga ${size}.`,
    off: "Desactivado",
    on: "Activado",
    models: "Modelos de voz",
    checking: "Comprobando los modelos de este dispositivo…",
    ready: (size: string) => `Descargados en este dispositivo (${size}).`,
    missing: (size: string) => `Faltan ${size} por descargar en este dispositivo.`,
    downloading: (percent: number) => `Descargando… ${percent}%`,
    unsupported: "Este navegador no admite WebGPU, que el asistente de voz necesita. Prueba con Chrome o Edge.",
    storage: "No hay espacio suficiente en este dispositivo para los modelos de voz.",
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
    voiceNames: (voice: SupertonicVoice) => `${voice.startsWith("F") ? "Femenina" : "Masculina"} ${voice.slice(1)}`,
    saveFailed: "No se han podido guardar los ajustes de voz.",
  },
  en: {
    title: "Voice assistant",
    note: (size: string) =>
      `Talk to Omni by saying the wake phrase. Speech is processed in your browser; the first time it downloads ${size}.`,
    off: "Off",
    on: "On",
    models: "Voice models",
    checking: "Checking the models on this device…",
    ready: (size: string) => `Downloaded on this device (${size}).`,
    missing: (size: string) => `${size} still to download on this device.`,
    downloading: (percent: number) => `Downloading… ${percent}%`,
    unsupported: "This browser does not support WebGPU, which the voice assistant needs. Try Chrome or Edge.",
    storage: "There is not enough storage on this device for the voice models.",
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
    voiceNames: (voice: SupertonicVoice) => `${voice.startsWith("F") ? "Female" : "Male"} ${voice.slice(1)}`,
    saveFailed: "Couldn't save the voice settings.",
  },
} as const;

const LANGUAGE_NAMES: Record<VoiceLanguage, string> = { es: "Español", en: "English" };

const models: ModelState = { phase: "unknown", files: [], totalBytes: 0, missingBytes: 0, progress: 0, error: "" };
let download: AbortController | null = null;
let settingsError = "";
let wakeError = "";
let loaded = false;

const loadVoiceModule = (): Promise<VoiceModelsApi> => import("./voice-assistant/index.ts");

export function formatBytes(bytes: number, language: VoiceLanguage): string {
  const gb = bytes / 1e9;
  const value = gb >= 1 ? gb.toFixed(1) : (bytes / 1e6).toFixed(0);
  return `${language === "es" ? value.replace(".", ",") : value} ${gb >= 1 ? "GB" : "MB"}`;
}

const TYPICAL_DOWNLOAD_BYTES = 1_300_000_000;

function sizeLabel(language: VoiceLanguage): string {
  return formatBytes(models.totalBytes || TYPICAL_DOWNLOAD_BYTES, language);
}

async function checkModels(api: () => Promise<VoiceModelsApi>, redraw: () => void): Promise<void> {
  if (models.phase === "checking" || models.phase === "downloading") return;
  models.phase = "checking";
  redraw();
  try {
    const status = await (await api()).voiceModelStatus();
    models.files = status.files;
    models.totalBytes = status.totalBytes;
    models.missingBytes = status.missingBytes;
    models.phase = status.missingBytes > 0 ? "missing" : "ready";
    if (!status.gpu.webgpu) models.phase = "unsupported";
    models.error = "";
  } catch (error) {
    models.phase = "error";
    models.error = errMessage(error);
  }
  redraw();
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
      models.error = errMessage(error) === "voice_storage_full" ? copy.storage : errMessage(error);
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

async function save(patch: Partial<VoiceSettings>, redraw: () => void): Promise<void> {
  settingsError = "";
  redraw();
  try {
    await saveVoiceSettings(patch);
  } catch {
    settingsError = COPY[currentVoiceSettings().language].saveFailed;
  }
  redraw();
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
  if (!loaded) {
    loaded = true;
    void loadVoiceSettings().then(redraw, () => undefined);
  }
  if (models.phase === "unknown") void checkModels(api, redraw);
  const settings = currentVoiceSettings();
  const language = settings.language;
  const copy = COPY[language];
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
            ${modelsRow(copy, language, api, redraw)} ${wakeRow(copy, settings, redraw)}
            <div class="settings-row">
              <div class="settings-row-copy"><div class="settings-row-title">${copy.language}</div></div>
              ${choice(
                copy.language,
                VOICE_LANGUAGES,
                language,
                (v) => LANGUAGE_NAMES[v],
                (v) => void save({ language: v }, redraw),
              )}
            </div>
            <div class="settings-row">
              <div class="settings-row-copy">
                <div class="settings-row-title">${copy.announce}</div>
                <div class="settings-row-note">${copy.announceNote}</div>
              </div>
              ${choice(
                copy.announce,
                ANNOUNCE_SCOPES,
                settings.announceScope,
                (v) => copy.scopes[v],
                (v) => void save({ announceScope: v }, redraw),
              )}
            </div>
            <div class="settings-row">
              <div class="settings-row-copy"><div class="settings-row-title">${copy.voice}</div></div>
              ${fieldSelect({
                className: "voice-voice-select",
                ariaLabel: copy.voice,
                value: settings.voice,
                options: SUPERTONIC_VOICES.map(
                  (voice) =>
                    html`<option value=${voice} ?selected=${voice === settings.voice}>
                      ${copy.voiceNames(voice)}
                    </option>`,
                ),
                onChange: (value) => {
                  if ((SUPERTONIC_VOICES as readonly string[]).includes(value))
                    void save({ voice: value as SupertonicVoice }, redraw);
                },
              })}
            </div>
          `
        : nothing
    }
  `;
}
