import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { saveFooter } from "./setting-controls.ts";
import type { GatedModelAccess } from "../../chassis/src/hugging-face.ts";
import type { SettingsState } from "./settings.ts";

const VOICE_ASSISTANT_FIELDS = ["ttsEngine", "asrEngine", "wakePhrase", "pttStyle", "announceScope"] as const;

const DEFAULTS: Record<(typeof VOICE_ASSISTANT_FIELDS)[number], string> = {
  ttsEngine: "phonon-40m",
  asrEngine: "phonon-2.5",
  wakePhrase: "Oye Omni",
  pttStyle: "hold",
  announceScope: "all",
};

const CHOICES: Record<string, [value: string, label: string][]> = {
  ttsEngine: [
    ["phonon-40m", "Phonon-40m"],
    ["supertonic-3", "Supertonic 3"],
  ],
  asrEngine: [
    ["phonon-2.5", "Phonon-2.5"],
    ["qwen3-asr-0.6b", "Qwen3-ASR 0.6B"],
  ],
  pttStyle: [
    ["hold", "Hold to talk"],
    ["toggle", "Press to start, press to stop"],
  ],
  announceScope: [
    ["all", "All tasks"],
    ["voice", "Only tasks started by voice"],
  ],
};

const LABELS: Record<string, string> = {
  ttsEngine: "Speech engine",
  asrEngine: "Recognition engine",
  pttStyle: "Push-to-talk style",
  announceScope: "Announce finished tasks",
};

export function voiceAssistantDraft(data: Record<string, any>): Record<string, string> {
  const stored = data.voiceAssistant || {};
  return Object.fromEntries(
    VOICE_ASSISTANT_FIELDS.map((field) => [
      field,
      typeof stored[field] === "string" && stored[field] ? stored[field] : DEFAULTS[field],
    ]),
  );
}

export function voiceAssistantBody(draft: Record<string, any>, validate: boolean): Record<string, string> {
  const body = Object.fromEntries(VOICE_ASSISTANT_FIELDS.map((field) => [field, String(draft[field] ?? "")]));
  body.wakePhrase = body.wakePhrase!.trim().replace(/\s+/g, " ");
  if (validate && (!body.wakePhrase || body.wakePhrase.length > 60))
    throw new Error("Wake phrase must be 1–60 characters");
  return body;
}

const GATED_STATUS: Record<GatedModelAccess, string> = {
  servable: "Gated models are servable on the web UI service",
  no_token: "No HF_TOKEN on the web UI service — browsers without Phonon-40m already downloaded use Supertonic 3",
  token_refused:
    "Hugging Face refuses the HF_TOKEN on the web UI service — browsers without Phonon-40m already downloaded use Supertonic 3",
  unchecked: "Could not verify the HF_TOKEN on the web UI service with Hugging Face",
};

function gatedStatus(access: string | null) {
  if (access === null || !Object.hasOwn(GATED_STATUS, access)) return null;
  const text = GATED_STATUS[access as GatedModelAccess];
  return html`<p class="hint" id="voice-gated-models">
    ${access === "servable" ? text : html`<span class="flag-warn">${text}</span>`}
  </p>`;
}

function select(s: SettingsState, field: string) {
  const id = `voice-${field}`;
  return html`<label for=${id} style="margin-top: 12px">${LABELS[field]}</label
    ><select
      id=${id}
      style="max-width: 320px"
      .value=${s.draft[field] || ""}
      @change=${(e: Event) => s.change(field, (e.target as HTMLSelectElement).value)}
    >
      ${CHOICES[field]!.map(
        ([value, label]) => html`<option value=${value} ?selected=${value === s.draft[field]}>${label}</option>`,
      )}
    </select>`;
}

export function voiceAssistantCard(s: SettingsState) {
  return html`<section
    class=${classMap({ card: true, "sv-customize": true, "setting-row": true, hidden: !s.available, dirty: s.dirty })}
    id="card-voice-assistant"
  >
    <div class="head">
      <h2>Voice assistant</h2>
      <p>
        Models, wake phrase and announcements for the web voice assistant, org-wide. People still choose their own
        language, voice and microphone mode.
      </p>
    </div>
    <div class="body">
      ${select(s, "ttsEngine")} ${select(s, "asrEngine")} ${gatedStatus(s.gatedModelAccess)}
      <label for="voice-wakePhrase" style="margin-top: 12px">Wake phrase</label>
      <input
        type="text"
        id="voice-wakePhrase"
        style="max-width: 320px"
        maxlength="60"
        placeholder="Oye Omni"
        .value=${s.draft.wakePhrase || ""}
        @input=${(e: Event) => s.change("wakePhrase", (e.target as HTMLInputElement).value)}
      />
      ${select(s, "pttStyle")} ${select(s, "announceScope")}
    </div>
    ${saveFooter(s)}
  </section>`;
}
