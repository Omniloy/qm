import { LitElement, html } from "lit";
import { levelBus } from "./audio/levels.ts";
import { createOrbRenderer, type OrbRead, type OrbRenderer } from "./orb/renderer.ts";
import type { OrbMode, OrbStatus } from "./protocol.ts";

export type OrbSize = "stage" | "dock";

export const ORB_PRESS_EVENT = "qm-voice-orb-press";
export const ORB_HOLD_START_EVENT = "qm-voice-orb-hold-start";
export const ORB_HOLD_END_EVENT = "qm-voice-orb-hold-end";

export class VoiceOrb extends LitElement {
  static properties = {
    status: { reflect: true },
    mode: { reflect: true },
    muted: { type: Boolean, reflect: true },
    size: { reflect: true },
    label: {},
    pressed: { type: Boolean },
    holdToTalk: { type: Boolean, reflect: true, attribute: "hold-to-talk" },
    still: { state: true },
  };
  declare status: OrbStatus;
  declare mode: OrbMode;
  declare muted: boolean;
  declare size: OrbSize;
  declare label: string;
  declare pressed: boolean;
  declare holdToTalk: boolean;
  declare private still: boolean;
  private renderer: OrbRenderer | null = null;
  private hover = false;
  private press = false;
  private holding = false;
  private focusRing = false;
  private dark = false;
  private themeObserver: MutationObserver | null = null;
  private readonly snapshot: OrbRead = {
    status: "idle",
    mode: "idle",
    muted: false,
    hover: false,
    press: false,
    dark: false,
  };

  constructor() {
    super();
    this.status = "idle";
    this.mode = "idle";
    this.muted = false;
    this.size = "stage";
    this.label = "";
    this.pressed = false;
    this.holdToTalk = false;
    this.still = false;
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const root = document.documentElement;
    this.dark = root.classList.contains("dark");
    this.themeObserver = new MutationObserver(() => {
      this.dark = root.classList.contains("dark");
    });
    this.themeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
    if (this.hasUpdated) this.startRenderer();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.release();
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  protected updated(): void {
    this.startRenderer();
  }

  private startRenderer(): void {
    if (this.renderer || this.still || !this.isConnected) return;
    const canvas = this.querySelector<HTMLCanvasElement>(".qm-voice-orb-canvas");
    if (!canvas) return;
    try {
      this.renderer = createOrbRenderer(canvas, this.read, levelBus);
    } catch {
      this.still = true;
    }
  }

  private read = (): OrbRead => {
    const s = this.snapshot;
    s.status = this.status;
    s.mode = this.mode;
    s.muted = this.muted;
    s.hover = this.hover || this.focusRing;
    s.press = this.press;
    s.dark = this.dark;
    return s;
  };

  private emit(type: string): void {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  }

  private release = (): void => {
    if (!this.holding) return;
    this.holding = false;
    this.emit(ORB_HOLD_END_EVENT);
  };

  private onClick = (e: MouseEvent): void => {
    if (this.holdToTalk && e.detail !== 0) return;
    this.emit(ORB_PRESS_EVENT);
  };

  private onPointerEnter = (): void => {
    this.hover = true;
  };

  private onPointerLeave = (): void => {
    this.hover = false;
    this.press = false;
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.press = true;
    if (!this.holdToTalk || this.holding || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.holding = true;
    this.emit(ORB_HOLD_START_EVENT);
  };

  private onPointerUp = (): void => {
    this.press = false;
    this.release();
  };

  private onPointerCancel = (): void => {
    this.onPointerLeave();
    this.release();
  };

  private onContextMenu = (e: Event): void => {
    if (this.holdToTalk) e.preventDefault();
  };

  private onFocus = (e: FocusEvent): void => {
    this.focusRing = (e.currentTarget as HTMLElement).matches(":focus-visible");
  };

  private onBlur = (): void => {
    this.focusRing = false;
  };

  protected render() {
    return html`<button
      type="button"
      class="qm-voice-orb-button"
      aria-label=${this.label}
      aria-pressed=${this.pressed ? "true" : "false"}
      @click=${this.onClick}
      @pointerenter=${this.onPointerEnter}
      @pointerleave=${this.onPointerLeave}
      @pointerdown=${this.onPointerDown}
      @pointerup=${this.onPointerUp}
      @pointercancel=${this.onPointerCancel}
      @lostpointercapture=${this.release}
      @contextmenu=${this.onContextMenu}
      @focus=${this.onFocus}
      @blur=${this.onBlur}
    >
      ${
        this.still
          ? html`<span class="qm-voice-orb-still" aria-hidden="true"></span>`
          : html`<canvas class="qm-voice-orb-canvas" aria-hidden="true"></canvas>`
      }
    </button>`;
  }
}

if (!customElements.get("qm-voice-orb")) customElements.define("qm-voice-orb", VoiceOrb);
