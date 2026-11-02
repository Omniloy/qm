import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import type { ModelFile, VoiceSettings } from "../src/voice-assistant/protocol.ts";

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
let refuseNext = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://localhost/");
  if (url.pathname === "/api/ui-state" && (init?.method ?? "GET") === "GET") {
    const record = stored.get(url.searchParams.get("key") ?? "") ?? { value: null, updatedAt: 0 };
    return new Response(JSON.stringify(record), { status: 200 });
  }
  if (url.pathname === "/api/ui-state" && init?.method === "PUT") {
    const body = JSON.parse(String(init.body)) as { key: string; value: Record<string, unknown>; updatedAt: number };
    const existing = stored.get(body.key);
    if (refuseNext > 0 || (existing && existing.updatedAt > body.updatedAt)) {
      refuseNext = Math.max(0, refuseNext - 1);
      return new Response(JSON.stringify({ ok: false, updatedAt: existing?.updatedAt ?? 0 }), { status: 200 });
    }
    puts.push({ key: body.key, value: body.value });
    stored.set(body.key, { value: body.value, updatedAt: body.updatedAt });
    return new Response(JSON.stringify({ ok: true, updatedAt: body.updatedAt }), { status: 200 });
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

const CELIA = "rmLBOdHrfkFym9MM";
const MARCOS = "jvPx8j8zLGQ3utZz";
const PRESTON = "qIxlZ7Ei8KvWlyQH";

const FILES: ModelFile[] = [
  { repo: "a/b", revision: "0".repeat(40), path: "x.onnx", bytes: 900_000_000, sha256: "0", role: "asr" },
  { repo: "c/d", revision: "1".repeat(40), path: "y.onnx", bytes: 400_000_000, sha256: "1", role: "tts" },
];

const calls: string[] = [];
const statusFor: VoiceSettings[] = [];
let missing = FILES[0]!.bytes + FILES[1]!.bytes;
let finishDownload: (() => void) | null = null;
let failDownload: string | null = null;
const api = async () => ({
  voiceModelStatus: async (settings: VoiceSettings) => {
    statusFor.push(settings);
    return {
      gpu: { webgpu: true },
      files: FILES,
      totalBytes: 1_300_000_000,
      missingBytes: missing,
      asrEngine: "qwen3-asr-0.6b" as const,
    };
  },
  downloadVoiceModels: (files: readonly ModelFile[], onProgress: (fraction: number) => void) => {
    calls.push(`download:${files.length}`);
    if (failDownload) return Promise.reject(new Error(failDownload));
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
    voice: CELIA,
    ttsEngine: "phonon-40m",
    asrEngine: "phonon-2.5",
    micMode: "open",
    pttStyle: "hold",
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
  assert.match(host.textContent ?? "", /Phonon 2\.5 no está disponible en este dispositivo; se usa Qwen3-ASR 0\.6B\./);
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
  assert.deepEqual(
    [...select.querySelectorAll("optgroup")].map((group) => [group.label, group.children.length]),
    [
      ["Español (España)", 13],
      ["Español (México)", 12],
    ],
  );
  assert.equal(select.options[0]!.textContent, "Alba (España)");
  const seen = statusFor.length;
  select.value = MARCOS;
  select.dispatchEvent(new win.Event("change"));
  await settle();
  assert.equal(puts.at(-1)!.value.voice, MARCOS);
  assert.equal(statusFor.length, seen + 1, "a voice change checks what is left to download");
  assert.equal(statusFor.at(-1)!.voice, MARCOS);

  select.value = "*";
  select.dispatchEvent(new win.Event("change"));
  await settle();
  const all = host.querySelector<HTMLSelectElement>(".voice-voice-select select")!;
  assert.equal(all.querySelectorAll("optgroup").length, 4);
  all.value = PRESTON;
  all.dispatchEvent(new win.Event("change"));
  await settle();
  assert.equal(puts.at(-1)!.value.voice, PRESTON);
  assert.equal(puts.at(-1)!.value.language, "en", "a voice from another language switches the language too");
  option("Voice language", "es").click();
  await settle();
  assert.equal(puts.at(-1)!.value.voice, MARCOS, "the language switch keeps the gender");

  option("Idioma de voz", "en").click();
  await settle();
  assert.equal(puts.at(-1)!.value.language, "en");
  assert.match(host.textContent ?? "", /Voice assistant/);
  assert.ok(puts.every((put) => put.key === "voice-assistant"));
});

test("the microphone mode, push-to-talk style and engines persist, and engines recheck the download", async () => {
  assert.ok(host.querySelector(".voice-wake-input"), "open mic asks for the wake phrase");
  option("Microphone mode", "push").click();
  await settle();
  assert.equal(puts.at(-1)!.value.micMode, "push");
  assert.equal(host.querySelector(".voice-wake-input"), null, "push to talk needs no wake phrase");
  assert.equal(option("Push to talk", "hold").getAttribute("aria-checked"), "true");
  option("Push to talk", "toggle").click();
  await settle();
  assert.equal(puts.at(-1)!.value.pttStyle, "toggle");

  const seen = statusFor.length;
  const tts = host.querySelector<HTMLSelectElement>(".voice-tts-select select")!;
  assert.deepEqual(
    [...tts.options].map((o) => o.textContent),
    ["Phonon 40M (default)", "Supertonic 3"],
  );
  tts.value = "supertonic-3";
  tts.dispatchEvent(new win.Event("change"));
  await settle();
  assert.equal(puts.at(-1)!.value.ttsEngine, "supertonic-3");
  assert.equal(statusFor.at(-1)!.ttsEngine, "supertonic-3");
  assert.match(
    host.textContent ?? "",
    /Phonon 2\.5 is not available on this device; Qwen3-ASR 0\.6B is used instead\./,
  );
  const asr = host.querySelector<HTMLSelectElement>(".voice-asr-select select")!;
  asr.value = "qwen3-asr-0.6b";
  asr.dispatchEvent(new win.Event("change"));
  await settle();
  assert.equal(puts.at(-1)!.value.asrEngine, "qwen3-asr-0.6b");
  assert.doesNotMatch(host.textContent ?? "", /not available yet/);
  assert.equal(statusFor.length, seen + 2);
  const voices = host.querySelector<HTMLSelectElement>(".voice-voice-select select")!;
  assert.equal(voices.querySelectorAll("optgroup").length, 0, "Supertonic voices are one list");
  assert.equal(voices.options.length, 10);

  option("Microphone mode", "open").click();
  await settle();
  assert.ok(host.querySelector(".voice-wake-input"));
});

test("removing the models stops the assistant and asks for the download again", async () => {
  host.querySelector<HTMLButtonElement>(".voice-models-remove")!.click();
  await settle();
  assert.deepEqual(calls.slice(-2), ["stop", "delete"]);
  assert.ok(host.querySelector(".voice-models-download"));
});

test("a gated model the server cannot fetch explains the missing token", async () => {
  failDownload = "model_download_failed:gradium/phonon-40m-multilingual@x/model.q8.gguf:503";
  host.querySelector<HTMLButtonElement>(".voice-models-download")!.click();
  await settle();
  failDownload = null;
  assert.match(host.textContent ?? "", /Ask for HF_TOKEN to be configured/);
});

test("turning it off persists and hides the details", async () => {
  option("Voice assistant", "off").click();
  await settle();
  assert.equal(puts.at(-1)!.value.enabled, false);
  assert.equal(host.querySelector(".voice-wake-input"), null);
});

test("a save merges its change over what another tab stored meanwhile", async () => {
  const record = stored.get("voice-assistant")!;
  stored.set("voice-assistant", {
    value: { ...(record.value as Record<string, unknown>), wakePhrase: "Hola Omni" },
    updatedAt: record.updatedAt + 1,
  });
  await store.saveVoiceSettings({ voice: "F2" });
  const saved = stored.get("voice-assistant")!.value as Record<string, unknown>;
  assert.equal(saved.wakePhrase, "Hola Omni");
  assert.equal(saved.voice, "F2");
  assert.equal(store.currentVoiceSettings().wakePhrase, "Hola Omni");
});

test("a refused save retries over the stored value and gives up after repeated refusals", async () => {
  refuseNext = 1;
  await store.saveVoiceSettings({ voice: "M1" });
  assert.equal((stored.get("voice-assistant")!.value as Record<string, unknown>).voice, "M1");
  refuseNext = 10;
  await assert.rejects(store.saveVoiceSettings({ voice: "M2" }), /voice_settings_conflict/);
  refuseNext = 0;
  assert.equal(store.currentVoiceSettings().voice, "M1");
});

test("sizes read in the voice language", () => {
  assert.equal(formatBytes(1_287_000_000, "es"), "1,3 GB");
  assert.equal(formatBytes(1_287_000_000, "en"), "1.3 GB");
  assert.equal(formatBytes(401_000_000, "en"), "401 MB");
  assert.equal(formatBytes(256_136, "es"), "0,3 MB");
});

test("the mute flag is a per-device convenience in localStorage", () => {
  assert.equal(store.storedVoiceMuted(), false);
  store.storeVoiceMuted(true);
  assert.equal(store.storedVoiceMuted(), true);
  store.storeVoiceMuted(false);
  assert.equal(win.localStorage.getItem("web-ui:voice-muted"), null);
});
