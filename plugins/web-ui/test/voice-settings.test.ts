import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import type { ModelFile } from "../src/voice-assistant/protocol.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
});
const win = dom.window;
for (const [key, value] of Object.entries({
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  Event: win.Event,
  localStorage: win.localStorage,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const stored = new Map<string, { value: unknown; updatedAt: number }>();
const puts: Array<{ key: string; value: Record<string, unknown> }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost/");
  if (url.pathname === "/api/ui-state" && (init?.method ?? "GET") === "GET") {
    const record = stored.get(url.searchParams.get("key") ?? "") ?? { value: null, updatedAt: 0 };
    return new Response(JSON.stringify(record), { status: 200 });
  }
  if (url.pathname === "/api/ui-state" && init?.method === "PUT") {
    const body = JSON.parse(String(init.body)) as { key: string; value: Record<string, unknown>; updatedAt: number };
    puts.push({ key: body.key, value: body.value });
    stored.set(body.key, { value: body.value, updatedAt: body.updatedAt });
    return new Response("{}", { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

stored.set("voice-assistant", {
  value: { enabled: false, wakePhrase: "  Oye   Omni ", language: "xx", voice: "Z9", announceScope: "voice" },
  updatedAt: 5,
});

const { render } = await import("lit");
const { voiceSettingsRows, formatBytes } = await import("../src/voice-settings.ts");
const store = await import("../src/voice-assistant/settings-store.ts");

const FILES: ModelFile[] = [
  { repo: "a/b", revision: "0".repeat(40), path: "x.onnx", bytes: 900_000_000, sha256: "0", role: "asr" },
  { repo: "c/d", revision: "1".repeat(40), path: "y.onnx", bytes: 400_000_000, sha256: "1", role: "tts" },
];

const calls: string[] = [];
let missing = FILES[0]!.bytes + FILES[1]!.bytes;
let finishDownload: (() => void) | null = null;
const api = async () => ({
  voiceModelStatus: async () => ({
    gpu: { webgpu: true },
    files: FILES,
    totalBytes: 1_300_000_000,
    missingBytes: missing,
  }),
  downloadVoiceModels: (files: readonly ModelFile[], onProgress: (fraction: number) => void) => {
    calls.push(`download:${files.length}`);
    onProgress(0.42);
    return new Promise<void>((resolve) => {
      finishDownload = () => {
        missing = 0;
        onProgress(1);
        resolve();
      };
    });
  },
  deleteVoiceModels: async () => {
    calls.push("delete");
    missing = FILES[0]!.bytes + FILES[1]!.bytes;
  },
  startVoice: async () => void calls.push("start"),
  stopVoice: () => void calls.push("stop"),
});

const host = win.document.createElement("div");
win.document.body.append(host);
const draw = () => render(voiceSettingsRows(draw, api), host);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const option = (group: string, value: string) =>
  host.querySelector<HTMLButtonElement>(`[role="radiogroup"][aria-label="${group}"] [data-value="${value}"]`)!;

test("stored settings are validated field by field over the defaults", async () => {
  draw();
  await settle();
  assert.deepEqual(store.currentVoiceSettings(), {
    enabled: false,
    wakePhrase: "Oye Omni",
    language: "es",
    announceScope: "voice",
    voice: "F1",
    ttsEngine: "supertonic-3",
  });
  assert.deepEqual(store.parseVoiceSettings(null), store.parseVoiceSettings({ wakePhrase: "x".repeat(61) }));
});

test("the voice row offers the switch with the download size before anything is enabled", async () => {
  draw();
  await settle();
  assert.match(host.textContent ?? "", /Asistente de voz/);
  assert.match(host.textContent ?? "", /descarga 1,3 GB/);
  assert.equal(option("Asistente de voz", "off").getAttribute("aria-checked"), "true");
  assert.equal(host.querySelector(".voice-wake-input"), null, "the details stay hidden while voice is off");
});

test("turning it on saves the setting, downloads with progress and then starts the assistant", async () => {
  option("Asistente de voz", "on").click();
  await settle();
  assert.equal(puts.at(-1)!.value.enabled, true);
  assert.deepEqual(calls, ["download:2"]);
  assert.match(host.textContent ?? "", /Descargando… 42%/);
  assert.equal(host.querySelector<HTMLProgressElement>(".voice-models-progress")!.value, 42);
  finishDownload!();
  await settle();
  assert.deepEqual(calls, ["download:2", "start"]);
  assert.match(host.textContent ?? "", /Descargados en este dispositivo \(1,3 GB\)/);
});

test("the wake phrase, language, announce scope and voice persist to ui-state", async () => {
  const input = host.querySelector<HTMLInputElement>(".voice-wake-input")!;
  assert.equal(input.value, "Oye Omni");
  input.value = "   ";
  input.dispatchEvent(new win.Event("change"));
  await settle();
  assert.match(host.textContent ?? "", /Escribe una frase de hasta 60 caracteres/);
  input.value = "Hola   Lucía";
  input.dispatchEvent(new win.Event("change"));
  await settle();
  assert.equal(puts.at(-1)!.value.wakePhrase, "Hola Lucía");

  option("Avisos de tareas", "all").click();
  await settle();
  assert.equal(puts.at(-1)!.value.announceScope, "all");

  const select = host.querySelector<HTMLSelectElement>(".voice-voice-select select")!;
  assert.equal(select.options.length, 10);
  select.value = "M3";
  select.dispatchEvent(new win.Event("change"));
  await settle();
  assert.equal(puts.at(-1)!.value.voice, "M3");

  option("Idioma de voz", "en").click();
  await settle();
  assert.equal(puts.at(-1)!.value.language, "en");
  assert.match(host.textContent ?? "", /Voice assistant/);
  assert.ok(puts.every((put) => put.key === "voice-assistant"));
});

test("removing the models stops the assistant and asks for the download again", async () => {
  host.querySelector<HTMLButtonElement>(".voice-models-remove")!.click();
  await settle();
  assert.deepEqual(calls.slice(-2), ["stop", "delete"]);
  assert.ok(host.querySelector(".voice-models-download"));
});

test("turning it off persists and hides the details", async () => {
  option("Voice assistant", "off").click();
  await settle();
  assert.equal(puts.at(-1)!.value.enabled, false);
  assert.equal(host.querySelector(".voice-wake-input"), null);
});

test("sizes read in the voice language", () => {
  assert.equal(formatBytes(1_287_000_000, "es"), "1,3 GB");
  assert.equal(formatBytes(1_287_000_000, "en"), "1.3 GB");
  assert.equal(formatBytes(401_000_000, "en"), "401 MB");
});

test("the mute flag is a per-device convenience in localStorage", () => {
  assert.equal(store.storedVoiceMuted(), false);
  store.storeVoiceMuted(true);
  assert.equal(store.storedVoiceMuted(), true);
  store.storeVoiceMuted(false);
  assert.equal(win.localStorage.getItem("web-ui:voice-muted"), null);
});
