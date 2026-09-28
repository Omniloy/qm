import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("MCP connector cards start sign-in once per click and offer a different account", async () => {
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
  const starts: Array<{ path: string; body: unknown }> = [];
  let releaseStart!: () => void;
  let connected = true;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/api/connectors/mcp-granola/start")) {
      starts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return Response.json({ error: "boom", message: "start failed" }, { status: 500 });
    }
    if (path.endsWith("/api/connectors"))
      return Response.json({
        providers: {
          "mcp-granola": { kind: "mcp", name: "Granola", available: true, connected, hosts: [] },
          google: { name: "Google Workspace", available: true, connected: false, hosts: [] },
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
    const button = (id: string, label: string) =>
      [...card(id).querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === label);

    await renderConnectors();
    await tick();
    assert.ok(button("mcp-granola", "Use a different account"));
    assert.equal(button("google", "Use a different account"), undefined);

    for (let i = 0; i < 4; i++) button("mcp-granola", "Reconnect")!.click();
    await tick();
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]!.body, { switchAccount: false });
    assert.equal(button("mcp-granola", "Reconnect")!.disabled, true);
    assert.equal(button("mcp-granola", "Use a different account")!.disabled, true);
    releaseStart();
    await tick();
    await tick();
    assert.equal(button("mcp-granola", "Reconnect")!.disabled, false);

    connected = false;
    await renderConnectors();
    await tick();
    assert.ok(button("mcp-granola", "Connect account"));
    button("mcp-granola", "Use a different account")!.click();
    button("mcp-granola", "Use a different account")!.click();
    await tick();
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1]!.body, { switchAccount: true });
    releaseStart();
    await tick();
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
