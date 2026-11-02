import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import type { VoiceChoice, VoiceStageHandlers, VoiceStageView } from "../src/voice-assistant/protocol.ts";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (url.endsWith("/src/message-markdown.ts"))
      return {
        format: "module",
        source:
          'import { html } from "lit"; export const markdown = (text) => html`<qm-markdown .content=${text}></qm-markdown>`;',
        shortCircuit: true,
      };
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

const { MINI_FRESH_MS, MINI_HIDE_MS, activityLabel, editableTarget, handlesSpace, karaokeWords, mountVoiceStage } =
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
    transcript: [],
    awaitingUser: false,
    announcement: "",
    work: null,
    ...over,
  };
}

function setup() {
  const calls: string[] = [];
  const typed: string[] = [];
  const opened = { count: 0 };
  const handlers: VoiceStageHandlers = {
    onOpen: () => void opened.count++,
    onOrbPress: () => calls.push("orb"),
    onToggleMute: () => calls.push("mute"),
    onTypeInstead: (text) => typed.push(text),
    onClose: () => calls.push("close"),
    onLanguage: (language) => calls.push(`language:${language}`),
    onVoice: (voice) => calls.push(`voice:${voice}`),
    onMicMode: (mode) => calls.push(`mic:${mode}`),
    onPttDown: () => calls.push("ptt-down"),
    onPttUp: () => calls.push("ptt-up"),
    onOpenTask: (taskRef) => calls.push(`task:${taskRef}`),
    onOpenActivity: (activity) => calls.push(`activity:${activity.kind}:${activity.taskRef ?? ""}`),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const stage = mountVoiceStage(host, handlers);
  return { host, stage, calls, typed, opened };
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
        user: { text: "¿Qué tal va la tarea?", final: false },
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

test("partial user captions shimmer and the spoken reply is a caption only while speaking", async () => {
  const { host, stage } = setup();
  stage.open();
  stage.update(view({ state: "listening", captions: { user: { text: "y aho", final: false }, agent: null } }));
  await settle();
  assert.ok(host.querySelector(".voice-caption-user.is-partial"));
  stage.update(
    view({
      state: "thinking",
      captions: { user: { text: "y ahora", final: true }, agent: { text: "", spokenChars: 0 } },
    }),
  );
  await settle();
  assert.equal(host.querySelector(".voice-caption-user"), null, "what the person said moves to the transcript");
  stage.update(view({ state: "speaking", captions: { user: null, agent: { text: "Hecho.", spokenChars: 2 } } }));
  await settle();
  assert.ok(host.querySelector(".voice-caption-agent"));
  stage.update(view({ state: "listening", captions: { user: null, agent: { text: "Hecho.", spokenChars: 6 } } }));
  await settle();
  assert.equal(host.querySelector(".voice-caption-agent"), null);
  assert.equal(host.querySelector(".is-past"), null, "there is no receding past caption any more");
  stage.destroy();
});

test("the transcript panel shows what was written, with markdown, newest last", async () => {
  const { host, stage, opened } = setup();
  stage.update(view());
  stage.open();
  assert.equal(opened.count, 1, "opening the stage asks for the saved transcript");
  await settle();
  assert.equal(host.querySelector(".voice-transcript"), null, "an empty conversation shows no panel");
  stage.update(
    view({
      transcript: [
        { id: "u1", role: "user", text: "¿Cómo va el informe?", at: 1 },
        { id: "a1", role: "assistant", text: "**Informe Q3**\n\n- tres conclusiones\n- dos riesgos", at: 2 },
      ],
    }),
  );
  await settle();
  const panel = host.querySelector(".voice-transcript")!;
  assert.equal(panel.getAttribute("aria-label"), "Conversación con Omni");
  const entries = [...panel.querySelectorAll(".voice-entry")];
  assert.deepEqual(
    entries.map((entry) => entry.classList.contains("voice-entry-user")),
    [true, false],
  );
  assert.equal(entries[0]!.textContent, "¿Cómo va el informe?");
  const rendered = entries[1]!.querySelector("qm-markdown") as (Element & { content?: string }) | null;
  assert.ok(rendered, "assistant entries render through the chat markdown element");
  assert.equal(rendered.content, "**Informe Q3**\n\n- tres conclusiones\n- dos riesgos");
  stage.destroy();
});

test("with the mic off the dock has no mute button and the orb opens the type-in field", async () => {
  const { host, stage, calls } = setup();
  stage.update(view({ micMode: "off" }));
  stage.open();
  await settle();
  assert.equal(host.querySelector(".voice-mute-toggle"), null);
  const button = host.querySelector<HTMLButtonElement>(".voice-stage-orb qm-voice-orb button")!;
  assert.equal(button.getAttribute("aria-label"), "Escribir");
  key("m");
  button.click();
  await settle();
  assert.ok(host.querySelector(".voice-type-input"), "pressing the orb starts typing");
  assert.deepEqual(calls, []);
  stage.update(view({ micMode: "off", state: "speaking" }));
  await settle();
  host.querySelector<HTMLButtonElement>(".voice-stage-orb qm-voice-orb button")!.click();
  assert.deepEqual(calls, ["orb"], "while speaking the orb interrupts");
  stage.destroy();
});

test("a question from the assistant opens the type-in field when the mic is off", async () => {
  const { host, stage } = setup();
  stage.update(view({ micMode: "off" }));
  stage.open();
  await settle();
  assert.equal(host.querySelector(".voice-type-input"), null);
  stage.update(view({ micMode: "off", awaitingUser: true, status: "Escribe tu respuesta" }));
  await settle();
  assert.ok(host.querySelector(".voice-type-input"));
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

test("the dock switches between open mic, push to talk and mic off", async () => {
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
      ["Sin micrófono", "false"],
    ],
  );
  radios[0]!.click();
  radios[2]!.click();
  radios[1]!.focus();
  radios[1]!.click();
  assert.deepEqual(calls, ["mic:off", "mic:push"]);
  await settle();
  assert.equal(document.activeElement, host.querySelector(".voice-stage-orb .qm-voice-orb-button"));
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

const entry = (id: string, role: "user" | "assistant", text: string, at = Date.now()) => ({ id, role, text, at });
const pointer = (target: Element, type: "pointerenter" | "pointerleave") =>
  target.dispatchEvent(new win.Event(type, { bubbles: false }));

test("while work is in flight the stage shows a clickable working line beside the hint and a working orb", async () => {
  const { host, stage, calls } = setup();
  stage.open();
  stage.update(
    view({
      micMode: "push",
      status: "Mantén pulsada la barra espaciadora o el orbe para hablar",
      work: { text: "Trabajando: Revisar conversaciones…", taskRef: "web:u:voice:1", busy: true },
    }),
  );
  await settle();
  const line = host.querySelector<HTMLButtonElement>(".voice-work-slot button.voice-work")!;
  assert.equal(line.textContent?.trim(), "Trabajando: Revisar conversaciones…");
  assert.equal(line.dataset.busy, "true");
  assert.equal(host.querySelector(".voice-work-slot")!.getAttribute("role"), "status");
  assert.equal(
    host.querySelector(".voice-status")!.textContent?.trim(),
    "Mantén pulsada la barra espaciadora o el orbe para hablar",
    "the push-to-talk hint stays next to the working line",
  );
  assert.ok(host.querySelector(".voice-stage-orb qm-voice-orb")!.hasAttribute("working"));
  line.click();
  assert.deepEqual(calls, ["task:web:u:voice:1"]);
  stage.update(view({ work: { text: "Pensando…", taskRef: null, busy: true } }));
  await settle();
  assert.equal(host.querySelector(".voice-work-slot button"), null, "work with no task is plain text");
  assert.equal(host.querySelector(".voice-work-slot .voice-work")!.textContent?.trim(), "Pensando…");
  stage.update(view());
  await settle();
  assert.equal(host.querySelector(".voice-work-slot .voice-work"), null);
  assert.ok(!host.querySelector(".voice-stage-orb qm-voice-orb")!.hasAttribute("working"));
  stage.destroy();
});

test("the docked orb flashes new messages below it, announces only those, and keeps old ones out", async () => {
  const { host, stage } = setup();
  stage.update(view({ transcript: [entry("old", "assistant", "Antiguo", Date.now() - 60_000)] }));
  await settle();
  assert.equal(host.querySelector(".voice-mini-log"), null, "history stays hidden until hovered");
  stage.update(
    view({
      transcript: [
        entry("old", "assistant", "Antiguo", Date.now() - 60_000),
        entry("u1", "user", "Mira mis conversaciones"),
        entry("a1", "assistant", "Revisaré **tus** conversaciones."),
      ],
    }),
  );
  await settle();
  const fresh = [...host.querySelectorAll(".voice-mini-entry.is-fresh")];
  assert.deepEqual(
    fresh.map((node) => node.classList.contains("voice-mini-entry-user")),
    [true, false],
    "newest at the bottom",
  );
  assert.equal(host.querySelectorAll(".voice-mini-entry").length, 2);
  const log = host.querySelector(".voice-mini-log")!;
  assert.equal(log.getAttribute("aria-hidden"), "true");
  assert.equal(log.getAttribute("tabindex"), "-1");
  assert.equal(host.querySelector(".voice-mini-live")!.textContent?.trim(), "Revisaré tus conversaciones.");
  assert.equal(host.querySelector(".voice-dock-orb")!.getAttribute("data-revealed"), "false");
  stage.destroy();
});

test("docked messages stay while the assistant thinks or speaks, then fade out and leave", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, stage } = setup();
  const turn = [entry("u1", "user", "¿Qué tal?"), entry("a1", "assistant", "Muy bien.")];
  stage.update(view({ state: "thinking", transcript: turn.slice(0, 1) }));
  stage.update(view({ state: "speaking", transcript: turn }));
  t.mock.timers.tick(MINI_FRESH_MS * 3);
  const shown = () => [...host.querySelectorAll(".voice-mini-entry")].map((node) => node.className);
  const fading = () => host.querySelector(".voice-mini")!.getAttribute("data-fading");
  const both = [
    "voice-mini-entry voice-mini-entry-user is-fresh",
    "voice-mini-entry voice-mini-entry-assistant is-fresh",
  ];
  assert.deepEqual(shown(), both, "a long reply keeps the turn on screen");
  stage.update(view({ state: "sleeping", transcript: turn }));
  t.mock.timers.tick(MINI_FRESH_MS - 700);
  assert.equal(fading(), "false");
  t.mock.timers.tick(200);
  assert.equal(fading(), "true", "the messages fade before they leave");
  assert.deepEqual(shown(), both);
  stage.update(view({ state: "sleeping", transcript: [...turn, entry("a2", "assistant", "Listo: informe.")] }));
  assert.equal(fading(), "false", "a new message brings them back and restarts the clock");
  t.mock.timers.tick(MINI_FRESH_MS - 600);
  assert.equal(fading(), "true");
  t.mock.timers.tick(600);
  assert.deepEqual(shown(), []);
  stage.destroy();
});

test("hovering or focusing the docked orb reveals a scrollable history that hides again after a delay", async () => {
  const { host, stage } = setup();
  const history = Array.from({ length: 40 }, (_, i) => entry(`e${i}`, "user", `m${i}`, 1));
  stage.update(view({ transcript: history }));
  await settle();
  const area = host.querySelector(".voice-dock-orb")!;
  pointer(area, "pointerenter");
  await settle();
  assert.equal(area.getAttribute("data-revealed"), "true");
  const log = host.querySelector(".voice-mini-log")!;
  assert.equal(log.getAttribute("tabindex"), "0");
  assert.equal(log.getAttribute("aria-hidden"), "false");
  assert.equal(log.getAttribute("aria-label"), "Mensajes recientes con Omni");
  const shown = [...host.querySelectorAll(".voice-mini-entry")].map((node) => node.textContent?.trim());
  assert.equal(shown.length, 30);
  assert.equal(shown.at(-1), "m39");
  assert.equal(host.querySelector(".voice-mini-live")!.textContent?.trim(), "", "revealing announces nothing");
  pointer(area, "pointerleave");
  await settle();
  assert.equal(area.getAttribute("data-revealed"), "true", "it lingers briefly after the pointer leaves");
  pointer(area, "pointerenter");
  await new Promise((resolve) => setTimeout(resolve, MINI_HIDE_MS + 50));
  assert.equal(area.getAttribute("data-revealed"), "true", "coming back cancels the hide");
  pointer(area, "pointerleave");
  await new Promise((resolve) => setTimeout(resolve, MINI_HIDE_MS + 50));
  assert.equal(area.getAttribute("data-revealed"), "false");
  assert.equal(host.querySelector(".voice-mini-log"), null);
  area
    .querySelector<HTMLButtonElement>("qm-voice-orb button")!
    .dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
  await settle();
  assert.equal(area.getAttribute("data-revealed"), "true", "keyboard focus reveals it too");
  area.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert.equal(area.getAttribute("data-revealed"), "false", "Escape hides it");
  stage.destroy();
});

test("a focused dock history stays open when the pointer leaves, and Escape hands focus back to the orb", async () => {
  const { host, stage } = setup();
  stage.update(view({ transcript: [entry("e1", "user", "hola", 1)] }));
  await settle();
  const area = host.querySelector(".voice-dock-orb")!;
  pointer(area, "pointerenter");
  await settle();
  const log = host.querySelector<HTMLElement>(".voice-mini-log")!;
  log.focus();
  pointer(area, "pointerleave");
  await new Promise((resolve) => setTimeout(resolve, MINI_HIDE_MS + 50));
  assert.equal(area.getAttribute("data-revealed"), "true", "focus keeps it open");
  log.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert.equal(area.getAttribute("data-revealed"), "false");
  assert.equal(win.document.activeElement, area.querySelector("qm-voice-orb button"));
  stage.destroy();
});

test("messages that arrive while the stage is open do not flash in the dock, and the dock shows the working line", async () => {
  const { host, stage, calls } = setup();
  stage.open();
  stage.update(view({ transcript: [entry("u1", "user", "hola")] }));
  stage.close();
  stage.update(
    view({
      transcript: [entry("u1", "user", "hola")],
      work: { text: "Trabajando: Informe…", taskRef: "web:u:voice:2", busy: true },
    }),
  );
  await settle();
  assert.equal(host.querySelector(".voice-mini-entry"), null);
  assert.ok(host.querySelector(".voice-dock-orb qm-voice-orb")!.hasAttribute("working"));
  const line = host.querySelector<HTMLButtonElement>(".voice-dock-work button.voice-work")!;
  assert.equal(line.textContent?.trim(), "Trabajando: Informe…");
  line.click();
  assert.deepEqual(calls, ["task:web:u:voice:2"]);
  stage.destroy();
});

test("the stage shows what the agent did as chips under its message, and each chip opens its target", async () => {
  const { host, stage, calls } = setup();
  const activity = [
    { kind: "task_created" as const, title: "Informe", taskRef: "web:u:voice:1" },
    { kind: "conversations_read" as const, count: 3 },
    { kind: "memory_saved" as const },
  ];
  stage.open();
  stage.update(
    view({
      transcript: [
        entry("u1", "user", "Prepara el informe"),
        { ...entry("a1", "assistant", "Hecho."), activity },
        { ...entry("a2", "assistant", ""), activity: [{ kind: "approved" as const, title: "Correo" }] },
      ],
    }),
  );
  await settle();
  const groups = [...host.querySelectorAll(".voice-transcript .voice-entry-assistant")].map((node) =>
    [...node.querySelectorAll(".voice-activity-chip")].map((chip) => chip.textContent?.trim()),
  );
  assert.deepEqual(groups, [
    ["Tarea creada: Informe", "Conversaciones leídas (3)", "Memoria guardada"],
    ["Aprobado: Correo"],
  ]);
  assert.equal(host.querySelector(".voice-entry-user .voice-activity"), null);
  const chips = [...host.querySelectorAll<HTMLButtonElement>(".voice-activity-chip")];
  for (const chip of chips) chip.click();
  assert.deepEqual(calls, [
    "activity:task_created:web:u:voice:1",
    "activity:conversations_read:",
    "activity:memory_saved:",
    "activity:approved:",
  ]);
  stage.destroy();
});

test("the docked history leaves out chips and entries that only carry activity", async () => {
  const { host, stage } = setup();
  stage.update(
    view({
      transcript: [
        { ...entry("a1", "assistant", "Hecho."), activity: [{ kind: "memory_saved" as const }] },
        { ...entry("a2", "assistant", ""), activity: [{ kind: "memory_compacted" as const }] },
      ],
    }),
  );
  await settle();
  assert.equal(host.querySelectorAll(".voice-mini-entry").length, 1);
  assert.equal(host.querySelector(".voice-mini .voice-activity"), null);
  stage.destroy();
});

test("activity chips read in both languages and drop a missing title", () => {
  assert.equal(
    activityLabel({ kind: "message_sent", title: "Informe", taskRef: "web:u:1" }, "es"),
    "Mensaje enviado a: Informe",
  );
  assert.equal(activityLabel({ kind: "message_sent", title: "Report" }, "en"), "Message sent to: Report");
  assert.equal(activityLabel({ kind: "conversations_read", count: 1 }, "en"), "Conversations read (1)");
  assert.equal(activityLabel({ kind: "memory_compacted" }, "es"), "Memoria compactada");
  assert.equal(activityLabel({ kind: "task_created" }, "es"), "Tarea creada");
  assert.equal(activityLabel({ kind: "allowed", title: "Gmail", taskRef: "web:u:1" }, "es"), "Permitido: Gmail");
  assert.equal(activityLabel({ kind: "kept_blocked", title: "Gmail", taskRef: "web:u:1" }, "es"), "Bloqueado: Gmail");
  assert.equal(activityLabel({ kind: "allowed", title: "Gmail" }, "en"), "Allowed: Gmail");
  assert.equal(activityLabel({ kind: "kept_blocked", title: "Gmail" }, "en"), "Blocked: Gmail");
});

test("a held task's status line opens that task, where the security card is", async () => {
  const { host, stage, calls } = setup();
  stage.open();
  stage.update(
    view({ work: { text: "Retenido por seguridad: Buscar en Gmail", taskRef: "web:u:voice:2", busy: false } }),
  );
  await settle();
  const line = host.querySelector<HTMLButtonElement>(".voice-work-slot button.voice-work")!;
  assert.equal(line.textContent?.trim(), "Retenido por seguridad: Buscar en Gmail");
  assert.equal(line.dataset.busy, "false");
  assert.ok(!host.querySelector(".voice-stage-orb qm-voice-orb")!.hasAttribute("working"));
  line.click();
  assert.deepEqual(calls, ["task:web:u:voice:2"]);
  stage.destroy();
});
