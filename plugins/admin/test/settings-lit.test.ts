import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
const bundle = buildSync({
  entryPoints: [new URL("../ui/settings.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "settingsUI",
  platform: "browser",
}).outputFiles[0]!.text;
function setup() {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    runScripts: "outside-only",
  });
  dom.window.structuredClone = structuredClone;
  dom.window.eval(bundle + "; window.settingsUI=settingsUI; settingsUI.mountCards();");
  return dom;
}
const models = {
  baseModelDefault: "a",
  baseModelOptions: [{ id: "a", name: "Alpha" }],
  harnessDefault: "pi",
  harnessOptions: ["pi", "codex"],
  modelsByHarness: { pi: [{ id: "a", name: "Alpha" }], codex: [{ id: "b", name: "Beta" }] },
  thinkingLevelsByHarness: { pi: ["auto", "high"], codex: ["low"] },
  runtime: { harnessId: "pi", modelId: "a", effortLevel: "high", fastMode: true },
  fastModeHarnessIds: ["pi"],
  fastModeModelIds: ["a"],
  webuiModels: [],
};
test("runtime selection derives compatible model, reasoning, and fast mode from state", () => {
  const dom = setup();
  try {
    dom.window.eval("settingsUI.load(" + JSON.stringify(models) + ',"org:test","runtime")');
    const input = dom.window.document.getElementById("base-harness") as HTMLSelectElement;
    input.value = "codex";
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.deepEqual(JSON.parse(String(dom.window.eval('JSON.stringify(settingsUI.collect("runtime"))'))), {
      harnessId: "codex",
      modelId: "b",
      effortLevel: "low",
      fastMode: false,
    });
    assert.equal((dom.window.document.querySelector('[data-save="runtime"]') as HTMLButtonElement).disabled, false);
  } finally {
    dom.window.close();
  }
});
test("model chips add and remove with stable keyed rendering", () => {
  const dom = setup();
  try {
    dom.window.eval("settingsUI.load(" + JSON.stringify(models) + ',"org:test","webui-models")');
    const select = dom.window.document.getElementById("webui-models-add") as HTMLSelectElement;
    select.value = "b";
    select.dispatchEvent(new dom.window.Event("change"));
    dom.window.document.getElementById("webui-models-add-button")!.click();
    assert.equal(dom.window.eval('settingsUI.collect("webui-models").ids.join()'), "b");
    dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Remove b"]')!.click();
    assert.equal(dom.window.eval('settingsUI.states.get("webui-models").dirty'), false);
  } finally {
    dom.window.close();
  }
});
test("feature flag entries use a compact row that cannot inherit the card grid", async () => {
  const dom = setup();
  try {
    dom.window.eval(`settingsUI.configureFlags({
      loadChoices: async () => [],
      buildSelector: () => document.createElement("button"),
      save: async () => ({ ok: true }),
    })`);
    await dom.window.eval(`settingsUI.loadFlags(
      { featureFlags: [{ featureName: "persistent_subagents", enabledScopes: ["personal:person-with-a-long-name@example.com"] }] },
      "org:test",
    )`);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const list = dom.window.document.getElementById("feature-flag-list")!;
    assert.equal(list.querySelectorAll(".feature-flag-row").length, 1);
    assert.equal(list.querySelector(".setting-row"), null);
    assert.equal(dom.window.getComputedStyle(list.querySelector(".feature-flag-row")!).display, "grid");
    const editor = dom.window.document.querySelector("#card-feature-flags .feature-flag-editor")!;
    assert.ok(editor);
    assert.equal(editor.classList.contains("editor-grid"), false);
  } finally {
    dom.window.close();
  }
});

test("SOUL conflict keeps draft while replacing saved revision and version", () => {
  const dom = setup();
  try {
    dom.window.eval('settingsUI.load({soul:"old",soulVersion:1},"org:test","soul")');
    dom.window.document.getElementById("soul-edit")!.click();
    const input = dom.window.document.getElementById("soul") as HTMLTextAreaElement;
    input.value = "draft <img src=x>";
    input.dispatchEvent(new dom.window.Event("input"));
    dom.window.eval('settingsUI.refreshSoul({soul:"other",soulVersion:2})');
    assert.equal(input.value, "draft <img src=x>");
    assert.equal(dom.window.document.getElementById("soul-saved")!.textContent, "other");
    assert.equal(dom.window.eval('settingsUI.collect("soul").expectedVersion'), 2);
    assert.equal(dom.window.document.querySelector("#card-soul img"), null);
  } finally {
    dom.window.close();
  }
});

test("credential editor derives broker capabilities and preserves write-only secrets", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'settingsUI.configureCredentials({label: id => id,formatTime:String,edit(){},remove(){}}); settingsUI.loadCredentials([],[],[],[],"org:test"); settingsUI.credentialState.begin({slug:"service",name:"Service",host:"api.example.com",updatedAt:10,hasSecret:true,injection:{actor:true},grantees:["org:test"]})',
    );
    const doc = dom.window.document;
    const secret = doc.getElementById("sc-secret") as HTMLInputElement;
    assert.equal(secret.value, "");
    assert.equal(dom.window.eval('"secret" in settingsUI.credentialState.collect()'), false);
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().injection.actor"), true);
    const host = doc.getElementById("sc-host") as HTMLInputElement;
    host.value = "changed.example.com";
    host.dispatchEvent(new dom.window.Event("input"));
    assert.equal(doc.getElementById("sc-cap-host")!.textContent, "changed.example.com and its subdomains");
    assert.equal((doc.getElementById("sc-save") as HTMLButtonElement).disabled, false);
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().expectedUpdatedAt"), 10);
  } finally {
    dom.window.close();
  }
});

test("credential delivery transitions exclude narrower broker grants from env payloads", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'settingsUI.loadCredentials([],[],[],[],"org:test"); settingsUI.credentialState.begin(null); settingsUI.credentialState.change("name","Example");settingsUI.credentialState.change("slug","example");settingsUI.credentialState.change("org",false);settingsUI.credentialState.change("people","person@example.com");settingsUI.credentialState.change("delivery","env");settingsUI.credentialState.change("envkey","EXAMPLE_KEY")',
    );
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().grantees.join()"), "org:test");
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().host"), "");
    assert.equal(dom.window.eval("settingsUI.credentialState.validate(settingsUI.credentialState.collect())"), "");
    dom.window.eval('settingsUI.credentialState.change("envkey","AGENT_SECRET")');
    assert.match(
      String(dom.window.eval("settingsUI.credentialState.validate(settingsUI.credentialState.collect())")),
      /reserved/,
    );
  } finally {
    dom.window.close();
  }
});

test("credential save acknowledges its submitted snapshot and retains newer edits", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'settingsUI.loadCredentials([],[],[],[],"org:test"); settingsUI.credentialState.begin({slug:"test",name:"Old",host:"example.com",updatedAt:1,grantees:["org:test"]});settingsUI.credentialState.change("name","Submitted");window.submitted=settingsUI.credentialState.collect();settingsUI.credentialState.change("name","Newer draft");settingsUI.loadCredentials([{slug:"test",updatedAt:2}],[],[],[],"org:test");settingsUI.credentialState.commit(submitted)',
    );
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().name"), "Newer draft");
    assert.equal(dom.window.eval("settingsUI.credentialState.collect().expectedUpdatedAt"), 2);
    assert.equal(dom.window.eval("settingsUI.credentialState.dirty"), true);
  } finally {
    dom.window.close();
  }
});

test("runtime reasoning choices follow the selected model and preserve legacy defaults", () => {
  const dom = setup();
  try {
    const data = {
      ...models,
      modelsByHarness: {
        pi: [
          { id: "a", effortLevels: ["auto", "adaptive", "default", "high"] },
          { id: "b", effortLevels: ["auto", "high"] },
        ],
      },
      thinkingLevelsByHarness: { pi: ["auto", "adaptive", "default", "high"] },
      runtime: { harnessId: "pi", modelId: "a", effortLevel: "auto" },
    };
    dom.window.eval("settingsUI.load(" + JSON.stringify(data) + ',"org:test","runtime")');
    const select = () => dom.window.document.getElementById("base-effort") as HTMLSelectElement;
    const choices = () => [...select().options].map((option) => [option.value, option.textContent]);
    assert.deepEqual(choices(), [
      ["auto", "Legacy default"],
      ["adaptive", "Auto"],
      ["default", "Provider default"],
      ["high", "High"],
    ]);
    select().value = "adaptive";
    select().dispatchEvent(new dom.window.Event("change"));
    assert.equal(dom.window.eval('settingsUI.collect("runtime").effortLevel'), "adaptive");
    assert.equal(
      choices().some(([value]) => value === "auto"),
      false,
    );
    dom.window.eval('settingsUI.states.get("runtime").change("modelId", "b")');
    assert.deepEqual(choices(), [["high", "High"]]);
    assert.equal(dom.window.eval('settingsUI.collect("runtime").effortLevel'), "high");
    dom.window.eval(
      'settingsUI.states.get("runtime").context.modelsByHarness.pi = [{id:"b"}]; settingsUI.states.get("runtime").changed()',
    );
    assert.deepEqual(choices(), [["high", "High"]]);
  } finally {
    dom.window.close();
  }
});

test("purpose runtime cards independently set and clear overrides using the runtime editor", () => {
  const dom = setup();
  try {
    dom.window.eval(
      "settingsUI.load(" + JSON.stringify({ ...models, cronRuntime: null, subagentRuntime: null }) + ',"org:test")',
    );
    const doc = dom.window.document;
    for (const key of ["cron-runtime", "subagent-runtime"]) {
      const collect = () => JSON.parse(String(dom.window.eval(`JSON.stringify(settingsUI.collect("${key}"))`)));
      assert.deepEqual(collect(), { inherit: true });
      assert.equal(doc.querySelectorAll(`#card-${key}`).length, 1);
      assert.equal((doc.getElementById(`${key}-harness`) as HTMLSelectElement).disabled, true);
      (doc.getElementById(`${key}-inherit`) as HTMLInputElement).click();
      const harness = doc.getElementById(`${key}-harness`) as HTMLSelectElement;
      harness.value = "codex";
      harness.dispatchEvent(new dom.window.Event("change"));
      assert.deepEqual(collect(), { harnessId: "codex", modelId: "b", effortLevel: "auto", fastMode: false });
      (doc.getElementById(`${key}-inherit`) as HTMLInputElement).click();
      assert.deepEqual(collect(), { inherit: true });
      assert.equal(dom.window.eval(`settingsUI.states.get("${key}").dirty`), false);
    }
    assert.equal(dom.window.eval('settingsUI.collect("runtime").fastMode'), true);
    dom.window.eval(
      "settingsUI.load(" +
        JSON.stringify({
          ...models,
          cronRuntime: { harnessId: "codex", modelId: "b", effortLevel: "low", fastMode: false },
          subagentRuntime: null,
        }) +
        ',"org:test")',
    );
    assert.equal((doc.getElementById("cron-runtime-inherit") as HTMLInputElement).checked, false);
    assert.equal((doc.getElementById("cron-runtime-model") as HTMLSelectElement).value, "b");
  } finally {
    dom.window.close();
  }
});
test("personal AI account card says which providers the org requirement applies to", () => {
  const dom = setup();
  try {
    const doc = dom.window.document;
    const note = () => doc.getElementById("model-account-requirement")?.textContent?.trim() ?? null;
    const load = (data: unknown) =>
      dom.window.eval("settingsUI.load(" + JSON.stringify(data) + ',"org:test","model-account-modes")');
    load({ modelAccountModes: { anthropic: "personal", openai: "org" }, individualModelAuth: false });
    assert.equal(note(), null);
    load({ modelAccountModes: { anthropic: "personal", openai: "org" }, individualModelAuth: true });
    assert.match(note()!, /applies only to Claude:/);
    load({ modelAccountModes: { anthropic: "org", openai: "org" }, individualModelAuth: true });
    assert.match(note()!, /no provider allows them, so the requirement has no effect/);
    doc.querySelector<HTMLInputElement>('input[name="model-account-mode-openai"][value="personal"]')!.click();
    assert.match(note()!, /applies only to ChatGPT:/);
  } finally {
    dom.window.close();
  }
});

test("personal AI account card edits one mode per provider and stays org-only", () => {
  const dom = setup();
  try {
    const doc = dom.window.document;
    const card = () => doc.getElementById("card-model-account-modes")!;
    dom.window.eval(
      "settingsUI.load(" +
        JSON.stringify({ modelAccountModes: { anthropic: "org", openai: "personal" } }) +
        ',"org:test","model-account-modes")',
    );
    assert.equal(card().classList.contains("hidden"), false);
    assert.deepEqual(
      [...card().querySelectorAll("legend")].map((legend) => legend.textContent),
      ["Claude", "ChatGPT"],
    );
    const radio = (provider: string, value: string) =>
      card().querySelector<HTMLInputElement>(`input[name="model-account-mode-${provider}"][value="${value}"]`)!;
    assert.equal(radio("anthropic", "org").checked, true);
    assert.equal(radio("openai", "personal").checked, true);
    assert.equal((doc.querySelector('[data-save="model-account-modes"]') as HTMLButtonElement).disabled, true);
    radio("anthropic", "personal").click();
    assert.deepEqual(JSON.parse(String(dom.window.eval('JSON.stringify(settingsUI.collect("model-account-modes"))'))), {
      anthropic: "personal",
      openai: "personal",
    });
    assert.equal((doc.querySelector('[data-save="model-account-modes"]') as HTMLButtonElement).disabled, false);
    dom.window.eval('settingsUI.load({},"org:test","model-account-modes")');
    assert.deepEqual(JSON.parse(String(dom.window.eval('JSON.stringify(settingsUI.collect("model-account-modes"))'))), {
      anthropic: "org",
      openai: "org",
    });
    assert.equal(card().classList.contains("hidden"), true);
    dom.window.eval(
      "settingsUI.load(" +
        JSON.stringify({ modelAccountModes: { anthropic: "org", openai: "org" } }) +
        ',"channel:C1","model-account-modes")',
    );
    assert.equal(card().classList.contains("hidden"), true);
  } finally {
    dom.window.close();
  }
});
test("fast mode access card switches between everyone and a picked list of people", () => {
  const dom = setup();
  const document = dom.window.document;
  const data = {
    ...models,
    fastModeAccess: { people: null, directory: [{ principalId: "carol@acme.com", displayName: "Carol" }] },
  };
  try {
    dom.window.eval("settingsUI.load(" + JSON.stringify(data) + ',"org:test","fast-mode-access")');
    const card = document.getElementById("card-fast-mode-access")!;
    assert.equal(card.classList.contains("hidden"), false);
    assert.deepEqual(JSON.parse(String(dom.window.eval('JSON.stringify(settingsUI.collect("fast-mode-access"))'))), {
      people: null,
    });
    assert.equal(document.getElementById("fast-mode-access-add"), null);
    const limited = card.querySelector<HTMLInputElement>('input[name="fast-mode-access"][value="people"]')!;
    limited.checked = true;
    limited.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.ok(document.getElementById("fast-mode-access-empty"));
    assert.throws(() => dom.window.eval('settingsUI.collect("fast-mode-access")'), /at least one person/);
    assert.equal(
      document.querySelector('#fast-mode-access-options option[value="carol@acme.com"]')?.getAttribute("label"),
      "Carol",
    );
    const input = document.getElementById("fast-mode-access-add") as HTMLInputElement;
    for (const value of ["carol@acme.com", "Erin@Acme.com", "carol@acme.com"]) {
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input"));
      document.getElementById("fast-mode-access-add-button")!.click();
    }
    assert.deepEqual(JSON.parse(String(dom.window.eval('JSON.stringify(settingsUI.collect("fast-mode-access"))'))), {
      people: ["carol@acme.com", "erin@acme.com"],
    });
    assert.match(card.querySelector('[data-person="carol@acme.com"]')!.textContent!, /Carol \(carol@acme\.com\)/);
    assert.equal((card.querySelector('[data-save="fast-mode-access"]') as HTMLButtonElement).disabled, false);
    card.querySelector<HTMLButtonElement>('[aria-label="Remove erin@acme.com"]')!.click();
    assert.deepEqual(
      JSON.parse(String(dom.window.eval('JSON.stringify(settingsUI.collect("fast-mode-access"))'))).people,
      ["carol@acme.com"],
    );
    dom.window.eval(
      "settingsUI.load(" + JSON.stringify({ ...data, fastModeAccess: undefined }) + ',"org:test","fast-mode-access")',
    );
    assert.equal(document.getElementById("card-fast-mode-access")!.classList.contains("hidden"), true);
    dom.window.eval("settingsUI.load(" + JSON.stringify(data) + ',"personal:x","fast-mode-access")');
    assert.equal(document.getElementById("card-fast-mode-access")!.classList.contains("hidden"), true);
  } finally {
    dom.window.close();
  }
});
