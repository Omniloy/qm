import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { litFixture } from "./lit-fixture.ts";

const stored = {
  ttsEngine: "supertonic-3",
  asrEngine: "qwen3-asr-0.6b",
  wakePhrase: "Hola Omni",
  pttStyle: "toggle",
  announceScope: "voice",
};

const collected = (f: ReturnType<typeof litFixture>) => JSON.parse(JSON.stringify(f.ui.collect("voice-assistant")));

function mounted() {
  const f = litFixture();
  f.root.innerHTML = '<template data-settings-card="card-voice-assistant"></template>';
  f.ui.settings.mountCards();
  return f;
}

test("voice assistant card is available only for an org scope that returns the setting", () => {
  const f = mounted();
  try {
    const state = f.ui.settings.states.get("voice-assistant");
    f.ui.settings.load({ voiceAssistant: stored }, "org:acme", "voice-assistant");
    assert.equal(state.available, true);
    f.ui.settings.load({ voiceAssistant: stored }, "personal:U1", "voice-assistant");
    assert.equal(state.available, false);
    f.ui.settings.load({}, "org:acme", "voice-assistant");
    assert.equal(state.available, false);
    assert.equal(f.document.getElementById("card-voice-assistant")!.classList.contains("hidden"), true);
  } finally {
    f.dom.window.close();
  }
});

test("voice assistant collect returns exactly the org config body", () => {
  const f = mounted();
  try {
    f.ui.settings.load({ voiceAssistant: { ...stored, extra: "ignored" } }, "org:acme", "voice-assistant");
    assert.deepEqual(collected(f), stored);
    const state = f.ui.settings.states.get("voice-assistant");
    assert.equal(state.dirty, false);
    state.change("wakePhrase", "  Hey   Omni  ");
    assert.deepEqual(collected(f), { ...stored, wakePhrase: "Hey Omni" });
    assert.equal(state.dirty, true);
    state.change("wakePhrase", "   ");
    assert.throws(() => f.ui.collect("voice-assistant"), /Wake phrase/);
  } finally {
    f.dom.window.close();
  }
});

test("voice assistant draft falls back to the defaults for missing fields", () => {
  const f = mounted();
  try {
    f.ui.settings.load({ voiceAssistant: {} }, "org:acme", "voice-assistant");
    assert.deepEqual(collected(f), {
      ttsEngine: "phonon-40m",
      asrEngine: "phonon-2.5",
      wakePhrase: "Oye Omni",
      pttStyle: "hold",
      announceScope: "all",
    });
  } finally {
    f.dom.window.close();
  }
});

test("voice assistant card renders the five controls and edits the draft", () => {
  const f = mounted();
  try {
    f.ui.settings.load({ voiceAssistant: stored }, "org:acme", "voice-assistant");
    const card = f.document.getElementById("card-voice-assistant")!;
    assert.equal(card.classList.contains("hidden"), false);
    for (const field of ["ttsEngine", "asrEngine", "pttStyle", "announceScope"]) {
      const select = card.querySelector<HTMLSelectElement>(`select#voice-${field}`)!;
      assert.ok(select, field);
      assert.equal(select.value, stored[field as keyof typeof stored]);
    }
    const wake = card.querySelector<HTMLInputElement>("input#voice-wakePhrase")!;
    assert.equal(wake.value, "Hola Omni");
    assert.equal(wake.maxLength, 60);
    const tts = card.querySelector<HTMLSelectElement>("#voice-ttsEngine")!;
    tts.value = "phonon-40m";
    tts.dispatchEvent(new f.window.Event("change"));
    assert.equal(f.ui.collect("voice-assistant").ttsEngine, "phonon-40m");
    assert.equal(card.querySelector<HTMLButtonElement>('[data-save="voice-assistant"]')!.disabled, false);
  } finally {
    f.dom.window.close();
  }
});

test("voice assistant card warns when gated models are not servable", () => {
  const f = mounted();
  try {
    f.ui.settings.load({ voiceAssistant: stored }, "org:acme", "voice-assistant");
    const status = () => f.document.getElementById("voice-gated-models")?.textContent?.trim() ?? "";
    assert.equal(status(), "");
    f.ui.settings.voiceModels(false);
    assert.match(status(), /No HF_TOKEN on the web UI service — Phonon-40m falls back to Supertonic 3/);
    f.ui.settings.voiceModels(true);
    assert.equal(status(), "Gated models are servable on the web UI service");
  } finally {
    f.dom.window.close();
  }
});

test("admin shell places and saves the voice assistant card", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('<template data-settings-card="card-voice-assistant"></template>'));
  assert.ok(html.includes('$("card-voice-assistant"),'));
  assert.ok(html.includes('"voice-assistant": "st-voice-assistant"'));
});
