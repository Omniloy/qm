import { html, nothing, render } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { live } from "lit/directives/live.js";
import { ArrowUp, Keyboard, Mic, MicOff, X } from "lucide";
import { icon } from "../ui.ts";
import { ORB_PRESS_EVENT } from "./orb-element.ts";
import {
  ORB_INPUTS_BY_STATE,
  type VoiceLanguage,
  type VoiceStageHandlers,
  type VoiceStageView,
  type VoiceState,
} from "./protocol.ts";
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
  },
} satisfies Record<VoiceLanguage, Record<string, string>>;

type Copy = (typeof COPY)[VoiceLanguage];

const PRESSED_STATES: ReadonlySet<VoiceState> = new Set(["listening", "thinking", "speaking"]);

const EMPTY_VIEW: VoiceStageView = {
  state: "off",
  language: "es",
  muted: false,
  status: "",
  captions: { user: null, agent: null },
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

function orbLabel(state: VoiceState, copy: Copy): string {
  if (state === "off") return copy.start;
  if (state === "arming") return copy.loading;
  if (state === "sleeping") return copy.talk;
  if (state === "listening") return copy.stop;
  return copy.interrupt;
}

function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ),
  ];
}

export function mountVoiceStage(host: HTMLElement, handlers: VoiceStageHandlers): VoiceStage {
  let view = EMPTY_VIEW;
  let copy: Copy = COPY[view.language];
  let open = false;
  let typing = false;
  let draft = "";
  let lastAgent: string | null = null;
  let past: { id: number; text: string } | null = null;
  let pastId = 0;
  let returnFocus: HTMLElement | null = null;
  let destroyed = false;

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
    else handlers.onOrbPress();
  };

  const requestClose = () => {
    handlers.onClose();
    stage.close();
  };

  const startTyping = () => {
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
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      handlers.onToggleMute();
      return;
    }
    if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
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
      .label=${size === "dock" ? copy.openStage : orbLabel(view.state, copy)}
      .pressed=${size === "dock" ? false : PRESSED_STATES.has(view.state)}
    ></qm-voice-orb>`;
  };

  const captionsTemplate = () => {
    const { user, agent } = view.captions;
    return html`<div class="voice-region" aria-hidden="true">
      <div class="voice-captions-past">
        ${past ? keyed(past.id, html`<p class="voice-caption-agent is-past">${past.text}</p>`) : nothing}
      </div>
      <div class="voice-captions">
        <div class="voice-captions-flow">
          ${user ? html`<p class="voice-caption-user ${user.final ? "" : "is-partial"}">${user.text}</p>` : nothing}
          ${
            agent
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
                </button>
                <button
                  type="button"
                  class="voice-dock-button voice-type-toggle"
                  aria-label=${copy.type}
                  @click=${startTyping}
                >
                  ${icon(Keyboard, 20)}
                </button>`
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

  const stageTemplate = () =>
    html`<div class="voice-stage" role="dialog" aria-modal="true" aria-label=${copy.dialog} tabindex="-1">
      <div class="voice-stage-center">
        <div class="voice-stage-orb">${orbTemplate("stage")}</div>
        <p class="voice-status" role="status" aria-live="polite" data-empty=${view.status ? "false" : "true"}>
          ${view.status}
        </p>
        ${captionsTemplate()}
      </div>
      ${dockTemplate()}
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
      const agentText = next.captions.agent?.text ?? null;
      if (lastAgent && agentText !== lastAgent && !(agentText ?? "").startsWith(lastAgent))
        past = { id: ++pastId, text: lastAgent };
      lastAgent = agentText;
      view = next;
      copy = COPY[next.language];
      paint();
    },
    open() {
      if (open || destroyed) return;
      open = true;
      const active = document.activeElement;
      returnFocus = active instanceof HTMLElement && !host.contains(active) ? active : null;
      document.addEventListener("keydown", onKeydown);
      paint();
      focusOrb();
    },
    close() {
      if (!open) return;
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
      render(nothing, host);
      destroyed = true;
      open = false;
    },
  };

  host.addEventListener(ORB_PRESS_EVENT, onOrbPress);
  paint();
  return stage;
}
