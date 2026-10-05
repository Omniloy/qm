import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildGovernanceUI } from "../src/governance-bundle.ts";
import { describeChatgptAccount, describeSubscription } from "../ui/model-subscriptions.ts";

const bundle = buildGovernanceUI();
type Call = { method: string; path: string; body?: any };

function fixture(routes: Record<string, (body?: any) => { ok: boolean; status?: number; data: any }>) {
  const dom = new JSDOM(
    `<template data-settings-card="card-claude-subscription"></template>
     <template data-settings-card="card-chatgpt-subscription"></template>
     <template data-settings-card="card-model-catalog"></template>
     <template data-settings-card="custom-provider-dialog"></template>`,
    { runScripts: "outside-only" },
  );
  dom.window.structuredClone = structuredClone;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.eval(bundle + ";window.governanceUI = governanceUI; governanceUI.mountCards();");
  const ui = (dom.window as any).governanceUI;
  const calls: Call[] = [];
  const api = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
    const route = routes[method + " " + path.split("?")[0]];
    return route ? route(body) : { ok: false, status: 404, data: null };
  };
  ui.modelCatalog.configure({ api, orgScope: () => "org:acme" });
  ui.modelSubscriptions.configure({ api });
  ui.settings.configureProviders({ api, refresh: async () => {} });
  return { dom, ui, calls, doc: dom.window.document };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const catalogRoutes = (webuiModels: string[]) => ({
  "GET /api/model-providers": () => ({
    ok: true,
    data: {
      models: [
        { id: "claude-a", name: "Claude A", provider: "anthropic" },
        { id: "claude-b", name: "Claude B", provider: "anthropic" },
        { id: "gpt-x", name: "GPT X", provider: "openai" },
        { id: "or-1", name: "Router One", provider: "openrouter" },
        { id: "or-2", name: "Router Two", provider: "openrouter" },
      ],
    },
  }),
  "GET /api/scopes/org%3Aacme": () => ({
    ok: true,
    data: { webuiModels, webuiModelDefaults: ["claude-a"], modelClassifications: { "gpt-x": "hidden" } },
  }),
  "PUT /api/scopes/org%3Aacme/webui-models": () => ({ ok: true, data: {} }),
  "PUT /api/scopes/org%3Aacme/model-classifications": () => ({ ok: true, data: {} }),
  "GET /api/model-providers/anthropic/models": () => ({
    ok: true,
    data: { new: [{ id: "claude-c", displayName: "Claude C" }], missing: [{ id: "claude-b" }] },
  }),
});

test("the model catalog groups by provider, collapses OpenRouter behind search, and reorders the picker", async () => {
  const { dom, ui, calls, doc } = fixture(catalogRoutes(["claude-b", "claude-a"]));
  try {
    await ui.modelCatalog.load();
    const groups = [...doc.querySelectorAll("#model-catalog-rows tr.catalog-group td")].map((td) => td.textContent);
    assert.deepEqual(
      groups.map((text) => text!.replace(/\s+/g, " ").trim()),
      ["Anthropic2 in picker", "OpenAI0 in picker", "OpenRouter0 in picker · 2 more available"],
    );
    const ids = () => [...doc.querySelectorAll("#model-catalog-rows td.mono")].map((td) => td.textContent);
    assert.deepEqual(ids(), ["claude-b", "claude-a", "gpt-x"]);
    const hidden = [...doc.querySelectorAll("#model-catalog-rows tr")].find((tr) => tr.textContent!.includes("gpt-x"));
    assert.equal(hidden!.className, "retired");

    const search = doc.querySelector<HTMLInputElement>("#model-catalog-rows tr.catalog-search input")!;
    search.value = "two";
    search.dispatchEvent(new dom.window.Event("input"));
    assert.deepEqual(ids(), ["claude-b", "claude-a", "gpt-x", "or-2"]);

    const down = doc.querySelector<HTMLButtonElement>('#model-catalog-rows button[title="Move down"]')!;
    down.click();
    await tick();
    const put = calls.find((call) => call.path.endsWith("/webui-models"));
    assert.deepEqual(put!.body, { ids: ["claude-a", "claude-b"] });
  } finally {
    dom.window.close();
  }
});

test("classifying and syncing a provider call the catalog routes and surface new and missing models", async () => {
  const { dom, ui, calls, doc } = fixture(catalogRoutes([]));
  try {
    await ui.modelCatalog.load();
    const select = doc.querySelector<HTMLSelectElement>("#model-catalog-rows select")!;
    select.value = "legacy";
    select.dispatchEvent(new dom.window.Event("change"));
    await tick();
    assert.deepEqual(calls.find((call) => call.path.endsWith("/model-classifications"))!.body, {
      modelId: "claude-a",
      status: "legacy",
    });

    doc.querySelector<HTMLButtonElement>('[data-discover="anthropic"]')!.click();
    await tick();
    await tick();
    assert.match(doc.getElementById("st-model-catalog")!.textContent!, /Anthropic: 1 new, 1 missing\./);
    assert.match(doc.getElementById("model-catalog-rows")!.textContent!, /missing from provider/);
    const add = [...doc.querySelectorAll<HTMLButtonElement>("#model-catalog-rows button")].find(
      (button) => button.textContent!.trim() === "Add to catalog",
    )!;
    add.click();
    const dialog = doc.getElementById("custom-provider-dialog") as HTMLDialogElement;
    assert.equal(dialog.open, true);
    assert.equal((doc.getElementById("custom-provider-id") as HTMLInputElement).value, "anthropic-direct");
    assert.equal((doc.getElementById("custom-provider-id") as HTMLInputElement).disabled, false);
    assert.equal((doc.getElementById("custom-provider-models") as HTMLTextAreaElement).value, "claude-c | Claude C");
  } finally {
    dom.window.close();
  }
});

test("the Claude subscription card validates, saves, and reports the token's remaining life", async () => {
  let configured = false;
  const { dom, ui, calls, doc } = fixture({
    "GET /api/harness-auth": () => ({
      ok: true,
      data: {
        harnesses: [
          configured
            ? { harnessId: "claude", configured: true, updatedAt: new Date().toISOString(), updatedBy: "ops" }
            : { harnessId: "claude", configured: false },
        ],
      },
    }),
    "PUT /api/harness-auth/claude": () => {
      configured = true;
      return { ok: true, data: {} };
    },
    "GET /api/codex-auth": () => ({ ok: false, status: 503, data: null }),
  });
  try {
    await ui.modelSubscriptions.load();
    assert.match(doc.getElementById("harness-claude-state")!.textContent!, /No subscription configured/);
    assert.equal((doc.getElementById("harness-claude-delete") as HTMLButtonElement).disabled, true);
    assert.equal((doc.getElementById("codex-auth-start") as HTMLButtonElement).disabled, true);
    assert.match(doc.getElementById("codex-auth-state")!.textContent!, /No ChatGPT proxy/);

    doc.getElementById("harness-claude-save")!.click();
    assert.match(doc.getElementById("st-harness-claude")!.textContent!, /Paste the token/);
    const input = doc.getElementById("harness-claude-token") as HTMLInputElement;
    input.value = "sk-ant-oat01-x";
    input.dispatchEvent(new dom.window.Event("input"));
    doc.getElementById("harness-claude-save")!.click();
    await tick();
    await tick();
    assert.deepEqual(calls.find((call) => call.method === "PUT")!.body, { token: "sk-ant-oat01-x" });
    assert.match(
      doc.getElementById("harness-claude-state")!.textContent!,
      /Active, added .* by ops — expires in 365 days\./,
    );
    assert.equal((doc.getElementById("harness-claude-delete") as HTMLButtonElement).disabled, false);
  } finally {
    dom.window.close();
  }
});

test("the ChatGPT card runs the paste-back sign-in and shows the connected account", async () => {
  let signedIn = false;
  const { dom, ui, calls, doc } = fixture({
    "GET /api/harness-auth": () => ({ ok: true, data: { harnesses: [] } }),
    "GET /api/codex-auth": () => ({
      ok: true,
      data: { accounts: signedIn ? [{ name: "acct", email: "ops@acme.test", status: "active" }] : [] },
    }),
    "POST /api/codex-auth/start": () => ({
      ok: true,
      data: { url: "https://auth.openai.com/x", expiresAt: Date.now() + 300_000 },
    }),
    "POST /api/codex-auth/complete": () => {
      signedIn = true;
      return { ok: true, data: {} };
    },
  });
  try {
    await ui.modelSubscriptions.load();
    assert.match(doc.getElementById("codex-auth-state")!.textContent!, /No ChatGPT account connected/);
    doc.getElementById("codex-auth-start")!.click();
    await tick();
    assert.equal(doc.getElementById("codex-auth-link")!.getAttribute("href"), "https://auth.openai.com/x");
    assert.match(doc.getElementById("codex-auth-countdown")!.textContent!, /expires in [45]:\d\d/);
    const callback = doc.getElementById("codex-auth-callback") as HTMLInputElement;
    callback.value = "http://localhost:1455/auth/callback?code=c&state=s";
    callback.dispatchEvent(new dom.window.Event("input"));
    doc.getElementById("codex-auth-complete")!.click();
    await tick();
    await tick();
    await tick();
    assert.deepEqual(calls.find((call) => call.path === "/api/codex-auth/complete")!.body, {
      callback: "http://localhost:1455/auth/callback?code=c&state=s",
    });
    assert.equal(doc.getElementById("codex-auth-step"), null);
    assert.match(doc.getElementById("codex-auth-state")!.textContent!, /^Signed in as ops@acme\.test\.$/);
    assert.match(doc.getElementById("st-codex-auth")!.textContent!, /Signed in\. GPT models now bill/);
    assert.ok(doc.getElementById("card-chatgpt-subscription")!.classList.contains("sv-models"));
    assert.ok(doc.getElementById("card-claude-subscription")!.classList.contains("sv-models"));
  } finally {
    dom.window.close();
  }
});

test("a setup token warns in its last month and reads expired after a year", () => {
  const added = Date.UTC(2026, 0, 1);
  const status = { configured: true, updatedAt: new Date(added).toISOString() };
  assert.match(describeSubscription(status, added + 340 * 86_400_000), /expires in 25 days, generate a new one soon\./);
  assert.match(describeSubscription(status, added + 366 * 86_400_000), /expired, generate a new one\./);
  assert.match(describeSubscription(null), /No subscription configured/);
});

test("the ChatGPT card names the plan and when a reached usage limit resets", async () => {
  const resetsAt = Date.UTC(2026, 9, 3, 18, 3);
  const { dom, ui, doc } = fixture({
    "GET /api/harness-auth": () => ({ ok: true, data: { harnesses: [] } }),
    "GET /api/codex-auth": () => ({
      ok: true,
      data: {
        accounts: [
          {
            name: "acct",
            email: "ops@acme.test",
            status: "error",
            plan: "prolite",
            usageLimit: { windowMinutes: 10080, resetsAt },
          },
        ],
      },
    }),
  });
  try {
    await ui.modelSubscriptions.load();
    assert.equal(
      doc.getElementById("codex-auth-state")!.textContent,
      "Signed in as ops@acme.test (ChatGPT Pro Lite). Weekly usage limit reached; resets Sat 3 Oct, 18:03 UTC.",
    );
    assert.equal((doc.getElementById("codex-auth-start") as HTMLButtonElement).disabled, false);
    assert.equal((doc.getElementById("codex-auth-delete") as HTMLButtonElement).disabled, false);
  } finally {
    dom.window.close();
  }
});

test("a ChatGPT account summary falls back to its status when nothing more is known", () => {
  assert.equal(describeChatgptAccount({ name: "a", status: "error" }), "Signed in as a (error).");
  assert.equal(
    describeChatgptAccount({ name: "a", email: "a@x.test", status: "active", plan: "plus" }),
    "Signed in as a@x.test (ChatGPT Plus).",
  );
  assert.equal(
    describeChatgptAccount({ name: "a", status: "error", plan: "team" }),
    "Signed in as a (ChatGPT Team, error).",
  );
  assert.equal(
    describeChatgptAccount({ name: "a", status: "error", usageLimit: {} }),
    "Signed in as a. Usage limit reached.",
  );
  assert.equal(
    describeChatgptAccount({ name: "a", status: "error", usageLimit: { windowMinutes: 300 } }),
    "Signed in as a. 5-hour usage limit reached.",
  );
});
