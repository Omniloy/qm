import test from "node:test";
import assert from "node:assert/strict";

interface Target {
  tabId: number;
  attached: boolean;
}

interface Harness {
  sockets: FakeSocket[];
  attached: Array<{ tabId: number }>;
  detached: Array<{ tabId: number }>;
  store: Record<string, unknown>;
  badges: Array<{ tabId: number; text: string }>;
  fire(event: "detach", source: { tabId: number }, reason: string): void;
}

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function install(opts: {
  store?: Record<string, unknown>;
  tabs?: Record<number, { title: string; url: string }>;
  targets?: Target[];
  attachFails?: boolean;
}): Harness {
  const store: Record<string, unknown> = { ...(opts.store ?? {}) };
  const tabs = opts.tabs ?? {};
  const attached: Array<{ tabId: number }> = [];
  const detached: Array<{ tabId: number }> = [];
  const badges: Array<{ tabId: number; text: string }> = [];
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const on = (name: string) => ({
    addListener: (fn: (...a: unknown[]) => void) => void (listeners[name] ??= []).push(fn),
  });
  FakeSocket.all = [];

  const chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const want = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of want) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (patch: Record<string, unknown>) => void Object.assign(store, patch),
        remove: async (key: string) => void delete store[key],
      },
    },
    tabs: {
      get: async (id: number) => {
        const tab = tabs[id];
        if (!tab) throw new Error("No tab with id");
        return { id, ...tab };
      },
      query: async () => Object.entries(tabs).map(([id, t]) => ({ id: Number(id), ...t })),
      onRemoved: on("removed"),
    },
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => {
        if (opts.attachFails) throw new Error("Cannot access a chrome:// URL");
        attached.push({ tabId });
      },
      detach: async ({ tabId }: { tabId: number }) => void detached.push({ tabId }),
      sendCommand: async () => ({}),
      getTargets: async () => opts.targets ?? [],
      onEvent: on("event"),
      onDetach: on("detach"),
    },
    action: {
      setBadgeText: async ({ tabId, text }: { tabId: number; text: string }) => void badges.push({ tabId, text }),
      setBadgeBackgroundColor: async () => {},
    },
    scripting: { executeScript: async () => [] },
    alarms: { create: () => {}, onAlarm: on("alarm") },
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: on("message"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
    },
  };

  (globalThis as Record<string, unknown>).chrome = chrome;
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  (globalThis as Record<string, unknown>).fetch = async () => {
    throw new Error("no baked config");
  };

  return {
    sockets: FakeSocket.all,
    attached,
    detached,
    store,
    badges,
    fire: (event, source, reason) => {
      for (const fn of listeners[event] ?? []) fn(source, reason);
    },
  };
}

let bust = 0;
async function bootWorker(): Promise<void> {
  await import(`../extension/background.js?case=${++bust}`);
}

async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

const PAIRED = { origin: "https://qm.example.com", token: "tok" };

test("a restarted worker picks the shared tab back up and re-announces it", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { 7: { title: "Gmail", url: "https://mail.google.com/" } },
    targets: [],
  });
  await bootWorker();

  assert.ok(await until(() => h.attached.length > 0), "re-attached the debugger to the saved tab");
  assert.deepEqual(h.attached, [{ tabId: 7 }]);

  assert.ok(await until(() => (h.sockets[0]?.sent.length ?? 0) > 0), "announced on the new socket");
  assert.deepEqual(JSON.parse(h.sockets[0]!.sent[0]!), {
    qm: "attached",
    title: "Gmail",
    url: "https://mail.google.com/",
  });
});

test("a saved tab that has since closed is forgotten rather than re-attached", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: {}, targets: [] });
  await bootWorker();

  assert.ok(await until(() => !("attachedTabId" in h.store)), "dropped the stale tab id");
  assert.deepEqual(h.attached, [], "never attached to a tab that is gone");
  const sent = h.sockets[0]?.sent ?? [];
  assert.equal(sent.length, 0, "and claimed no share it cannot honour");
});

test("a debugger that outlived the worker is reused, not attached twice", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { 7: { title: "Gmail", url: "https://mail.google.com/" } },
    targets: [{ tabId: 7, attached: true }],
  });
  await bootWorker();

  assert.ok(await until(() => (h.sockets[0]?.sent.length ?? 0) > 0), "still announced the share");
  assert.deepEqual(h.attached, [], "no second attach");
});

test("a tab the debugger refuses is forgotten instead of left half-shared", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { 7: { title: "Web Store", url: "https://chromewebstore.google.com/" } },
    targets: [],
    attachFails: true,
  });
  await bootWorker();

  assert.ok(await until(() => !("attachedTabId" in h.store)), "dropped the tab it cannot drive");
  assert.equal(h.sockets[0]?.sent.length ?? 0, 0);
});

test("nothing is restored when no tab was ever shared", async () => {
  const h = install({ store: { ...PAIRED }, tabs: { 7: { title: "Gmail", url: "https://x/" } } });
  await bootWorker();

  assert.ok(await until(() => h.sockets.length > 0), "still connects");
  assert.deepEqual(h.attached, []);
  assert.equal(h.sockets[0]?.sent.length ?? 0, 0);
});

test("the person cancelling the debugger bar is a real stop, and says so", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { 7: { title: "Gmail", url: "https://mail.google.com/" } },
    targets: [{ tabId: 7, attached: true }],
  });
  await bootWorker();
  assert.ok(await until(() => (h.sockets[0]?.sent.length ?? 0) > 0));

  h.fire("detach", { tabId: 7 }, "canceled_by_user");

  assert.ok(
    await until(() => h.sockets[0]!.sent.some((s) => JSON.parse(s).qm === "detached")),
    "MiniOmni is told the share ended",
  );
});

test("a tab closing detaches without claiming the person chose to stop", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { 7: { title: "Gmail", url: "https://mail.google.com/" } },
    targets: [{ tabId: 7, attached: true }],
  });
  await bootWorker();
  assert.ok(await until(() => (h.sockets[0]?.sent.length ?? 0) > 0));

  h.fire("detach", { tabId: 7 }, "target_closed");

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!h.sockets[0]!.sent.some((s) => JSON.parse(s).qm === "detached"), "no explicit stop from a closing target");
});
