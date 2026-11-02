import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import type { VoiceChoice, VoiceStageHandlers, VoiceStageView } from "../src/voice-assistant/protocol.ts";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
const win = dom.window;
const globals = {
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement,
  HTMLSelectElement: win.HTMLSelectElement,
  MouseEvent: win.MouseEvent,
  Node: win.Node,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  KeyboardEvent: win.KeyboardEvent,
  MutationObserver: win.MutationObserver,
  customElements: win.customElements,
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { editableTarget, handlesSpace, karaokeWords, mountVoiceStage } =
  await import("../src/voice-assistant/voice-stage.ts");
const { ORB_HOLD_END_EVENT, ORB_HOLD_START_EVENT } = await import("../src/voice-assistant/orb-element.ts");

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

function view(over: Partial<VoiceStageView> = {}): VoiceStageView {
  return {
    state: "sleeping",
    language: "es",
    voice: "F1",
    voices: [
      { id: "F1", label: "Voz femenina 1", gender: "female" },
      { id: "M1", label: "Voz masculina 1", gender: "male" },
    ],
    micMode: "open",
    pttStyle: "hold",
    pttActive: false,
    muted: false,
    status: "",
    captions: { user: null, agent: null },
    announcement: "",
    ...over,
  };
}

function setup() {
  const calls: string[] = [];
  const typed: string[] = [];
  const handlers: VoiceStageHandlers = {
    onOrbPress: () => calls.push("orb"),
    onToggleMute: () => calls.push("mute"),
    onTypeInstead: (text) => typed.push(text),
    onClose: () => calls.push("close"),
    onLanguage: (language) => calls.push(`language:${language}`),
    onVoice: (voice) => calls.push(`voice:${voice}`),
    onMicMode: (mode) => calls.push(`mic:${mode}`),
    onPttDown: () => calls.push("ptt-down"),
    onPttUp: () => calls.push("ptt-up"),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const stage = mountVoiceStage(host, handlers);
  return { host, stage, calls, typed };
}

function key(k: string, target: EventTarget = document.body) {
  target.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

test("karaoke reveals whole words up to the spoken character, one sentence at a time", () => {
  const text = "Hola, Enrique. Tu tarea terminó.";
  assert.deepEqual(karaokeWords(text, 0), [
    { text: "Hola,", on: false },
    { text: "Enrique.", on: false },
  ]);
  assert.deepEqual(
    karaokeWords(text, 6).map((w) => w.on),
    [true, false],
  );
  assert.deepEqual(
    karaokeWords(text, 16).map((w) => [w.text, w.on]),
    [
      ["Hola,", true],
      ["Enrique.", true],
      ["Tu", false],
      ["tarea", false],
      ["terminó.", false],
    ],
  );
  assert.ok(karaokeWords(text, 999).every((w) => w.on));
  assert.deepEqual(karaokeWords("", 3), []);
});

test("nothing renders while voice is off and the stage is closed", async () => {
  const { host, stage } = setup();
  stage.update(view({ state: "off" }));
  await settle();
  assert.equal(host.querySelector("qm-voice-orb"), null);
  assert.ok(host.querySelector(".voice-announcer"), "the live region stays mounted");
  stage.destroy();
});

test("a closed stage shows the compact dock orb as a real labelled button", async () => {
  const { host, stage, calls } = setup();
  stage.update(view({ state: "sleeping" }));
  await settle();
  const orb = host.querySelector(".voice-dock-orb qm-voice-orb");
  assert.ok(orb);
  assert.equal(orb.getAttribute("size"), "dock");
  assert.equal(orb.getAttribute("status"), "connected");
  const button = orb.querySelector("button")!;
  assert.equal(button.getAttribute("type"), "button");
  assert.equal(button.getAttribute("aria-label"), "Abrir asistente de voz");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.ok(button.querySelector(".qm-voice-orb-still"), "without WebGL2 the orb is a still gradient disc");
  button.click();
  await settle();
  assert.equal(stage.isOpen, true, "pressing the dock orb opens the stage");
  assert.deepEqual(calls, []);
  stage.destroy();
});

test("the open stage renders orb, status, aria-hidden captions, live announcer and dock", async () => {
  const { host, stage, calls } = setup();
  stage.open();
  stage.update(
    view({
      state: "speaking",
      status: "Micrófono apagado",
      muted: true,
      announcement: "Tu tarea ha terminado.",
      captions: {
        user: { text: "¿Qué tal va la tarea?", final: true },
        agent: { text: "Ya ha terminado. Todo correcto.", spokenChars: 8 },
      },
    }),
  );
  await settle();
  const dialog = host.querySelector(".voice-stage")!;
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.getAttribute("aria-label"), "Asistente de voz");
  const orb = dialog.querySelector("qm-voice-orb")!;
  assert.equal(orb.getAttribute("size"), "stage");
  assert.equal(orb.getAttribute("mode"), "speaking");
  assert.ok(orb.hasAttribute("muted"));
  const orbButton = orb.querySelector("button")!;
  assert.equal(orbButton.getAttribute("aria-label"), "Interrumpir");
  assert.equal(orbButton.getAttribute("aria-pressed"), "true");
  const status = dialog.querySelector(".voice-status")!;
  assert.equal(status.textContent?.trim(), "Micrófono apagado");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(dialog.querySelector(".voice-region")!.getAttribute("aria-hidden"), "true");
  assert.equal(dialog.querySelector(".voice-caption-user")!.textContent, "¿Qué tal va la tarea?");
  const words = [...dialog.querySelectorAll(".voice-word")];
  assert.deepEqual(
    words.map((w) => [w.textContent!.trim(), w.classList.contains("is-on")]),
    [
      ["Ya", true],
      ["ha", true],
      ["terminado.", false],
    ],
  );
  const live = host.querySelector(".voice-announcer")!;
  assert.equal(live.getAttribute("aria-live"), "polite");
  assert.equal(live.textContent, "Tu tarea ha terminado.");
  const mute = dialog.querySelector<HTMLButtonElement>(".voice-mute-toggle")!;
  assert.equal(mute.getAttribute("aria-pressed"), "true");
  assert.equal(mute.getAttribute("aria-label"), "Silenciar micrófono");
  assert.ok(mute.querySelector("svg"), "dock buttons carry lucide icons");
  mute.click();
  orbButton.click();
  dialog.querySelector<HTMLButtonElement>(".voice-close")!.click();
  assert.deepEqual(calls, ["mute", "orb", "close"]);
  assert.equal(stage.isOpen, false);
  await settle();
  assert.ok(host.querySelector(".voice-dock-orb qm-voice-orb"), "closing falls back to the dock orb");
  stage.destroy();
});

test("partial user captions shimmer and a replaced reply recedes on its own layer", async () => {
  const { host, stage } = setup();
  stage.open();
  stage.update(view({ state: "speaking", captions: { user: null, agent: { text: "Primera.", spokenChars: 8 } } }));
  stage.update(view({ state: "listening", captions: { user: { text: "y aho", final: false }, agent: null } }));
  await settle();
  assert.ok(host.querySelector(".voice-caption-user.is-partial"));
  assert.equal(host.querySelector(".voice-caption-agent.is-past")?.textContent, "Primera.");
  stage.update(view({ state: "speaking", captions: { user: null, agent: { text: "Segunda", spokenChars: 0 } } }));
  stage.update(
    view({ state: "speaking", captions: { user: null, agent: { text: "Segunda parte.", spokenChars: 3 } } }),
  );
  await settle();
  assert.equal(
    host.querySelector(".voice-caption-agent.is-past")?.textContent,
    "Primera.",
    "a growing reply is not a new one",
  );
  stage.destroy();
});

test("keyboard: M mutes, Space presses the orb, Escape closes; typing is left alone", async () => {
  const { host, stage, calls } = setup();
  stage.update(view());
  stage.open();
  await settle();
  key("m");
  key(" ");
  assert.deepEqual(calls, ["mute", "orb"]);
  host.querySelector<HTMLButtonElement>(".voice-type-toggle")!.click();
  await settle();
  const input = host.querySelector<HTMLInputElement>(".voice-type-input")!;
  key("m", input);
  key(" ", input);
  assert.deepEqual(calls, ["mute", "orb"], "shortcuts never fire while typing");
  key("Escape", input);
  await settle();
  assert.equal(host.querySelector(".voice-type-input"), null, "Escape first leaves the type-instead field");
  assert.equal(stage.isOpen, true);
  key("Escape");
  assert.equal(stage.isOpen, false);
  assert.deepEqual(calls, ["mute", "orb", "close"]);
  key("m");
  assert.deepEqual(calls, ["mute", "orb", "close"], "shortcuts are inactive once the stage is closed");
  stage.destroy();
});

test("type instead submits trimmed text and returns to the dock buttons", async () => {
  const { host, stage, typed } = setup();
  stage.update(view());
  stage.open();
  await settle();
  host.querySelector<HTMLButtonElement>(".voice-type-toggle")!.click();
  await settle();
  const input = host.querySelector<HTMLInputElement>(".voice-type-input")!;
  const send = host.querySelector<HTMLButtonElement>(".voice-dock-button.is-send")!;
  assert.equal(send.disabled, true);
  input.value = "  abre la última tarea  ";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await settle();
  assert.equal(send.disabled, false);
  host.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(typed, ["abre la última tarea"]);
  assert.equal(host.querySelector(".voice-type-input"), null);
  assert.ok(host.querySelector(".voice-mute-toggle"));
  stage.destroy();
});

test("labels follow the language setting", async () => {
  const { host, stage } = setup();
  stage.update(view({ state: "listening", language: "en" }));
  stage.open();
  await settle();
  assert.equal(host.querySelector(".voice-stage")!.getAttribute("aria-label"), "Voice assistant");
  assert.equal(host.querySelector(".voice-stage-orb button")!.getAttribute("aria-label"), "Stop talking");
  assert.equal(host.querySelector(".voice-type-toggle")!.getAttribute("aria-label"), "Type instead");
  stage.destroy();
  assert.equal(host.querySelector(".voice-announcer"), null, "destroy clears the host");
});

test("the dock picks the language and the voice while talking", async () => {
  const { host, stage, calls } = setup();
  stage.update(view({ state: "listening" }));
  stage.open();
  await settle();
  const language = host.querySelector<HTMLSelectElement>(".voice-language-select")!;
  const voice = host.querySelector<HTMLSelectElement>(".voice-voice-select")!;
  assert.equal(language.getAttribute("aria-label"), "Idioma");
  assert.equal(language.value, "es");
  assert.deepEqual(
    [...voice.options].map((option) => [option.value, option.textContent?.trim()]),
    [
      ["F1", "Voz femenina 1"],
      ["M1", "Voz masculina 1"],
    ],
  );
  language.value = "en";
  language.dispatchEvent(new win.Event("change", { bubbles: true }));
  voice.value = "M1";
  voice.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.deepEqual(calls, ["language:en", "voice:M1"]);
  stage.update(view({ state: "listening", voice: "M1" }));
  await settle();
  assert.equal(host.querySelector<HTMLSelectElement>(".voice-voice-select")!.value, "M1", "the dock follows settings");
  stage.destroy();
});

test("typing is only offered while the assistant can answer", async () => {
  const { host, stage } = setup();
  stage.update(view({ state: "off", status: "Este navegador no admite WebGPU" }));
  stage.open();
  await settle();
  assert.equal(host.querySelector(".voice-type-toggle"), null, "no type-instead without the speech models");
  assert.ok(host.querySelector(".voice-language-select"), "language can still be chosen");
  stage.update(view({ state: "sleeping" }));
  await settle();
  host.querySelector<HTMLButtonElement>(".voice-type-toggle")!.click();
  await settle();
  assert.ok(host.querySelector(".voice-type-input"));
  stage.update(view({ state: "off" }));
  await settle();
  assert.equal(host.querySelector(".voice-type-input"), null, "the field closes when the assistant stops");
  stage.destroy();
});

const PHONON_CHOICES: VoiceChoice[] = [
  { id: "celia", label: "Celia (España)", gender: "female", locale: "es-ES" },
  { id: "marcos", label: "Marcos (España)", gender: "male", locale: "es-ES" },
  { id: "aldo", label: "Aldo (México)", gender: "male", locale: "es-MX" },
  { id: "rebeca", label: "Rebeca (México)", gender: "female", locale: "es-MX" },
  { id: "harper", label: "Harper (EE. UU.)", gender: "female", locale: "en-US" },
  { id: "freya", label: "Freya (Reino Unido)", gender: "female", locale: "en-GB" },
];

function groups(select: HTMLSelectElement): Array<[string, string[]]> {
  return [...select.querySelectorAll("optgroup")].map((group) => [
    group.label,
    [...group.querySelectorAll("option")].map((option) => option.value),
  ]);
}

test("the voice picker groups by accent, shows the active language first and can open every language", async () => {
  const { host, stage, calls } = setup();
  stage.update(view({ voice: "celia", voices: PHONON_CHOICES }));
  stage.open();
  await settle();
  let select = host.querySelector<HTMLSelectElement>(".voice-voice-select")!;
  assert.deepEqual(groups(select), [
    ["Español (España)", ["celia", "marcos"]],
    ["Español (México)", ["rebeca", "aldo"]],
  ]);
  const more = [...select.options].at(-1)!;
  assert.equal(more.value, "*");
  assert.equal(more.textContent, "Ver voces de otros idiomas…");
  select.value = "*";
  select.dispatchEvent(new win.Event("change", { bubbles: true }));
  await settle();
  select = host.querySelector<HTMLSelectElement>(".voice-voice-select")!;
  assert.deepEqual(
    groups(select).map(([label]) => label),
    ["Español (España)", "Español (México)", "Inglés (EE. UU.)", "Inglés (Reino Unido)"],
  );
  assert.equal(select.value, "celia");
  assert.deepEqual(calls, []);
  select.value = "harper";
  select.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.deepEqual(calls, ["voice:harper"]);
  stage.update(view({ language: "en", voice: "harper", voices: PHONON_CHOICES }));
  await settle();
  select = host.querySelector<HTMLSelectElement>(".voice-voice-select")!;
  assert.deepEqual(groups(select), [
    ["English (US)", ["harper"]],
    ["English (UK)", ["freya"]],
  ]);
  stage.destroy();
});

test("the dock switches between open mic and push to talk", async () => {
  const { host, stage, calls } = setup();
  stage.update(view());
  stage.open();
  await settle();
  const group = host.querySelector<HTMLElement>('.voice-mode[role="radiogroup"]')!;
  assert.equal(group.getAttribute("aria-label"), "Micrófono");
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  assert.deepEqual(
    radios.map((radio) => [radio.textContent?.trim(), radio.getAttribute("aria-checked")]),
    [
      ["Micrófono abierto", "true"],
      ["Pulsar para hablar", "false"],
    ],
  );
  radios[0]!.click();
  radios[1]!.click();
  assert.deepEqual(calls, ["mic:push"]);
  stage.destroy();
});

test("push to talk: press and hold the orb, Space is left to the page-wide binding", async () => {
  win.HTMLElement.prototype.setPointerCapture = () => undefined;
  const { host, stage, calls } = setup();
  stage.update(view({ micMode: "push" }));
  stage.open();
  await settle();
  const orb = host.querySelector(".voice-stage-orb qm-voice-orb")!;
  const button = orb.querySelector("button")!;
  assert.ok(orb.hasAttribute("hold-to-talk"));
  assert.equal(button.getAttribute("aria-label"), "Mantén pulsado para hablar");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  button.dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  stage.update(view({ micMode: "push", state: "listening", pttActive: true }));
  await settle();
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("aria-label"), "Suelta para enviar");
  assert.equal(host.querySelector(".voice-stage")!.getAttribute("data-ptt"), "true");
  button.dispatchEvent(new win.MouseEvent("pointerup", { bubbles: true, button: 0 }));
  button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
  assert.deepEqual(calls, ["ptt-down", "ptt-up"], "the click that ends a hold is not a press");
  button.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 0 }));
  assert.deepEqual(calls, ["ptt-down", "ptt-up", "orb"], "Enter on the orb still presses it");
  key(" ");
  assert.deepEqual(calls, ["ptt-down", "ptt-up", "orb"]);
  stage.update(view({ micMode: "push", pttStyle: "toggle" }));
  await settle();
  assert.ok(!orb.hasAttribute("hold-to-talk"));
  assert.equal(button.getAttribute("aria-label"), "Pulsa para hablar");
  stage.destroy();
});

test("text fields, including contenteditable and textbox roles, are editable targets", () => {
  const input = document.createElement("input");
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  const inner = document.createElement("span");
  editor.append(inner);
  const box = document.createElement("div");
  box.setAttribute("role", "textbox");
  document.body.append(editor, box);
  assert.equal(editableTarget(input), true);
  assert.equal(editableTarget(inner), true);
  assert.equal(editableTarget(box), true);
  assert.equal(editableTarget(document.createElement("button")), false);
  assert.equal(editableTarget(document.body), false);
  editor.remove();
  box.remove();
});

test("buttons, links and widget roles own the space key, plain content does not", () => {
  const radio = document.createElement("div");
  radio.setAttribute("role", "radio");
  const label = document.createElement("span");
  radio.append(label);
  const chip = document.createElement("div");
  chip.setAttribute("role", "button");
  const link = document.createElement("a");
  link.href = "/x";
  document.body.append(radio, chip, link);
  for (const target of [document.createElement("button"), label, chip, link, document.createElement("input")])
    assert.equal(handlesSpace(target), true);
  assert.equal(handlesSpace(document.body), false);
  assert.equal(handlesSpace(document.createElement("a")), false);
  radio.remove();
  chip.remove();
  link.remove();
});

test("space on a focused control in open mode activates the control, not the orb", () => {
  const { stage, calls } = setup();
  stage.update(view());
  stage.open();
  const radio = document.createElement("div");
  radio.setAttribute("role", "radio");
  document.body.append(radio);
  key(" ", radio);
  assert.ok(!calls.includes("orb"));
  key(" ");
  assert.ok(calls.includes("orb"));
  radio.remove();
  stage.destroy();
});

test("closing the stage mid-hold releases the push-to-talk hold exactly once", () => {
  const { host, stage, calls } = setup();
  stage.update(view({ micMode: "push" }));
  stage.open();
  host.dispatchEvent(new win.CustomEvent(ORB_HOLD_START_EVENT, { bubbles: true }));
  key("Escape");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("ptt")),
    ["ptt-down", "ptt-up"],
  );
  host.dispatchEvent(new win.CustomEvent(ORB_HOLD_END_EVENT, { bubbles: true }));
  assert.equal(calls.filter((call) => call === "ptt-up").length, 1);
  stage.destroy();
});
