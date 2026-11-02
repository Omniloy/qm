import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import type { ModelFile, TtsEngineId, VoicePreferences } from "../src/voice-assistant/protocol.ts";

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
const statusFor: VoicePreferences[] = [];
let missing = FILES[0]!.bytes + FILES[1]!.bytes;
let finishDownload: (() => void) | null = null;
let failDownload: string | null = null;
let orgTts: TtsEngineId = "phonon-40m";
let gatedMissing = false;
const api = async () => ({
  voiceModelStatus: async (preferences: VoicePreferences) => {
    statusFor.push(preferences);
    return {
      gpu: { webgpu: true },
      files: FILES,
      totalBytes: 1_300_000_000,
      missingBytes: missing,
      asrEngine: "qwen3-asr-0.6b" as const,
      ttsEngine: orgTts === "phonon-40m" && gatedMissing ? ("supertonic-3" as const) : orgTts,
      configuredTtsEngine: orgTts,
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
const radiogroups = () =>
  [...host.querySelectorAll<HTMLElement>('[role="radiogroup"]')].map((group) => group.getAttribute("aria-label"));

test("stored preferences are validated field by field and keep only the user's own choices", async () => {
  draw();
  await settle();
  assert.deepEqual(store.currentVoicePreferences(), {
    enabled: false,
    language: "es",
    voice: CELIA,
    micMode: "open",
  });
});

test("the voice row offers the switch with the download size before anything is enabled", async () => {
  draw();
  await settle();
  assert.match(host.textContent ?? "", /Asistente de voz/);
  assert.match(host.textContent ?? "", /descarga 1,3 GB/);
  assert.equal(option("Asistente de voz", "off").getAttribute("aria-checked"), "true");
  assert.equal(host.querySelector(".voice-models-row"), null, "the details stay hidden while voice is off");
});

test("turning it on saves the setting, downloads with progress and then starts the assistant", async () => {
  option("Asistente de voz", "on").click();
  await settle();
  assert.deepEqual(puts.at(-1)!.value, { enabled: true, language: "es", voice: CELIA, micMode: "open" });
  assert.deepEqual(calls, ["download:2"]);
  assert.match(host.textContent ?? "", /Descargando… 42%/);
  assert.equal(host.querySelector<HTMLProgressElement>(".voice-models-progress")!.value, 42);
  finishDownload!();
  await settle();
  assert.deepEqual(calls, ["download:2", "start"]);
  assert.match(host.textContent ?? "", /Descargados en este dispositivo \(1,3 GB\)/);
  assert.equal(host.querySelector(".voice-engine-note")!.textContent, "Motor de voz: Phonon 40M.");
});

test("the user sees only the on switch, mic mode, language and voice", () => {
  assert.deepEqual(radiogroups(), ["Asistente de voz", "Modo de micrófono", "Idioma de voz"]);
  assert.ok(host.querySelector(".voice-voice-select select"));
  for (const gone of [".voice-wake-input", ".voice-tts-select", ".voice-asr-select"])
    assert.equal(host.querySelector(gone), null, `${gone} is an admin setting`);
  assert.doesNotMatch(host.textContent ?? "", /Avisos de tareas|Frase de activación|Mantener pulsado/);
});

test("language and voice persist to ui-state", async () => {
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

test("the microphone mode offers open, push and off, and rechecks the download", async () => {
  assert.deepEqual(
    [...host.querySelectorAll('[aria-label="Microphone mode"] [role="radio"]')].map((o) => o.textContent?.trim()),
    ["Open mic", "Push to talk", "Mic off"],
  );
  const seen = statusFor.length;
  option("Microphone mode", "off").click();
  await settle();
  assert.equal(puts.at(-1)!.value.micMode, "off");
  assert.equal(statusFor.length, seen + 1, "turning the mic off drops the recognition download");
  option("Microphone mode", "push").click();
  await settle();
  assert.equal(puts.at(-1)!.value.micMode, "push");
  assert.deepEqual(Object.keys(puts.at(-1)!.value).sort(), ["enabled", "language", "micMode", "voice"]);
});

test("the voice list follows the engine the organisation configured", async () => {
  orgTts = "supertonic-3";
  option("Microphone mode", "open").click();
  await settle();
  assert.equal(host.querySelector(".voice-engine-note")!.textContent, "Speech engine: Supertonic 3.");
  const voices = host.querySelector<HTMLSelectElement>(".voice-voice-select select")!;
  assert.equal(voices.querySelectorAll("optgroup").length, 0, "Supertonic voices are one list");
  assert.equal(voices.options.length, 10);
  orgTts = "phonon-40m";
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
  assert.match(host.textContent ?? "", /Ask an administrator to configure HF_TOKEN/);
});

test("a server without gated access says which speech engine is used instead", async () => {
  gatedMissing = true;
  option("Microphone mode", "push").click();
  await settle();
  gatedMissing = false;
  assert.equal(
    host.querySelector(".voice-engine-note")!.textContent,
    "Speech engine: Supertonic 3 (Phonon 40M is not available right now).",
  );
});

test("turning it off persists and hides the details", async () => {
  option("Voice assistant", "off").click();
  await settle();
  assert.equal(puts.at(-1)!.value.enabled, false);
  assert.equal(host.querySelector(".voice-models-row"), null);
});

test("a save merges its change over what another tab stored meanwhile", async () => {
  const record = stored.get("voice-assistant")!;
  stored.set("voice-assistant", {
    value: { ...(record.value as Record<string, unknown>), micMode: "off" },
    updatedAt: record.updatedAt + 1,
  });
  await store.saveVoiceSettings({ voice: "F2" });
  const saved = stored.get("voice-assistant")!.value as Record<string, unknown>;
  assert.equal(saved.micMode, "off");
  assert.equal(saved.voice, "F2");
  assert.equal(store.currentVoicePreferences().micMode, "off");
});

test("a refused save retries over the stored value and gives up after repeated refusals", async () => {
  refuseNext = 1;
  await store.saveVoiceSettings({ voice: "M1" });
  assert.equal((stored.get("voice-assistant")!.value as Record<string, unknown>).voice, "M1");
  refuseNext = 10;
  await assert.rejects(store.saveVoiceSettings({ voice: "M2" }), /voice_settings_conflict/);
  refuseNext = 0;
  assert.equal(store.currentVoicePreferences().voice, "M1");
});

test("saves land in the order they were made even when an earlier one waits on a download", async () => {
  let finishFirst: () => void = () => undefined;
  const first = store.saveVoiceSettings({ voice: "M2" }, () => new Promise<void>((resolve) => (finishFirst = resolve)));
  const second = store.saveVoiceSettings({ voice: "F3" });
  await settle();
  finishFirst();
  await Promise.all([first, second]);
  assert.equal((stored.get("voice-assistant")!.value as Record<string, unknown>).voice, "F3");
  assert.equal(store.currentVoicePreferences().voice, "F3");
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
