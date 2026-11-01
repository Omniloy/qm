import { LitElement, html } from "lit";
import { levelBus } from "./audio/levels.ts";
import { createOrbRenderer, type OrbRead, type OrbRenderer } from "./orb/renderer.ts";
import type { OrbMode, OrbStatus } from "./protocol.ts";

export type OrbSize = "stage" | "dock";

export const ORB_PRESS_EVENT = "qm-voice-orb-press";

export class VoiceOrb extends LitElement {
  static properties = {
    status: { reflect: true },
    mode: { reflect: true },
    muted: { type: Boolean, reflect: true },
    size: { reflect: true },
    label: {},
    pressed: { type: Boolean },
    still: { state: true },
  };
  declare status: OrbStatus;
  declare mode: OrbMode;
  declare muted: boolean;
  declare size: OrbSize;
  declare label: string;
  declare pressed: boolean;
  declare private still: boolean;
  private renderer: OrbRenderer | null = null;
  private hover = false;
  private press = false;
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

  private onClick = (): void => {
    this.dispatchEvent(new CustomEvent(ORB_PRESS_EVENT, { bubbles: true, composed: true }));
  };

  private onPointerEnter = (): void => {
    this.hover = true;
  };

  private onPointerLeave = (): void => {
    this.hover = false;
    this.press = false;
  };

  private onPointerDown = (): void => {
    this.press = true;
  };

  private onPointerUp = (): void => {
    this.press = false;
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
      @pointercancel=${this.onPointerLeave}
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
