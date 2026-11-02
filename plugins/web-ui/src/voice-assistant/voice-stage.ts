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
  type VoiceActivity,
  type VoiceActivityKind,
  type VoiceLanguage,
  type VoiceStageHandlers,
  type VoiceStageView,
  type VoiceState,
  type VoiceTranscriptEntry,
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
    recent: "Mensajes recientes con Omni",
    openTask: "Abrir la tarea",
    activity: "Lo que ha hecho Omni",
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
    recent: "Recent messages with Omni",
    openTask: "Open the task",
    activity: "What Omni did",
  },
} satisfies Record<VoiceLanguage, Record<string, string | Record<MicMode, string>>>;

type Copy = (typeof COPY)[VoiceLanguage];

const ACTIVITY_LABELS: Record<VoiceLanguage, Record<VoiceActivityKind, (activity: VoiceActivity) => string>> = {
  es: {
    task_created: (a) => `Tarea creada: ${a.title ?? ""}`,
    message_sent: (a) => `Mensaje enviado a: ${a.title ?? ""}`,
    conversations_read: (a) => `Conversaciones leídas (${a.count ?? 1})`,
    memory_saved: () => "Memoria guardada",
    memory_compacted: () => "Memoria compactada",
    approved: (a) => `Aprobado: ${a.title ?? ""}`,
  },
  en: {
    task_created: (a) => `Task created: ${a.title ?? ""}`,
    message_sent: (a) => `Message sent to: ${a.title ?? ""}`,
    conversations_read: (a) => `Conversations read (${a.count ?? 1})`,
    memory_saved: () => "Memory saved",
    memory_compacted: () => "Memory compacted",
    approved: (a) => `Approved: ${a.title ?? ""}`,
  },
};

export function activityLabel(activity: VoiceActivity, language: VoiceLanguage): string {
  return ACTIVITY_LABELS[language][activity.kind](activity).trim().replace(/:$/, "");
}

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
  work: null,
};

export const MINI_FRESH_MS = 6_000;
export const MINI_HIDE_MS = 600;
const MINI_FADE_MS = 600;
const HOLDING_STATES: ReadonlySet<VoiceState> = new Set(["thinking", "speaking"]);
const MINI_HISTORY = 30;
const MINI_FRESH_SHOWN = 2;

const plainText = (text: string): string =>
  text
    .replace(/[*_`#>|[\]]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

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
  let revealed = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let miniLive = "";
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  let fading = false;
  const seen = new Set<string>();
  const fresh = new Set<string>();

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

  const clearFade = () => {
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeTimer = null;
    fading = false;
  };

  const forgetFresh = () => {
    clearFade();
    fresh.clear();
  };

  const scheduleFade = () => {
    if (!fresh.size || HOLDING_STATES.has(view.state)) return clearFade();
    if (fadeTimer !== null) return;
    fadeTimer = setTimeout(() => {
      fading = true;
      paint();
      fadeTimer = setTimeout(() => {
        forgetFresh();
        paint();
      }, MINI_FADE_MS);
    }, MINI_FRESH_MS - MINI_FADE_MS);
  };

  const noticeNew = (entries: readonly VoiceTranscriptEntry[]) => {
    const now = Date.now();
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (open || !entry.text || now - entry.at > MINI_FRESH_MS) continue;
      clearFade();
      fresh.add(entry.id);
      miniLive = plainText(entry.text);
    }
    scheduleFade();
  };

  const clearHide = () => {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
  };

  const reveal = () => {
    clearHide();
    if (revealed) return;
    revealed = true;
    paint();
  };

  const conceal = (delay: number) => {
    clearHide();
    if (!revealed) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      revealed = false;
      paint();
    }, delay);
  };

  const onMiniFocusOut = (e: FocusEvent) => {
    const area = e.currentTarget as HTMLElement;
    if (!(e.relatedTarget instanceof Node) || !area.contains(e.relatedTarget)) conceal(MINI_HIDE_MS);
  };

  const onMiniKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !revealed) return;
    e.preventDefault();
    const area = e.currentTarget as HTMLElement;
    if (area.querySelector(".voice-mini-log")?.contains(area.ownerDocument.activeElement))
      area.querySelector<HTMLElement>(".qm-voice-orb-button")?.focus();
    conceal(0);
  };

  const onMiniPointerLeave = (e: PointerEvent) => {
    const area = e.currentTarget as HTMLElement;
    if (!area.contains(area.ownerDocument.activeElement)) conceal(MINI_HIDE_MS);
  };

  const workTemplate = () => {
    const work = view.work;
    if (!work) return nothing;
    const content = html`<span class="voice-work-dot" aria-hidden="true"></span
      ><span class="voice-work-text">${work.text}</span>`;
    const taskRef = work.taskRef;
    return taskRef
      ? html`<button
          type="button"
          class="voice-work"
          data-busy=${work.busy ? "true" : "false"}
          title=${copy.openTask}
          @click=${() => handlers.onOpenTask(taskRef)}
        >
          ${content}
        </button>`
      : html`<span class="voice-work" data-busy=${work.busy ? "true" : "false"}>${content}</span>`;
  };

  const activityTemplate = (entry: VoiceTranscriptEntry) =>
    entry.activity?.length
      ? html`<div class="voice-activity" role="group" aria-label=${copy.activity}>
          ${entry.activity.map(
            (item) =>
              html`<button
                type="button"
                class="voice-activity-chip"
                data-kind=${item.kind}
                @click=${() => handlers.onOpenActivity(item)}
              >
                <span class="voice-activity-text">${activityLabel(item, view.language)}</span>
              </button>`,
          )}
        </div>`
      : nothing;

  const entryTemplate = (entry: VoiceTranscriptEntry, base: string, extra = "") => {
    const className = `${base} ${base}-${entry.role}${extra}`;
    if (entry.role === "user") return html`<p class=${className} dir="auto">${entry.text}</p>`;
    const chips = base === "voice-entry" ? activityTemplate(entry) : nothing;
    return html`<div class=${className}>${entry.text ? markdown(entry.text) : nothing}${chips}</div>`;
  };

  const miniTemplate = () => {
    const written = view.transcript.filter((entry) => entry.text);
    const entries = revealed
      ? written.slice(-MINI_HISTORY)
      : written.filter((entry) => fresh.has(entry.id)).slice(-MINI_FRESH_SHOWN);
    return html`<div class="voice-mini" data-fading=${fading && !revealed ? "true" : "false"}>
      ${
        entries.length
          ? html`<section
              class="voice-mini-log"
              aria-label=${copy.recent}
              tabindex=${revealed ? "0" : "-1"}
              aria-hidden=${revealed ? "false" : "true"}
            >
              <div class="voice-mini-flow">
                ${repeat(
                  entries,
                  (entry) => entry.id,
                  (entry) => entryTemplate(entry, "voice-mini-entry", fresh.has(entry.id) ? " is-fresh" : ""),
                )}
              </div>
            </section>`
          : nothing
      }
    </div>`;
  };

  const orbTemplate = (size: "stage" | "dock") => {
    const inputs = ORB_INPUTS_BY_STATE[view.state];
    return html`<qm-voice-orb
      size=${size}
      .status=${inputs.status}
      .mode=${inputs.mode}
      .muted=${view.muted}
      .working=${view.work?.busy === true}
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
              (entry) => entryTemplate(entry, "voice-entry"),
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
        <div class="voice-work-slot" role="status">${workTemplate()}</div>
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
    return html`<div
      class="voice-dock-orb"
      data-revealed=${revealed ? "true" : "false"}
      @pointerenter=${reveal}
      @pointerleave=${onMiniPointerLeave}
      @focusin=${reveal}
      @focusout=${onMiniFocusOut}
      @keydown=${onMiniKeydown}
    >
      ${orbTemplate("dock")}
      <div class="voice-dock-work" role="status">${workTemplate()}</div>
      ${miniTemplate()}
    </div>`;
  };

  const paint = () => {
    if (destroyed) return;
    render(
      html`<div class="voice-host">
        ${surfaceTemplate()}
        <div class="voice-announcer" role="status" aria-live="polite" aria-atomic="true">${view.announcement}</div>
        <div class="voice-announcer voice-mini-live" aria-live="polite" aria-atomic="true">${open ? "" : miniLive}</div>
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
      noticeNew(next.transcript);
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
      clearHide();
      forgetFresh();
      revealed = false;
      miniLive = "";
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
      clearHide();
      forgetFresh();
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
