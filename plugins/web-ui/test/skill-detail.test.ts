import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";
import type { SkillItem } from "../src/composer.ts";

type Reply = { status: number; body: unknown };

const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  url: "http://localhost/web-ui/",
  pretendToBeVisual: true,
});
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
const pending: Array<{ path: string; resolve: (reply: Reply) => void }> = [];
const edits: SkillItem[] = [];
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
  customElements: dom.window.customElements,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  fetch: (input: RequestInfo | URL) =>
    new Promise<Response>((resolve) => {
      pending.push({
        path: String(input),
        resolve: (reply) => resolve(Response.json(reply.body, { status: reply.status })),
      });
    }),
};
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let vite: ViteDevServer;
let renderSkillDetail: (host: HTMLElement, row: SkillItem, actions: unknown) => Promise<void>;
let host: HTMLElement;

before(async () => {
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  ({ renderSkillDetail } = await vite.ssrLoadModule("/src/skill-detail.ts"));
});

after(async () => {
  await vite?.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  dom.window.close();
});

beforeEach(() => {
  pending.length = 0;
  edits.length = 0;
  host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
});

function open(row: SkillItem): Promise<void> {
  return renderSkillDetail(host, row, {
    home: () => "Personal",
    onBack: () => {},
    onEdit: (skill: SkillItem) => edits.push(skill),
  });
}

const row = (over: Partial<SkillItem> = {}): SkillItem => ({
  id: "s1",
  name: "jira",
  description: "Triage Jira tickets",
  scope: "personal",
  scopeId: "personal:me@acme.com",
  status: "published",
  version: 3,
  editable: true,
  ...over,
});

test("the detail pane shows the header at once, then the instructions, files, author, and an Edit button", async () => {
  const done = open(row());
  assert.match(host.textContent!, /\/jira/);
  assert.match(host.textContent!, /Triage Jira tickets/);
  assert.match(host.textContent!, /Loading instructions…/);
  assert.equal(host.querySelector(".skill-detail-edit"), null, "no Edit before the server confirms it");
  assert.equal(pending[0]?.path, "/api/skills/s1");
  pending[0]!.resolve({
    status: 200,
    body: {
      skill: {
        ...row(),
        body: "Step one: read the ticket.",
        createdBy: "me@acme.com",
        updatedAt: Date.now() - 3_600_000,
        files: [{ path: "scripts/triage.py", executable: true }],
        editable: true,
      },
    },
  });
  await done;
  const text = host.textContent!;
  assert.doesNotMatch(text, /Loading instructions…/);
  assert.ok(host.querySelector(".skill-detail-instructions qm-markdown"), "instructions render as markdown");
  assert.equal(
    (host.querySelector(".skill-detail-instructions qm-markdown") as unknown as { content: string }).content,
    "Step one: read the ticket.",
  );
  assert.match(text, /scripts\/triage\.py/);
  assert.match(text, /\(executable\)/);
  assert.match(text, /me@acme\.com/);
  assert.match(text, /1h ago/);
  host.querySelector<HTMLButtonElement>(".skill-detail-edit")!.click();
  assert.equal(edits[0]?.id, "s1");
  assert.equal(edits[0]?.body, "Step one: read the ticket.");
});

test("a read-only or archived skill gets no Edit button", async () => {
  const readOnly = open(row());
  pending[0]!.resolve({ status: 200, body: { skill: { ...row(), body: "b", editable: false } } });
  await readOnly;
  assert.equal(host.querySelector(".skill-detail-edit"), null);
  const archived = open(row({ status: "archived" }));
  pending[1]!.resolve({ status: 200, body: { skill: { ...row(), body: "b", status: "archived" } } });
  await archived;
  assert.equal(host.querySelector(".skill-detail-edit"), null);
  assert.match(host.textContent!, /Archived/);
});

test("a missing skill says so instead of spinning, and other failures surface their message", async () => {
  const missing = open(row());
  pending[0]!.resolve({ status: 404, body: { error: "not_found" } });
  await missing;
  assert.match(host.querySelector("[role=alert]")!.textContent!, /no longer exists/);
  const broken = open(row());
  pending[1]!.resolve({ status: 500, body: { message: "database down" } });
  await broken;
  assert.match(host.querySelector("[role=alert]")!.textContent!, /database down/);
});

test("a slow response for a skill you've since left never overwrites the one you opened", async () => {
  const first = open(row({ id: "old", name: "old-skill" }));
  const second = open(row({ id: "new", name: "new-skill" }));
  pending[1]!.resolve({ status: 200, body: { skill: { ...row({ id: "new", name: "new-skill" }), body: "NEW" } } });
  await second;
  pending[0]!.resolve({ status: 200, body: { skill: { ...row({ id: "old", name: "old-skill" }), body: "OLD" } } });
  await first;
  assert.match(host.textContent!, /new-skill/);
  assert.doesNotMatch(host.textContent!, /old-skill/);
  assert.equal(
    (host.querySelector(".skill-detail-instructions qm-markdown") as unknown as { content: string }).content,
    "NEW",
  );
});
