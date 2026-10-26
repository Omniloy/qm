import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const APPS = [
  ["mail", "Mail"],
  ["calendar", "Calendar"],
  ["teams-chats", "Teams chats"],
  ["teams-channels", "Teams channels"],
  ["meeting-transcripts", "Meeting transcripts"],
  ["onedrive", "OneDrive"],
  ["sharepoint", "SharePoint"],
] as const;

test("the connected Microsoft 365 card opens app settings from its gear and saves the switches", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/keychain",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    InputEvent: dom.window.InputEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: undefined,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  const disabled = new Set<string>();
  const saves: unknown[] = [];
  const apps = () => APPS.map(([id, label]) => ({ id, label, enabled: !disabled.has(id) }));
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/api/connectors/microsoft/apps")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { apps: Record<string, boolean> };
      saves.push(body);
      for (const [id, on] of Object.entries(body.apps)) {
        if (on) disabled.delete(id);
        else disabled.add(id);
      }
      return Response.json({ ok: true, provider: "microsoft", apps: apps() });
    }
    if (path.endsWith("/api/connectors"))
      return Response.json({
        providers: {
          microsoft: { available: true, connected: true, hosts: [], apps: apps() },
          google: { available: true, connected: true, hosts: [] },
        },
      });
    return Response.json({});
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderConnectors } = await vite.ssrLoadModule("/src/connectors.ts");
    appState.me = { user: "alice", org: "acme" };
    appState.currentView = "keychain";
    appState.mainEl = document.querySelector("#app");
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-connector="${id}"]`)!;
    const gear = () => card("microsoft").querySelector<HTMLButtonElement>('[aria-label="Microsoft 365 settings"]');
    const switches = () => [...document.querySelectorAll<HTMLButtonElement>(".kc-app-settings [role=switch]")];

    await renderConnectors();
    await tick();
    assert.match(card("microsoft").textContent ?? "", /Microsoft 365/);
    assert.ok(gear(), "the connected Microsoft 365 card has a settings gear");
    assert.equal(card("google").querySelector('[aria-label$=" settings"]'), null, "providers without apps have none");

    gear()!.click();
    await tick();
    assert.deepEqual(
      switches().map((el) => [el.dataset.app, el.getAttribute("aria-checked")]),
      APPS.map(([id]) => [id, "true"]),
    );
    switches()
      .find((el) => el.dataset.app === "mail")!
      .click();
    switches()
      .find((el) => el.dataset.app === "sharepoint")!
      .click();
    document.querySelector<HTMLButtonElement>(".kc-app-settings-save")!.click();
    await tick();
    await tick();
    assert.equal(saves.length, 1);
    assert.deepEqual((saves[0] as { apps: Record<string, boolean> }).apps, {
      mail: false,
      calendar: true,
      "teams-chats": true,
      "teams-channels": true,
      "meeting-transcripts": true,
      onedrive: true,
      sharepoint: false,
    });
    assert.equal(document.querySelector(".kc-app-settings"), null, "saving closes the dialog");
    assert.match(document.body.textContent ?? "", /Saved Microsoft 365 settings/);

    await renderConnectors();
    await tick();
    gear()!.click();
    await tick();
    assert.deepEqual(
      switches()
        .filter((el) => el.getAttribute("aria-checked") === "false")
        .map((el) => el.dataset.app),
      ["mail", "sharepoint"],
      "the saved switches come back after a reload",
    );
    document.querySelector<HTMLButtonElement>(".kc-app-settings [data-dialog-cancel]")!.click();
    await tick();
    assert.equal(document.querySelector(".kc-app-settings"), null);
    assert.equal(saves.length, 1, "cancel does not save");
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
