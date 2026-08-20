import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
  url: "http://localhost/web-ui/?view=memory",
});
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const launch = {
  id: "p1",
  name: "Launch",
  ownerId: "alice",
  memberIds: ["alice"],
  scopeId: "group:web-project-p1",
  members: [{ principalId: "alice", displayName: "Alice" }],
};
const alpha = { ...launch, id: "p2", name: "Alpha", scopeId: "group:web-project-p2" };
const contexts = [
  { scopeId: "channel:C1", kind: "channel", name: "general", sessionCount: 0, lastActivityAt: null },
  { scopeId: launch.scopeId, kind: "group", name: launch.name, sessionCount: 0, lastActivityAt: null, project: launch },
  { scopeId: "personal:alice", kind: "personal", name: null, sessionCount: 1, lastActivityAt: null },
  { scopeId: "group:G1", kind: "group", name: "Ada, Bob", sessionCount: 0, lastActivityAt: null },
  { scopeId: alpha.scopeId, kind: "group", name: alpha.name, sessionCount: 0, lastActivityAt: null, project: alpha },
];
const notebooks: Record<string, { content: string; revision: string }> = {
  "": { content: "- personal fact", revision: "pr1" },
  [launch.scopeId]: { content: "- launch fact", revision: "lr1" },
  [alpha.scopeId]: { content: "- alpha fact", revision: "ar1" },
};
const revisions = [
  { revision: "h2", content: "- newer", operation: "write", at: 2000 },
  { revision: "h1", content: "- older", operation: "write", at: 1000 },
];

interface Recorded {
  method: string;
  pathname: string;
  scopeId: string | null;
  body: Record<string, unknown> | null;
}
let requests: Recorded[] = [];

function respond(input: RequestInfo | URL, init?: RequestInit): Response {
  const u = new URL(String(input), "http://localhost");
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  requests.push({ method, pathname: u.pathname, scopeId: u.searchParams.get("scopeId"), body });
  if (u.pathname.endsWith("/api/contexts")) return Response.json({ contexts });
  if (u.pathname.endsWith("/api/memory/history")) return Response.json({ revisions });
  if (u.pathname.endsWith("/api/memory/restore")) return Response.json({ content: "- older", revision: "hr1" });
  if (u.pathname.endsWith("/api/memory")) {
    if (method === "PUT") return Response.json({ content: body?.content, revision: "saved" });
    return Response.json(notebooks[u.searchParams.get("scopeId") ?? ""]);
  }
  throw new Error(`Unexpected request: ${method} ${String(input)}`);
}
globalThis.fetch = async (input, init) => respond(input, init);

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
const { contextsState } = await vite.ssrLoadModule("/src/contexts.ts");
const { renderMemory, resetMemoryState } = await vite.ssrLoadModule("/src/memory.ts");

appState.me = { user: "alice", org: "acme" };
appState.currentView = "memory";
appState.mainEl = document.querySelector("#main");

test.after(async () => {
  await vite.close();
  dom.window.close();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function optionTitles(): string[] {
  return [...document.querySelectorAll<HTMLOptionElement>(".memory-scope select option")].map((o) =>
    (o.textContent ?? "").trim(),
  );
}

function subtitle(): string {
  return (document.querySelector(".pane-subtitle")?.textContent ?? "").replace(/\s+/gu, " ").trim();
}

function switchTo(value: string): void {
  const select = document.querySelector<HTMLSelectElement>(".memory-scope select")!;
  select.value = value;
  select.dispatchEvent(new dom.window.Event("change"));
}

function draftTextarea(): HTMLTextAreaElement {
  const existing = document.querySelector<HTMLTextAreaElement>(".memory-text");
  if (existing) return existing;
  [...document.querySelectorAll<HTMLButtonElement>('.memory-toolbar [role="tab"]')]
    .find((b) => (b.textContent ?? "").includes("Notebook"))!
    .click();
  return document.querySelector<HTMLTextAreaElement>(".memory-text")!;
}

test("the switcher offers Personal first, then the viewer's projects by title", async () => {
  requests = [];
  contextsState.list = [];
  contextsState.loaded = false;
  await renderMemory();
  await settle();
  assert.deepEqual(optionTitles(), ["Personal", "Alpha", "Launch"], "channels and group DMs are not notebooks to pick");
  assert.equal(subtitle(), "Facts the agent carries into your conversations.");
  assert.equal(draftTextarea().value, "- personal fact");
  const load = requests.find((r) => r.pathname.endsWith("/api/memory"));
  assert.equal(load?.scopeId, null, "the personal notebook is fetched with no scope");
});

test("switching notebooks scopes every call and names the project", async () => {
  requests = [];
  switchTo(launch.scopeId);
  await settle();
  assert.equal(requests.find((r) => r.pathname.endsWith("/api/memory"))?.scopeId, launch.scopeId);
  assert.equal(subtitle(), "Facts the agent carries into Launch conversations.");
  assert.equal(draftTextarea().value, "- launch fact");

  const area = draftTextarea();
  area.value = "- launch fact\n- another";
  area.dispatchEvent(new dom.window.Event("input"));
  requests = [];
  document.querySelector<HTMLButtonElement>(".memory-save")!.click();
  await settle();
  const put = requests.find((r) => r.method === "PUT");
  assert.deepEqual(put?.body, {
    content: "- launch fact\n- another",
    revision: "lr1",
    scopeId: launch.scopeId,
  });

  requests = [];
  [...document.querySelectorAll<HTMLButtonElement>(".pane-head-actions .btn")]
    .find((b) => (b.textContent ?? "").includes("History"))!
    .click();
  await settle();
  assert.equal(requests.find((r) => r.pathname.endsWith("/api/memory/history"))?.scopeId, launch.scopeId);

  requests = [];
  [...document.querySelectorAll<HTMLButtonElement>(".memory-revision .btn")]
    .find((b) => (b.textContent ?? "").trim() === "Restore")!
    .click();
  await settle();
  document.querySelector<HTMLButtonElement>(".memory-confirm .btn.danger")!.click();
  await settle();
  const restore = requests.find((r) => r.pathname.endsWith("/api/memory/restore"));
  assert.equal(restore?.body?.scopeId, launch.scopeId);
  assert.equal(restore?.body?.revision, "h1");
});

test("an unsaved draft guards the switch and cancel keeps it", async () => {
  requests = [];
  await renderMemory(true);
  await settle();
  const area = draftTextarea();
  area.value = "- launch fact\n- unsaved";
  area.dispatchEvent(new dom.window.Event("input"));

  switchTo("");
  await settle();
  const confirm = document.querySelector(".memory-confirm");
  assert.ok(confirm, "switching with a dirty draft asks first");
  assert.equal(
    requests.filter((r) => r.pathname.endsWith("/api/memory") && r.method === "GET" && r.scopeId === null).length,
    0,
    "nothing loads until the person decides",
  );
  [...document.querySelectorAll<HTMLButtonElement>(".memory-confirm .btn")]
    .find((b) => (b.textContent ?? "").trim() === "Cancel")!
    .click();
  await settle();
  assert.equal(subtitle(), "Facts the agent carries into Launch conversations.");
  assert.equal(draftTextarea().value, "- launch fact\n- unsaved", "the draft survives a cancelled switch");

  switchTo("");
  await settle();
  document.querySelector<HTMLButtonElement>(".memory-confirm .btn.danger")!.click();
  await settle();
  assert.equal(subtitle(), "Facts the agent carries into your conversations.");
  assert.equal(draftTextarea().value, "- personal fact");
});

test("a notebook that answers after the person moved on is ignored", async () => {
  resetMemoryState();
  requests = [];
  await renderMemory();
  await settle();

  let releaseAlpha!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input), "http://localhost");
    if (u.searchParams.get("scopeId") === alpha.scopeId) await held;
    return respond(input, init);
  };
  switchTo(alpha.scopeId);
  await settle();
  switchTo("");
  await settle();
  assert.equal(subtitle(), "Facts the agent carries into your conversations.");
  assert.equal(draftTextarea().value, "- personal fact");

  releaseAlpha();
  await settle();
  assert.equal(draftTextarea().value, "- personal fact", "the stale Alpha notebook never lands");
  assert.equal(subtitle(), "Facts the agent carries into your conversations.");
  globalThis.fetch = async (input, init) => respond(input, init);
});

test("a slow load for the same notebook cannot clobber what was typed after it", async () => {
  resetMemoryState();
  requests = [];
  let releaseFirst!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let personalReads = 0;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input), "http://localhost");
    const isPersonalRead =
      (init?.method ?? "GET") === "GET" && u.pathname.endsWith("/api/memory") && !u.searchParams.get("scopeId");
    if (isPersonalRead && ++personalReads === 1) await held;
    return respond(input, init);
  };
  const first = renderMemory();
  await settle();
  switchTo(alpha.scopeId);
  await settle();
  switchTo("");
  await settle();
  assert.equal(draftTextarea().value, "- personal fact");
  const area = draftTextarea();
  area.value = "- personal fact\n- typed after";
  area.dispatchEvent(new dom.window.Event("input"));

  releaseFirst();
  await first;
  await settle();
  assert.equal(draftTextarea().value, "- personal fact\n- typed after", "the earlier personal load never lands");
  globalThis.fetch = async (input, init) => respond(input, init);
});

test("a save that answers after switching notebooks stays out of the new notebook", async () => {
  resetMemoryState();
  requests = [];
  await renderMemory();
  await settle();
  const area = draftTextarea();
  area.value = "- personal fact\n- pending save";
  area.dispatchEvent(new dom.window.Event("input"));

  let releaseSave!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  globalThis.fetch = async (input, init) => {
    if ((init?.method ?? "GET") === "PUT") await held;
    return respond(input, init);
  };
  switchTo(launch.scopeId);
  await settle();
  assert.ok(document.querySelector(".memory-confirm"), "a dirty draft asks before switching");
  document.querySelector<HTMLButtonElement>(".memory-save")!.click();
  await settle();
  document.querySelector<HTMLButtonElement>(".memory-confirm .btn.danger")!.click();
  await settle();
  assert.equal(subtitle(), "Facts the agent carries into Launch conversations.");
  assert.equal(draftTextarea().value, "- launch fact");

  releaseSave();
  await settle();
  assert.equal(draftTextarea().value, "- launch fact", "the held personal save never lands in the Launch notebook");
  assert.ok(!(document.querySelector(".status")?.textContent ?? "").includes("Saved"));
  const put = requests.find((r) => r.method === "PUT");
  assert.equal(put?.body?.scopeId, undefined, "the save still targeted the personal notebook");
  globalThis.fetch = async (input, init) => respond(input, init);
});

test("facts are the default view, with the notebook one tab away", async () => {
  resetMemoryState();
  requests = [];
  await renderMemory();
  await settle();
  assert.equal(document.querySelector(".memory-text"), null, "the raw editor stays behind the Notebook tab");
  const factRows = [...document.querySelectorAll(".memory-fact")].map((f) => (f.textContent ?? "").trim());
  assert.ok(factRows.some((f) => f.includes("personal fact")));
  const factsTab = [...document.querySelectorAll<HTMLButtonElement>('.memory-toolbar [role="tab"]')].find((b) =>
    (b.textContent ?? "").includes("Facts"),
  )!;
  assert.ok(factsTab.classList.contains("active"));
  assert.equal(factsTab.querySelector("span")?.textContent, "1", "the tab counts the facts");
  assert.equal(draftTextarea().value, "- personal fact");
});

test("compacting stages the ask in a conversation in the notebook's context", async () => {
  const { storedDraft, saveDraft, newChatDraftKey } = await vite.ssrLoadModule("/src/drafts.ts");
  const { mainConversation } = await vite.ssrLoadModule("/src/conversations.ts");
  resetMemoryState();
  requests = [];
  await renderMemory();
  await settle();
  switchTo(launch.scopeId);
  await settle();
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input), "http://localhost");
    if (u.pathname.endsWith("/api/runtime-config")) {
      return Response.json({
        approvedHarnesses: [],
        modelsByHarness: {},
        effective: { harnessId: "pi", modelId: "claude-opus-5" },
      });
    }
    try {
      return respond(input, init);
    } catch {
      return Response.json({});
    }
  };
  saveDraft(newChatDraftKey("alice"), "half-written note I care about");
  document.querySelector<HTMLButtonElement>(".memory-compact")!.click();
  await settle();
  const conv = mainConversation();
  assert.ok(String(conv.composer.state.draft).includes("compact it"), "the compaction ask is staged in the composer");
  assert.equal(
    storedDraft(newChatDraftKey("alice")),
    "half-written note I care about",
    "an unsent chat draft is not clobbered by compacting",
  );
  assert.equal(appState.currentView, "chats", "the person lands in the conversation to send it");
  assert.equal(conv.state.scopeId, launch.scopeId, "the conversation opens in the notebook's context");
  conv.resetChatState();
  appState.currentView = "memory";
  appState.mainEl = document.querySelector("#main");
  globalThis.fetch = async (input, init) => respond(input, init);
});

test("compacting waits for unsaved notebook edits", async () => {
  resetMemoryState();
  requests = [];
  await renderMemory();
  await settle();
  assert.equal(document.querySelector<HTMLButtonElement>(".memory-compact")!.disabled, false);
  const area = draftTextarea();
  area.value = "- personal fact\n- unsaved";
  area.dispatchEvent(new dom.window.Event("input"));
  assert.equal(
    document.querySelector<HTMLButtonElement>(".memory-compact")!.disabled,
    true,
    "a dirty draft would make the agent compact something other than what is shown",
  );
});

test("a notebook holding non-fact text does not claim to be empty", async () => {
  resetMemoryState();
  notebooks[""] = { content: "Some prose the agent kept\nwithout bullets", revision: "pr2" };
  requests = [];
  await renderMemory();
  await settle();
  assert.match(
    document.querySelector(".empty-state")?.textContent ?? "",
    /Notebook tab shows the full text/u,
    "the facts view points at the notebook instead of calling the memory empty",
  );
  notebooks[""] = { content: "- personal fact", revision: "pr1" };
});

test("without projects the pane keeps today's plain header", async () => {
  resetMemoryState();
  const all = contextsState.list;
  contextsState.list = contexts.filter((c) => !("project" in c));
  requests = [];
  await renderMemory();
  await settle();
  assert.equal(document.querySelector(".memory-scope"), null, "one lone option is not a switcher");
  assert.equal(subtitle(), "Facts the agent carries into your conversations.");
  assert.equal(draftTextarea().value, "- personal fact");
  contextsState.list = all;
});
