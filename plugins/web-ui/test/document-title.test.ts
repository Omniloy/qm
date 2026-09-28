import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { activeSessionForDocumentTitle, documentTitle, productTitle } from "../src/document-title.ts";

const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("page titles retain the static product title", () => {
  assert.ok(index.includes(`<title>${productTitle()}</title>`));
  assert.equal(documentTitle("chats", "Quarterly planning", true), `Quarterly planning · ${productTitle()}`);
  assert.equal(documentTitle(), productTitle());
});

test("page titles carry the configured product name", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM('<meta name="brand-self-label" content="Acme Agent">').window.document,
  });
  try {
    assert.equal(documentTitle(), "Acme Agent · Web");
    assert.equal(documentTitle("files"), "Files · Acme Agent · Web");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: Document }).document;
  }
});

test("chat and non-chat views have useful fallbacks", () => {
  assert.equal(documentTitle("chats"), `Chats · ${productTitle()}`);
  assert.equal(documentTitle("chats", null, true), `New chat · ${productTitle()}`);
  assert.equal(documentTitle("contexts"), `Projects · ${productTitle()}`);
  assert.equal(documentTitle("files"), `Files · ${productTitle()}`);
  assert.equal(documentTitle("keychain"), `Keychain · ${productTitle()}`);
});

test("active session selection follows conversation switches and title updates", () => {
  const sessions = [
    { id: "old", threadRef: "old-thread", title: "Old title" },
    { id: "new", threadRef: "new-thread", title: "New title" },
  ];
  const current: { openingKey: string | null; sessionId: string | null; threadRef: string | null } = {
    openingKey: null,
    sessionId: "old",
    threadRef: "old-thread",
  };

  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "Old title");
  current.openingKey = "new";
  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "New title");
  sessions[1].title = "Server-generated title";
  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "Server-generated title");
  current.openingKey = null;
  current.sessionId = "new";
  assert.equal(activeSessionForDocumentTitle(sessions, current)?.title, "Server-generated title");
});

test("document title follows session switches, split-pane focus, and sign-out", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: "http://localhost/web-ui/" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    fetch: globalThis.fetch,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState, signOut, syncDocumentTitle } = await vite.ssrLoadModule("/src/shell.ts");
    const { mainConversation } = await vite.ssrLoadModule("/src/conversations.ts");
    const { openSession, refreshSessions, sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
    const { mountRestoredCanvas, beginSessionDrag } = await vite.ssrLoadModule("/src/split.ts");
    const oldSession = { id: "old", threadRef: "web:old", scopeId: "personal:tester", title: "Old title" };
    const newSession = { id: "new", threadRef: "web:new", scopeId: "personal:tester", title: "New title" };
    sessionsState.list = [oldSession, newSession];
    appState.me = { user: "tester", org: "test" };
    appState.currentView = "chats";
    appState.mainEl = document.createElement("main");
    appState.listEl = document.createElement("aside");
    document.body.append(appState.listEl, appState.mainEl);
    mainConversation().state.sessionId = "old";
    mainConversation().state.threadRef = "web:old";
    syncDocumentTitle();
    assert.equal(document.title, `Old title · ${productTitle()}`);
    mainConversation().state.sessionId = "new";
    mainConversation().state.threadRef = "web:new";
    syncDocumentTitle();
    assert.equal(document.title, `New title · ${productTitle()}`);

    globalThis.fetch = async (input) => {
      const session = String(input).includes("/sessions/new") ? newSession : oldSession;
      return Response.json({
        scopeId: "personal:tester",
        approvedHarnesses: [],
        modelsByHarness: {},
        modelCatalog: {},
        effective: { harnessId: "pi", modelId: "" },
        session,
        entries: [],
        sessions: sessionsState.list,
        contexts: [],
      });
    };
    mountRestoredCanvas();
    await openSession(oldSession);
    beginSessionDrag(newSession);
    document
      .querySelector(".zone-right")!
      .dispatchEvent(new dom.window.Event("drop", { bubbles: true, cancelable: true }));
    assert.equal(document.title, `New title · ${productTitle()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const paneTitles = () =>
      Array.from(document.querySelectorAll(".split-pane-title-text"), (node) => node.textContent?.trim());
    const refreshTitles = async (oldTitle: string, newTitle: string) => {
      globalThis.fetch = async () =>
        Response.json({
          sessions: [
            { ...oldSession, title: oldTitle },
            { ...newSession, title: newTitle },
          ],
        });
      assert.equal(await refreshSessions({ silent: true }), true);
    };
    const focusPane = (index: number) => {
      document
        .querySelectorAll(".dv-tab")
        .item(index)
        .dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    };
    assert.deepEqual(paneTitles(), ["Old title", "New title"]);
    await refreshTitles("", "New title");
    assert.deepEqual(paneTitles(), ["Web chat", "New title"]);
    assert.equal(document.title, `New title · ${productTitle()}`);
    await refreshTitles("Fallback for overloaded title model", "New title");
    assert.deepEqual(paneTitles(), ["Fallback for overloaded title model", "New title"]);
    focusPane(0);
    assert.equal(document.title, `Fallback for overloaded title model · ${productTitle()}`);
    await refreshTitles("Fallback for overloaded title model", "Fallback for OAuth callback");
    assert.deepEqual(paneTitles(), ["Fallback for overloaded title model", "Fallback for OAuth callback"]);
    assert.equal(document.title, `Fallback for overloaded title model · ${productTitle()}`);
    focusPane(1);
    assert.equal(document.title, `Fallback for OAuth callback · ${productTitle()}`);

    globalThis.fetch = async () => new Response(null, { status: 204 });
    await signOut();
    assert.equal(document.title, productTitle());
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
