import test from "node:test";
import assert from "node:assert/strict";

interface Harness {
  canDrive: boolean;
  sockets: FakeSocket[];
  attached: Array<{ tabId: number }>;
  detached: Array<{ tabId: number }>;
  store: Record<string, unknown>;
  banners: Array<{ tabId: number; on: boolean }>;
  sent(): Array<Record<string, unknown>>;
  fire(event: string, ...args: unknown[]): void;
  message(msg: Record<string, unknown>): Promise<Record<string, unknown>>;
  openGate(): void;
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
  attachFails?: boolean;
  canDrive?: boolean;
  storageFailures?: number;
  activeTab?: number;
  gated?: boolean;
}): Harness {
  const store: Record<string, unknown> = { ...(opts.store ?? {}) };
  const tabs = opts.tabs ?? {};
  const attached: Array<{ tabId: number }> = [];
  const detached: Array<{ tabId: number }> = [];
  const banners: Array<{ tabId: number; on: boolean }> = [];
  const listeners: Record<string, Array<(...a: unknown[]) => unknown>> = {};
  const on = (name: string) => ({
    addListener: (fn: (...a: unknown[]) => unknown) => void (listeners[name] ??= []).push(fn),
  });
  let release = (): void => {};
  let storageCalls = 0;
  const gate = opts.gated ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  FakeSocket.all = [];

  const chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          await gate;
          if (storageCalls++ < (opts.storageFailures ?? 0)) throw new Error("storage is unavailable");
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
      query: async () => {
        const id = opts.activeTab ?? Number(Object.keys(tabs)[0]);
        return tabs[id] ? [{ id, ...tabs[id] }] : [];
      },
      onRemoved: on("removed"),
      onCreated: on("created"),
    },
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => {
        if (opts.attachFails) throw new Error("Cannot access a chrome:// URL");
        attached.push({ tabId });
      },
      detach: async ({ tabId }: { tabId: number }) => void detached.push({ tabId }),
      sendCommand: async () => {
        if (!harness.canDrive) throw new Error("Debugger is not attached to the tab with id: 7");
        return {};
      },
      onEvent: on("event"),
      onDetach: on("detach"),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: {
      executeScript: async ({ target, args }: { target: { tabId: number }; args: unknown[] }) => {
        banners.push({ tabId: target.tabId, on: Boolean(args?.[0]) });
        return [];
      },
    },
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

  const harness: Harness = {
    canDrive: opts.canDrive !== false,
    sockets: FakeSocket.all,
    attached,
    detached,
    store,
    banners,
    sent: () => (FakeSocket.all[0]?.sent ?? []).map((s) => JSON.parse(s) as Record<string, unknown>),
    fire: (event, ...args) => {
      for (const fn of listeners[event] ?? []) fn(...args);
    },
    message: (msg) =>
      new Promise((resolve) => {
        for (const fn of listeners.message ?? []) fn(msg, {}, resolve);
      }),
    openGate: () => release(),
  };
  return harness;
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
const GMAIL = { 7: { title: "Gmail", url: "https://mail.google.com/" } };
const shares = (h: Harness): Array<Record<string, unknown>> => h.sent().filter((m) => m.qm === "attached");

test("a restarted worker picks the shared tab back up and re-announces it", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();

  assert.ok(await until(() => h.attached.length > 0), "re-attached the debugger to the saved tab");
  assert.deepEqual(h.attached, [{ tabId: 7 }]);
  assert.ok(await until(() => shares(h).length > 0), "announced on the new socket");
  assert.equal(shares(h)[0]!.title, "Gmail");
});

test("a restored share is marked restored, so it cannot re-pick the browser", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();

  assert.ok(await until(() => shares(h).length > 0));
  assert.equal(
    shares(h)[0]!.restored,
    true,
    "a keepalive reconnect would otherwise overwrite a browser chosen in the app",
  );
});

test("a tab this extension cannot actually drive is forgotten, not announced", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, canDrive: false });
  await bootWorker();

  assert.ok(await until(() => !("attachedTabId" in h.store)), "dropped the tab it cannot drive");
  assert.equal(shares(h).length, 0, "and claimed no share, so open still fails honestly");
});

test("a saved tab that has since closed is forgotten rather than re-attached", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: {} });
  await bootWorker();

  assert.ok(await until(() => !("attachedTabId" in h.store)), "dropped the stale tab id");
  assert.deepEqual(h.attached, [], "never attached to a tab that is gone");
  assert.equal(shares(h).length, 0);
});

test("a debugger session that outlived the worker is kept, not abandoned", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, attachFails: true });
  await bootWorker();

  assert.ok(
    await until(() => shares(h).length > 0),
    "attach throws when something is already attached; the drive check is what decides",
  );
  assert.equal(h.store.attachedTabId, 7);
});

test("nothing is restored when no tab was ever shared", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();

  assert.ok(await until(() => h.sockets.length > 0), "still connects");
  assert.deepEqual(h.attached, []);
  assert.equal(shares(h).length, 0);
});

test("sharing a different tab mid-restore wins, and the restore backs off", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { ...GMAIL, 9: { title: "Bank", url: "https://bank.example/" } },
    activeTab: 9,
    gated: true,
  });
  await bootWorker();

  const answered = h.message({ type: "share-current-tab" });
  h.openGate();
  const reply = await answered;

  assert.equal(reply.ok, true);
  assert.equal(h.store.attachedTabId, 9, "storage holds the tab the person picked");
  const titles = shares(h).map((m) => m.title);
  assert.ok(!titles.includes("Gmail"), `never announced the abandoned tab, got ${JSON.stringify(titles)}`);
  assert.deepEqual(
    h.banners.filter((b) => b.on).map((b) => b.tabId),
    [9],
    "and only the chosen tab is marked as shared",
  );
});

test("stopping mid-restore is not quietly undone", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, gated: true });
  await bootWorker();

  const answered = h.message({ type: "stop-sharing" });
  h.openGate();
  await answered;

  assert.ok(await until(() => !("attachedTabId" in h.store)), "the share is really gone");
  assert.ok(
    h.sent().some((m) => m.qm === "detached"),
    "and MiniOmni is told, so the browser choice is handed back",
  );
});

test("a storage failure does not brick the keepalive reconnect", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, storageFailures: 3 });
  await bootWorker();

  assert.equal(h.sockets.length, 0, "boot could not read the token, so nothing connected");

  assert.ok(
    await until(() => {
      h.fire("alarm");
      return h.sockets.length > 0;
    }),
    "the alarm still recovers — a rejected promise must not poison the only retry path",
  );
});

test("the person cancelling the debugger bar is a real stop, and says so", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  assert.ok(await until(() => shares(h).length > 0));

  h.fire("detach", { tabId: 7 }, "canceled_by_user");

  assert.ok(await until(() => h.sent().some((m) => m.qm === "detached")), "MiniOmni is told the share ended");
});

test("a detach Chrome caused is recovered from, not treated as a decision", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  assert.ok(await until(() => shares(h).length > 0));
  const before = h.attached.length;

  h.fire("detach", { tabId: 7 }, "target_closed");

  assert.ok(await until(() => h.attached.length > before), "took the tab back");
  assert.ok(!h.sent().some((m) => m.qm === "detached"), "and never claimed the person stopped");
  assert.ok(!h.sent().some((m) => m.qm === "note"), "nothing to report — the share survived");
});

test("a share that cannot be recovered is ended, not left half-alive", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  assert.ok(await until(() => shares(h).length > 0));

  h.canDrive = false;
  h.fire("detach", { tabId: 7 }, "target_closed");

  assert.ok(
    await until(() => h.sent().some((m) => m.qm === "detached")),
    "the relay stops reporting a share that no longer works",
  );
  assert.ok(await until(() => !("attachedTabId" in h.store)), "and nothing is left to restore");
});
