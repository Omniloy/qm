import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreSession } from "../src/core-bridge.ts";

const MOVE_ITEM = "Move to project…";

const dom = new JSDOM('<!doctype html><div id="app"><div class="list" id="sidebar-body"></div></div>', {
  url: "http://localhost/web-ui/?view=chats",
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
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected request: ${String(input)}`);
};

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
const { contextsState } = await vite.ssrLoadModule("/src/contexts.ts");
const { sessionsState, renderList } = await vite.ssrLoadModule("/src/sessions.ts");
const { movableContexts } = await vite.ssrLoadModule("/src/context-picker.ts");
const { createConversation, disposeConversation } = await vite.ssrLoadModule("/src/conversations.ts");

const project = {
  id: "p1",
  name: "Launch",
  ownerId: "alice",
  memberIds: ["alice"],
  scopeId: "group:web-project-p1",
  members: [{ principalId: "alice", displayName: "Alice" }],
};
const contexts = [
  { scopeId: "personal:alice", kind: "personal", name: null, sessionCount: 1, lastActivityAt: null },
  { scopeId: "channel:C1", kind: "channel", name: "general", sessionCount: 0, lastActivityAt: null },
  { scopeId: "group:G1", kind: "group", name: "Ada, Bob", sessionCount: 0, lastActivityAt: null },
  { scopeId: project.scopeId, kind: "group", name: project.name, sessionCount: 0, lastActivityAt: null, project },
];

appState.me = { user: "alice", org: "acme" };
appState.currentView = "chats";
appState.listEl = document.querySelector("#sidebar-body");
contextsState.list = contexts;
contextsState.loaded = true;

test.after(async () => {
  await vite.close();
  dom.window.close();
});

function session(over: Partial<CoreSession> = {}): CoreSession {
  return {
    id: "s1",
    type: "dm",
    scopeId: "personal:alice",
    threadRef: "web:alice:t1",
    createdAt: 1,
    title: "Pricing",
    channelName: null,
    archived: false,
    ...over,
  };
}

function menuItems(s: CoreSession): string[] {
  sessionsState.list = [s];
  sessionsState.openMenuId = s.id;
  renderList();
  return [...document.querySelectorAll(".session-menu-popover .session-menu-option")].map((b) =>
    (b.textContent ?? "").trim(),
  );
}

test("a web conversation you can continue offers the move", () => {
  assert.ok(menuItems(session()).includes(MOVE_ITEM), "your own web chat can be moved");
  assert.ok(
    menuItems(session({ scopeId: project.scopeId, type: "group", channelName: project.name })).includes(MOVE_ITEM),
    "a chat already in a project can be moved out of it",
  );
});

test("conversations whose scope is not ours to set do not offer the move", () => {
  assert.ok(
    !menuItems(session({ threadRef: "dm:D1" })).includes(MOVE_ITEM),
    "a Slack DM is rescoped by Slack on every inbound turn",
  );
  assert.ok(
    !menuItems(session({ threadRef: "ch:C1:1699999999.000100", type: "channel", scopeId: "channel:C1" })).includes(
      MOVE_ITEM,
    ),
    "a Slack channel thread is rescoped by Slack on every inbound turn",
  );
  assert.ok(
    !menuItems(session({ threadRef: "web:bob:t9", scopeId: "personal:bob" })).includes(MOVE_ITEM),
    "a conversation you cannot continue is not yours to move",
  );
  assert.ok(
    !menuItems(
      session({ threadRef: "web:bob:t9", scopeId: project.scopeId, type: "group", channelName: project.name }),
    ).includes(MOVE_ITEM),
    "a project conversation someone else started is theirs to file, not yours",
  );
});

test("choosing a project moves the conversation and rehomes the row", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const moved = { ...session(), scopeId: project.scopeId, type: "group", channelName: project.name };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/api/sessions/s1/move")) return Response.json({ session: moved });
    if (url.endsWith("/api/sessions")) return Response.json({ sessions: [moved] });
    if (url.endsWith("/api/contexts")) return Response.json({ contexts });
    throw new Error(`Unexpected request: ${url}`);
  };
  menuItems(session());
  const open = [...document.querySelectorAll<HTMLElement>(".session-menu-popover .session-menu-option")].find(
    (b) => (b.textContent ?? "").trim() === MOVE_ITEM,
  );
  open?.click();

  const choices = [...document.querySelectorAll(".context-choices .context-choice")].map((c) =>
    (c.textContent ?? "").replace(/\s+/gu, " ").trim(),
  );
  assert.deepEqual(choices, ["Personal now", "Launch"], "the current context is marked, Slack scopes are absent");

  const launch = document.querySelectorAll<HTMLInputElement>(".context-choices input")[1];
  launch?.dispatchEvent(new dom.window.Event("change"));
  const impact = [...document.querySelectorAll(".drive-picker .drive-note")]
    .map((p) => (p.textContent ?? "").replace(/\s+/gu, " ").trim())
    .join(" ");
  assert.match(impact, /Everyone in Launch will see this conversation/u);
  assert.match(impact, /files and memories stay behind in Personal’s workspace/u);
  assert.match(impact, /any share link for it stops working/u);

  const confirm = [...document.querySelectorAll<HTMLElement>(".drive-picker-foot button")].find(
    (b) => (b.textContent ?? "").trim() === "Move conversation",
  );
  confirm?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    requests.filter((r) => r.url.endsWith("/move")),
    [{ url: "/api/sessions/s1/move", body: { scopeId: project.scopeId } }],
  );
  assert.equal(sessionsState.list[0].scopeId, project.scopeId, "the row follows the conversation");
  assert.equal(document.querySelector(".kc-dialog-scrim"), null, "the dialog closes itself on success");
});

test("every pane mounted on the moved conversation adopts its new context", async () => {
  const moved = { ...session(), scopeId: project.scopeId, type: "group", channelName: project.name };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/sessions/s1/move")) return Response.json({ session: moved });
    if (url.endsWith("/api/sessions")) return Response.json({ sessions: [moved] });
    if (url.endsWith("/api/contexts")) return Response.json({ contexts });
    if (url.includes("/api/runtime-config")) return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  };
  const host = {
    pane: true,
    ownsUrl: false,
    container: () => null,
    claimContainer: () => null,
    visible: () => true,
    density: () => "full",
    onDensityChange: () => {},
    ensureDeliveryStream: () => {},
  };
  const mounted = createConversation(host);
  const elsewhere = createConversation(host);
  mounted.state.sessionId = "s1";
  mounted.state.scopeId = "personal:alice";
  mounted.state.contextName = null;
  mounted.state.agent = { state: { model: { id: "model-a" } }, abort: () => {}, subscribe: () => () => {} };
  elsewhere.state.sessionId = "s2";
  elsewhere.state.scopeId = "personal:alice";
  const refreshed: Array<{ scopeId: string | null; agent: unknown }> = [];
  mounted.composer.refreshRuntimeSelection = async (scopeId: string | null, agent?: unknown) => {
    refreshed.push({ scopeId, agent });
  };
  sessionsState.collapsedProjectScopes.add(project.scopeId);

  menuItems(session());
  [...document.querySelectorAll<HTMLElement>(".session-menu-popover .session-menu-option")]
    .find((b) => (b.textContent ?? "").trim() === MOVE_ITEM)
    ?.click();
  document
    .querySelectorAll<HTMLInputElement>(".context-choices input")[1]
    ?.dispatchEvent(new dom.window.Event("change"));
  [...document.querySelectorAll<HTMLElement>(".drive-picker-foot button")]
    .find((b) => (b.textContent ?? "").trim() === "Move conversation")
    ?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(mounted.state.scopeId, project.scopeId, "the next turn is sent against the context it moved to");
  assert.equal(mounted.state.contextName, project.name);
  assert.equal(mounted.state.rememberedScopeId, project.scopeId, "reopening the thread does not resurrect the old one");
  assert.deepEqual(
    refreshed,
    [{ scopeId: project.scopeId, agent: mounted.state.agent }],
    "the agent comes along, or the composer shows the new scope's model while the turn runs the old one",
  );
  assert.equal(elsewhere.state.scopeId, "personal:alice", "a pane on another conversation is left alone");
  assert.ok(
    !sessionsState.collapsedProjectScopes.has(project.scopeId),
    "the destination project opens, so the row does not vanish into a collapsed group",
  );

  disposeConversation(mounted);
  disposeConversation(elsewhere);
});

test("a conversation can only land in Personal or a project", () => {
  assert.deepEqual(
    movableContexts("conversation").map((o: { scopeId: string }) => o.scopeId),
    ["personal:alice", project.scopeId],
    "Slack channels and group DMs are not destinations — Slack recomputes their scope every turn",
  );
  assert.equal(movableContexts("conversation")[0].title, "Personal");
  assert.deepEqual(
    movableContexts("file").map((o: { scopeId: string }) => o.scopeId),
    ["personal:alice", "channel:C1", "group:G1", project.scopeId],
    "a file's destinations are unchanged",
  );
});

test("a picker abandoned by navigating away does not reappear on the way back", async () => {
  const { switchView } = await vite.ssrLoadModule("/src/shell.ts");
  globalThis.fetch = async () => Response.json({ contexts });
  menuItems(session());
  [...document.querySelectorAll<HTMLElement>(".session-menu-popover .session-menu-option")]
    .find((b) => (b.textContent ?? "").trim() === MOVE_ITEM)
    ?.click();
  assert.ok(document.querySelector(".kc-dialog-scrim"), "the dialog opened");

  switchView("memory");
  appState.currentView = "chats";
  renderList();
  assert.equal(document.querySelector(".kc-dialog-scrim"), null, "leaving the view disarms it");
});
