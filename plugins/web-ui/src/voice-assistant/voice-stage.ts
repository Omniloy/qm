import { html, nothing, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import { ArrowUp, Keyboard, Mic, MicOff, X } from "lucide";
import { markdown } from "../message-markdown.ts";
import { icon } from "../ui.ts";
import { ORB_HOLD_END_EVENT, ORB_HOLD_START_EVENT, ORB_PRESS_EVENT } from "./orb-element.ts";
import {
  MIC_MODES,
  ORB_INPUTS_BY_STATE,
  VOICE_LANGUAGES,
  type MicMode,
  type VoiceLanguage,
  type VoiceStageHandlers,
  type VoiceStageView,
  type VoiceState,
} from "./protocol.ts";
import { ALL_VOICES_OPTION, voiceOptions } from "./voice-picker.ts";
import "./voice.css";

export interface VoiceStage {
  update(view: VoiceStageView): void;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  destroy(): void;
}

export interface KaraokeWord {
  text: string;
  on: boolean;
}

const COPY = {
  es: {
    dialog: "Asistente de voz",
    openStage: "Abrir asistente de voz",
    start: "Activar asistente de voz",
    loading: "Preparando el asistente de voz",
    talk: "Hablar ahora",
    stop: "Terminar de hablar",
    interrupt: "Interrumpir",
    mute: "Silenciar micrófono",
    type: "Escribir",
    placeholder: "Escribe tu mensaje",
    send: "Enviar",
    close: "Cerrar",
    language: "Idioma",
    voice: "Voz",
    micMode: "Micrófono",
    modes: { open: "Micrófono abierto", push: "Pulsar para hablar", off: "Sin micrófono" },
    transcript: "Conversación con Omni",
    holdToTalk: "Mantén pulsado para hablar",
    releaseToSend: "Suelta para enviar",
    tapToTalk: "Pulsa para hablar",
    tapToSend: "Pulsa para enviar",
  },
  en: {
    dialog: "Voice assistant",
    openStage: "Open voice assistant",
    start: "Turn on voice assistant",
    loading: "Getting the voice assistant ready",
    talk: "Talk now",
    stop: "Stop talking",
    interrupt: "Interrupt",
    mute: "Mute microphone",
    type: "Type instead",
    placeholder: "Type your message",
    send: "Send",
    close: "Close",
    language: "Language",
    voice: "Voice",
    micMode: "Microphone",
    modes: { open: "Open mic", push: "Push to talk", off: "Mic off" },
    transcript: "Conversation with Omni",
    holdToTalk: "Hold to talk",
    releaseToSend: "Release to send",
    tapToTalk: "Press to talk",
    tapToSend: "Press to send",
  },
} satisfies Record<VoiceLanguage, Record<string, string | Record<MicMode, string>>>;

type Copy = (typeof COPY)[VoiceLanguage];

const LANGUAGE_NAMES: Record<VoiceLanguage, string> = { es: "Español", en: "English" };

const TYPING_STATES: ReadonlySet<VoiceState> = new Set(["sleeping", "listening", "thinking", "speaking"]);

const PRESSED_STATES: ReadonlySet<VoiceState> = new Set(["listening", "thinking", "speaking"]);

function orbPressed(view: VoiceStageView): boolean {
  if (view.micMode === "off") return view.state === "thinking" || view.state === "speaking";
  return view.micMode === "push" ? view.pttActive : PRESSED_STATES.has(view.state);
}

const EMPTY_VIEW: VoiceStageView = {
  state: "off",
  language: "es",
  voice: "",
  voices: [],
  micMode: "open",
  pttStyle: "hold",
  pttActive: false,
  muted: false,
  status: "",
  captions: { user: null, agent: null },
  transcript: [],
  awaitingUser: false,
  announcement: "",
};

function sentenceEnd(text: string, from: number): number {
  const re = /[.!?…]["')\]]*(\s|$)/g;
  re.lastIndex = Math.max(0, from);
  const m = re.exec(text);
  return m ? m.index + m[0].trimEnd().length : text.length;
}

export function karaokeWords(text: string, spokenChars: number): KaraokeWord[] {
  const spoken = Math.max(0, Math.min(spokenChars, text.length));
  const words = text.slice(0, sentenceEnd(text, spoken)).split(/\s+/).filter(Boolean);
  const result: KaraokeWord[] = [];
  let cursor = 0;
  for (const word of words) {
    const end = text.indexOf(word, cursor) + word.length;
    cursor = end;
    result.push({ text: word, on: end <= spoken });
  }
  return result;
}

function orbLabel(view: VoiceStageView, copy: Copy): string {
  const { state } = view;
  if (state === "off") return copy.start;
  if (state === "arming") return copy.loading;
  if (view.micMode === "off") return state === "thinking" || state === "speaking" ? copy.interrupt : copy.type;
  if (view.micMode === "push") {
    if (view.pttStyle === "hold") return view.pttActive ? copy.releaseToSend : copy.holdToTalk;
    return view.pttActive ? copy.tapToSend : copy.tapToTalk;
  }
  if (state === "sleeping") return copy.talk;
  if (state === "listening") return copy.stop;
  return copy.interrupt;
}

export function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.closest("[contenteditable]:not([contenteditable='false']), [role='textbox']") !== null
  );
}

const SPACE_CONTROLS =
  "button, a[href], summary, [role='button'], [role='radio'], [role='switch'], [role='tab'], [role='checkbox'], [role='menuitem'], [role='option']";

export function handlesSpace(target: EventTarget | null): boolean {
  return editableTarget(target) || (target instanceof HTMLElement && target.closest(SPACE_CONTROLS) !== null);
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  ];
}

export function mountVoiceStage(host: HTMLElement, handlers: VoiceStageHandlers): VoiceStage {
  let view = EMPTY_VIEW;
  let copy: Copy = COPY[view.language];
  let open = false;
  let typing = false;
  let draft = "";
  let returnFocus: HTMLElement | null = null;
  let destroyed = false;
  let allVoices = false;
  let holding = false;

  const stageRoot = () => host.querySelector<HTMLElement>(".voice-stage");

  const focusOrb = () => {
    requestAnimationFrame(() => {
      if (!open) return;
      (
        host.querySelector<HTMLElement>(".voice-stage-orb .qm-voice-orb-button") ??
        host.querySelector<HTMLElement>(".voice-stage")
      )?.focus();
    });
  };

  const onOrbPress = (e: Event) => {
    const target = e.target as HTMLElement;
    if (target.closest(".voice-dock-orb")) stage.open();
    else if (view.micMode === "off" && !orbPressed(view)) startTyping();
    else handlers.onOrbPress();
  };

  const onHoldStart = () => {
    holding = true;
    handlers.onPttDown();
  };
  const onHoldEnd = () => {
    if (!holding) return;
    holding = false;
    handlers.onPttUp();
  };

  const requestClose = () => {
    handlers.onClose();
    stage.close();
  };

  const startTyping = () => {
    if (!TYPING_STATES.has(view.state)) return;
    typing = true;
    paint();
    requestAnimationFrame(() => host.querySelector<HTMLInputElement>(".voice-type-input")?.focus());
  };

  const stopTyping = () => {
    typing = false;
    draft = "";
    paint();
    host.querySelector<HTMLElement>(".voice-type-toggle")?.focus();
  };

  const submitTyping = (e: Event) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    handlers.onTypeInstead(text);
    typing = false;
    draft = "";
    paint();
  };

  const onDraft = (e: Event) => {
    draft = (e.target as HTMLInputElement).value;
    paint();
  };

  const onLanguage = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    const language = VOICE_LANGUAGES.find((option) => option === value);
    if (language && language !== view.language) handlers.onLanguage(language);
  };

  const onVoice = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value === ALL_VOICES_OPTION) {
      allVoices = true;
      paint();
      return;
    }
    allVoices = false;
    if (value !== view.voice && view.voices.some((voice) => voice.id === value)) handlers.onVoice(value);
    else paint();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (!open || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const root = stageRoot();
    if (e.key === "Escape") {
      e.preventDefault();
      if (typing) stopTyping();
      else requestClose();
      return;
    }
    if (e.key === "Tab" && root) {
      const items = focusables(root);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (editableTarget(e.target)) return;
    if ((e.key === "m" || e.key === "M") && view.micMode !== "off") {
      e.preventDefault();
      handlers.onToggleMute();
      return;
    }
    if (e.key === " " && view.micMode === "open" && !handlesSpace(e.target)) {
      e.preventDefault();
      handlers.onOrbPress();
    }
  };

  const orbTemplate = (size: "stage" | "dock") => {
    const inputs = ORB_INPUTS_BY_STATE[view.state];
    return html`<qm-voice-orb
      size=${size}
      .status=${inputs.status}
      .mode=${inputs.mode}
      .muted=${view.muted}
      .label=${size === "dock" ? copy.openStage : orbLabel(view, copy)}
      .pressed=${size === "dock" ? false : orbPressed(view)}
      .holdToTalk=${size === "stage" && view.micMode === "push" && view.pttStyle === "hold" && view.state !== "off"}
    ></qm-voice-orb>`;
  };

  const captionsTemplate = () => {
    const { user, agent } = view.captions;
    return html`<div class="voice-region" aria-hidden="true">
      <div class="voice-captions">
        <div class="voice-captions-flow">
          ${user && !user.final ? html`<p class="voice-caption-user is-partial">${user.text}</p>` : nothing}
          ${
            agent && view.state === "speaking"
              ? html`<p class="voice-caption-agent">
                  ${karaokeWords(agent.text, agent.spokenChars).map(
                    (word, i) =>
                      html`<span class="voice-word ${word.on ? "is-on" : ""}">${i > 0 ? " " : ""}${word.text}</span>`,
                  )}
                </p>`
              : nothing
          }
        </div>
      </div>
    </div>`;
  };

  const transcriptTemplate = () =>
    view.transcript.length
      ? html`<section class="voice-transcript" aria-label=${copy.transcript} aria-live="polite">
          <div class="voice-transcript-log">
            ${repeat(
              view.transcript,
              (entry) => entry.id,
              (entry) =>
                entry.role === "assistant"
                  ? html`<div class="voice-entry voice-entry-assistant">${markdown(entry.text)}</div>`
                  : html`<p class="voice-entry voice-entry-user" dir="auto">${entry.text}</p>`,
            )}
          </div>
        </section>`
      : nothing;

  const dockTemplate = () =>
    html`<div class="voice-dock" data-typing=${typing ? "true" : "false"}>
      <div class="voice-dock-pill">
        ${
          typing
            ? html`<form class="voice-type" @submit=${submitTyping}>
                <input
                  class="voice-type-input"
                  type="text"
                  autocomplete="off"
                  enterkeyhint="send"
                  aria-label=${copy.placeholder}
                  placeholder=${copy.placeholder}
                  .value=${live(draft)}
                  @input=${onDraft}
                />
                <button
                  type="submit"
                  class="voice-dock-button is-send"
                  aria-label=${copy.send}
                  ?disabled=${!draft.trim()}
                >
                  ${icon(ArrowUp, 18)}
                </button>
              </form>`
            : html`${
                  view.micMode === "off"
                    ? nothing
                    : html`<button
                        type="button"
                        class="voice-dock-button voice-mute-toggle"
                        aria-label=${copy.mute}
                        aria-pressed=${view.muted ? "true" : "false"}
                        aria-keyshortcuts="M"
                        data-alert=${view.muted ? "true" : "false"}
                        @click=${() => handlers.onToggleMute()}
                      >
                        ${icon(view.muted ? MicOff : Mic, 20)}
                      </button>`
                }
                ${
                  TYPING_STATES.has(view.state)
                    ? html`<button
                        type="button"
                        class="voice-dock-button voice-type-toggle"
                        aria-label=${copy.type}
                        @click=${startTyping}
                      >
                        ${icon(Keyboard, 20)}
                      </button>`
                    : nothing
                }
                <select
                  class="voice-dock-select voice-language-select"
                  aria-label=${copy.language}
                  .value=${live(view.language)}
                  @change=${onLanguage}
                >
                  ${VOICE_LANGUAGES.map(
                    (language) =>
                      html`<option value=${language} ?selected=${language === view.language}>
                        ${LANGUAGE_NAMES[language]}
                      </option>`,
                  )}
                </select>
                ${
                  view.voices.length
                    ? html`<select
                        class="voice-dock-select voice-voice-select"
                        aria-label=${copy.voice}
                        .value=${live(view.voice)}
                        @change=${onVoice}
                      >
                        ${voiceOptions(view.voices, { language: view.language, voice: view.voice, showAll: allVoices })}
                      </select>`
                    : nothing
                }`
        }
      </div>
      <button
        type="button"
        class="voice-close"
        aria-label=${copy.close}
        aria-keyshortcuts="Escape"
        @click=${requestClose}
      >
        ${icon(X, 20)}
      </button>
    </div>`;

  const modeTemplate = () =>
    html`<div class="voice-mode" role="radiogroup" aria-label=${copy.micMode}>
      ${MIC_MODES.map(
        (mode) =>
          html`<button
            type="button"
            class="voice-mode-option"
            role="radio"
            aria-checked=${view.micMode === mode ? "true" : "false"}
            data-value=${mode}
            @click=${() => {
              if (mode === view.micMode) return;
              handlers.onMicMode(mode);
              focusOrb();
            }}
          >
            ${copy.modes[mode]}
          </button>`,
      )}
    </div>`;

  const stageTemplate = () =>
    html`<div
      class="voice-stage"
      role="dialog"
      aria-modal="true"
      aria-label=${copy.dialog}
      tabindex="-1"
      data-ptt=${view.pttActive ? "true" : "false"}
    >
      ${modeTemplate()}
      <div class="voice-stage-center">
        <div class="voice-stage-orb">${orbTemplate("stage")}</div>
        <p class="voice-status" role="status" aria-live="polite" data-empty=${view.status ? "false" : "true"}>
          ${view.status}
        </p>
        ${captionsTemplate()}
      </div>
      ${transcriptTemplate()} ${dockTemplate()}
    </div>`;

  const surfaceTemplate = () => {
    if (open) return stageTemplate();
    if (view.state === "off") return nothing;
    return html`<div class="voice-dock-orb">${orbTemplate("dock")}</div>`;
  };

  const paint = () => {
    if (destroyed) return;
    render(
      html`<div class="voice-host">
        ${surfaceTemplate()}
        <div class="voice-announcer" role="status" aria-live="polite" aria-atomic="true">${view.announcement}</div>
      </div>`,
      host,
    );
    const captions = host.querySelector<HTMLElement>(".voice-captions");
    if (captions) {
      const overflow = captions.scrollHeight > captions.clientHeight + 1;
      captions.dataset.overflow = String(overflow);
      if (overflow) captions.scrollTop = captions.scrollHeight;
    }
  };

  const stage: VoiceStage = {
    update(next) {
      const asked = next.awaitingUser && !view.awaitingUser && next.micMode === "off";
      view = next;
      copy = COPY[next.language];
      if (typing && !TYPING_STATES.has(next.state)) {
        typing = false;
        draft = "";
      }
      if (asked && open && !typing) startTyping();
      else paint();
    },
    open() {
      if (open || destroyed) return;
      open = true;
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement && !host.contains(active) ? active : null;
      document.addEventListener("keydown", onKeydown);
      paint();
      focusOrb();
      handlers.onOpen();
    },
    close() {
      if (!open) return;
      onHoldEnd();
      open = false;
      typing = false;
      draft = "";
      document.removeEventListener("keydown", onKeydown);
      paint();
      if (returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
    },
    get isOpen() {
      return open;
    },
    destroy() {
      document.removeEventListener("keydown", onKeydown);
      host.removeEventListener(ORB_PRESS_EVENT, onOrbPress);
      host.removeEventListener(ORB_HOLD_START_EVENT, onHoldStart);
      host.removeEventListener(ORB_HOLD_END_EVENT, onHoldEnd);
      render(nothing, host);
      destroyed = true;
      open = false;
    },
  };

  host.addEventListener(ORB_PRESS_EVENT, onOrbPress);
  host.addEventListener(ORB_HOLD_START_EVENT, onHoldStart);
  host.addEventListener(ORB_HOLD_END_EVENT, onHoldEnd);
  paint();
  return stage;
}
