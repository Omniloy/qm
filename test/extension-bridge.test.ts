import test from "node:test";
import assert from "node:assert/strict";

interface Tab {
  title: string;
  url: string;
  windowId?: number;
  active?: boolean;
  openerTabId?: number;
  origin?: string;
  focused?: string;
  frames?: string[];
  says?: string;
  cookies?: Array<{ name: string; domain: string }>;
}

interface Harness {
  canDrive: boolean;
  sockets: FakeSocket[];
  tabs: Record<number, Tab>;
  attached: Array<{ tabId: number }>;
  detached: Array<{ tabId: number }>;
  created: Array<{ tabId: number; windowId?: number; url: string; active?: boolean }>;
  removed: number[];
  live: Set<number>;
  worlds: string[];
  commands: Array<{ tabId: number; method: string }>;
  sentParams: Array<{ method: string; params: unknown }>;
  store: Record<string, unknown>;
  banners: Array<{ tabId: number; on: boolean }>;
  sent(): Array<Record<string, unknown>>;
  fire(event: string, ...args: unknown[]): void;
  message(msg: Record<string, unknown>, sender?: Record<string, unknown>): Promise<Record<string, unknown>>;
  command(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  tick(): void;
  openGate(): void;
  openAttach(): void;
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

let ticks: Array<() => void> = [];

function install(opts: {
  store?: Record<string, unknown>;
  tabs?: Record<number, Tab>;
  undrivable?: number[];
  live?: number[];
  hangs?: number[];
  attachGate?: boolean;
  config?: Record<string, string>;
  noWindow?: boolean;
  attachFails?: boolean;
  canDrive?: boolean;
  storageFailures?: number;
  activeTab?: number;
  gated?: boolean;
}): Harness {
  const store: Record<string, unknown> = { ...opts.store };
  const tabs: Record<number, Tab> = Object.fromEntries(
    Object.entries(opts.tabs ?? {}).map(([id, tab]) => [id, { ...tab }]),
  );
  const attached: Array<{ tabId: number }> = [];
  const detached: Array<{ tabId: number }> = [];
  const created: Harness["created"] = [];
  const removed: number[] = [];
  const live = new Set<number>(opts.live ?? []);
  const worlds: string[] = [];
  const commands: Harness["commands"] = [];
  const sentParams: Harness["sentParams"] = [];
  let letAttach = (): void => {};
  const attachGate = opts.attachGate ? new Promise<void>((r) => (letAttach = r)) : Promise.resolve();
  let nextTab = 100;
  const openTab = (windowId: number, url: string, active?: boolean) => {
    const id = nextTab++;
    tabs[id] = { title: "", url, windowId };
    created.push({ tabId: id, windowId, url, active });
    return { id, windowId, url, active: Boolean(active) };
  };
  ticks = [];
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
      query: async (q: { active?: boolean }) => {
        if (!q?.active) {
          return Object.entries(tabs).map(([id, tab]) => ({ id: Number(id), windowId: 1, active: false, ...tab }));
        }
        const id = opts.activeTab ?? Number(Object.keys(tabs)[0]);
        return tabs[id] ? [{ id, ...tabs[id] }] : [];
      },
      create: async ({ windowId, url, active }: { windowId: number; url: string; active?: boolean }) =>
        openTab(windowId, url, active),
      remove: async (id: number) => {
        delete tabs[id];
        removed.push(id);
      },
      onRemoved: on("removed"),
    },
    webNavigation: { onCreatedNavigationTarget: on("opened") },
    debugger: {
      attach: async ({ tabId }: { tabId: number }) => {
        if (opts.attachFails) throw new Error("Cannot access a chrome:// URL");
        if (live.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
        await attachGate;
        live.add(tabId);
        attached.push({ tabId });
      },
      detach: async ({ tabId }: { tabId: number }) => {
        if (!live.delete(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        detached.push({ tabId });
      },
      sendCommand: async ({ tabId }: { tabId: number }, method: string, params?: unknown) => {
        if (!live.has(tabId) || !harness.canDrive || !(tabId in tabs) || opts.undrivable?.includes(tabId)) {
          throw new Error(`Debugger is not attached to the tab with id: ${tabId}`);
        }
        if (method === "Runtime.evaluate" && opts.hangs?.includes(tabId)) return new Promise(() => {});
        commands.push({ tabId, method });
        sentParams.push({ method, params });
        const tab = tabs[tabId]!;
        const originOf = (u: string) => (/^https?:/.test(u) ? new URL(u).origin : "null");
        const origin = tab.origin ?? originOf(tab.url);
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: `f${tabId}`, url: tab.url, securityOrigin: origin },
              childFrames: (tab.frames ?? []).map((u, i) => ({
                frame: { id: `f${tabId}-${i}`, url: u, securityOrigin: originOf(u) },
              })),
            },
          };
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 99 };
        if (method === "Network.getResponseBody") return { body: "ok", base64Encoded: false };
        if (method === "Network.getCookies") return { cookies: tab.cookies ?? [] };
        if (method === "Fetch.takeResponseBodyAsStream") return { stream: "s-1" };
        if (method === "Runtime.evaluate") {
          const asked = String((params as { expression?: string } | undefined)?.expression ?? "");
          const value = asked.includes("activeElement") ? (tab.focused ?? "INPUT") : (tab.says ?? origin);
          return { result: { type: "string", value } };
        }
        return {};
      },
      onEvent: on("event"),
      onDetach: on("detach"),
    },
    windows: {
      getLastFocused: async () => {
        if (opts.noWindow) throw new Error("No last-focused window");
        return { id: 1 };
      },
      create: async ({ url }: { url: string }) => ({ id: 2, tabs: [openTab(2, url, true)] }),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: {
      executeScript: async ({
        target,
        args,
        world,
      }: {
        target: { tabId: number };
        args: unknown[];
        world?: string;
      }) => {
        if (opts.hangs?.includes(target.tabId)) return new Promise(() => {});
        banners.push({ tabId: target.tabId, on: Boolean(args?.[0]) });
        worlds.push(world ?? "ISOLATED");
        return [];
      },
    },
    alarms: { create: () => {}, onAlarm: on("alarm") },
    runtime: {
      id: "test",
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: on("message"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
    },
  };

  (globalThis as Record<string, unknown>).chrome = chrome;
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  (globalThis as Record<string, unknown>).fetch = async () => {
    if (!opts.config) throw new Error("no baked config");
    return { json: async () => opts.config };
  };

  const harness: Harness = {
    canDrive: opts.canDrive !== false,
    sockets: FakeSocket.all,
    tabs,
    attached,
    detached,
    created,
    removed,
    live,
    worlds,
    commands,
    sentParams,
    store,
    banners,
    sent: () => (FakeSocket.all[0]?.sent ?? []).map((s) => JSON.parse(s) as Record<string, unknown>),
    fire: (event, ...args) => {
      for (const fn of listeners[event] ?? []) fn(...args);
    },
    message: (msg, sender = { id: "test", url: "chrome-extension://test/popup.html" }) =>
      new Promise((resolve) => {
        for (const fn of listeners.message ?? []) {
          if (fn(msg, sender, resolve) === false) resolve({ ignored: true });
        }
      }),
    command: async (id, method, params) => {
      FakeSocket.all[0]!.onmessage?.({ data: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
      assert.ok(await until(() => harness.sent().some((m) => m.id === id), 8000), `${method} was answered`);
      return harness.sent().find((m) => m.id === id)!;
    },
    tick: () => {
      for (const fn of ticks) fn();
    },
    openGate: () => release(),
    openAttach: () => letAttach(),
  };
  return harness;
}

let bust = 0;
async function bootWorker(): Promise<void> {
  bust += 1;
  const real = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => {
    ticks.push(fn);
    return 0;
  }) as unknown as typeof setInterval;
  try {
    await import(`../extension/background.js?case=${bust}`);
  } finally {
    globalThis.setInterval = real;
  }
}

function popUp(h: Harness, from: number, id: number, active = true): void {
  h.tabs[id]!.active = active;
  h.fire("opened", { sourceTabId: from, tabId: id });
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
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, live: [7] });
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
    "and qm is told, so the browser choice is handed back",
  );
});

test("a storage failure does not brick the keepalive reconnect", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, storageFailures: 5 });
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

  assert.ok(await until(() => h.sent().some((m) => m.qm === "detached")), "qm is told the share ended");
  assert.equal(h.store.stopped, true, "and it stays stopped");
  const reply = await h.command(1, "Page.navigate", { url: "https://x.test/" });
  assert.match((reply.error as { message: string }).message, /stopped/);
  assert.deepEqual(h.created, [], "no tab is opened behind the person's back");
});

test("a detach Chrome caused is recovered from, not treated as a decision", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  assert.ok(await until(() => shares(h).length > 0));
  const before = h.attached.length;

  h.live.delete(7);
  h.fire("detach", { tabId: 7 }, "target_closed");

  assert.ok(await until(() => h.attached.length > before), "took the tab back");
  assert.ok(!h.sent().some((m) => m.qm === "detached"), "and never claimed the person stopped");
  assert.ok(!h.sent().some((m) => m.qm === "note"), "nothing to report — the share survived");
});

test("a tab that cannot be recovered is released, not left half-alive and not a stop", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  assert.ok(await until(() => shares(h).length > 0));

  h.canDrive = false;
  h.live.delete(7);
  h.fire("detach", { tabId: 7 }, "target_closed");

  assert.ok(
    await until(() => h.sent().some((m) => m.qm === "released")),
    "the relay stops reporting a tab that no longer works",
  );
  assert.ok(!h.sent().some((m) => m.qm === "detached"), "and the browser choice is not handed back");
  assert.ok(await until(() => !("attachedTabId" in h.store)), "and nothing is left to restore");
});

const booted = async (h: Harness): Promise<void> => {
  assert.ok(await until(() => h.sockets.length > 0, 8000), "connected to the relay");
  await new Promise((r) => setTimeout(r, 10));
};

test("with nothing shared, the handshake answers without opening a tab", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();
  await booted(h);

  const targets = await h.command(1, "Target.getTargets");
  const sessions = await h.command(2, "Target.attachToTarget", { targetId: "qm-extension-page", flatten: true });

  const info = (targets.result as { targetInfos: Array<{ targetId: string; type: string }> }).targetInfos[0]!;
  assert.equal(info.targetId, "qm-extension-page");
  assert.equal(info.type, "page");
  assert.ok((sessions.result as { sessionId: string }).sessionId);
  assert.deepEqual(h.created, [], "listing tabs and moving to one must not leave a blank tab behind");
});

test("the first real command opens a tab and drives it, without re-picking the browser", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();
  await booted(h);

  const reply = await h.command(3, "Page.navigate", { url: "https://x.test/" });

  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.equal(h.created.length, 1);
  const opened = h.created[0]!;
  assert.equal(opened.windowId, 1, "in the person's front window");
  assert.equal(opened.active, true, "where they can see it");
  assert.deepEqual(h.commands.at(-1), { tabId: opened.tabId, method: "Page.navigate" });
  assert.equal(h.store.attachedTabId, opened.tabId);
  assert.equal(shares(h).at(-1)!.restored, true, "only the person sharing a tab picks the browser");
  assert.deepEqual(
    h.banners.filter((b) => b.on).map((b) => b.tabId),
    [opened.tabId],
    "and the tab is marked",
  );
});

test("two commands racing with nothing shared open one tab, not two", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();
  await booted(h);

  await Promise.all([h.command(4, "Page.enable"), h.command(5, "Runtime.evaluate", { expression: "1" })]);

  assert.equal(h.created.length, 1);
});

test("a window-less Chrome still gets a tab", async () => {
  const h = install({ store: { ...PAIRED }, tabs: {}, noWindow: true });
  await bootWorker();
  await booted(h);

  const reply = await h.command(6, "Page.enable");

  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.equal(h.created[0]!.windowId, 2, "a new window was opened for it");
});

test("a new target opens a tab at that address and moves there", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const reply = await h.command(7, "Target.createTarget", { url: "https://receipt.test/" });

  assert.equal((reply.result as { targetId: string }).targetId, "qm-extension-page");
  assert.equal(h.created[0]!.url, "https://receipt.test/");
  assert.equal(h.store.attachedTabId, h.created[0]!.tabId);
});

test("every tab in every window can be listed and moved to", async () => {
  const h = install({
    store: { ...PAIRED },
    tabs: { ...GMAIL, 9: { title: "Bank", url: "https://bank.example/", windowId: 2 } },
  });
  await bootWorker();
  await booted(h);

  const listed = await h.command(8, "qm.listTabs");
  const tabs = (listed.result as { tabs: Array<{ tabId: number; windowId: number }> }).tabs;
  assert.deepEqual(
    tabs.map((t) => [t.tabId, t.windowId]),
    [
      [7, 1],
      [9, 2],
    ],
  );
  assert.deepEqual(h.created, [], "listing needs no tab of its own");

  const moved = await h.command(9, "qm.switchTab", { tabId: 9 });

  assert.equal((moved.result as { tabId: number }).tabId, 9);
  assert.equal(h.store.attachedTabId, 9, "a tab in another window is reachable");
  assert.equal(shares(h).at(-1)!.restored, true, "the agent moving does not re-pick the browser");
});

test("a tab that cannot be driven, or does not exist, is refused by name", async () => {
  const h = install({
    store: { ...PAIRED },
    tabs: { ...GMAIL, 11: { title: "Extensions", url: "chrome://extensions/" } },
    undrivable: [11],
  });
  await bootWorker();
  await booted(h);

  const locked = await h.command(10, "qm.switchTab", { tabId: 11 });
  const missing = await h.command(11, "qm.switchTab", { tabId: 404 });

  assert.match((locked.error as { message: string }).message, /cannot be driven/);
  assert.match((missing.error as { message: string }).message, /no open tab/);
  assert.ok(!h.attached.some((a) => a.tabId === 11), "a page that is off limits is never attached to");
});

const DASHBOARD = { 7: { title: "Gmail", url: "https://mail.google.com/" } };

test("the extension's own pages, Chrome's pages and local files are off limits", async () => {
  const h = install({
    store: { ...PAIRED },
    tabs: {
      ...DASHBOARD,
      21: { title: "Browser Bridge", url: "chrome-extension://test/popup.html" },
      22: { title: "notes", url: "file:///Users/someone/notes.txt" },
    },
  });
  await bootWorker();
  await booted(h);

  const listed = await h.command(30, "qm.listTabs");
  const ids = (listed.result as { tabs: Array<{ tabId: number }> }).tabs.map((t) => t.tabId);
  assert.deepEqual(ids, [7], "only web pages are offered");
  for (const [i, tabId] of [21, 22].entries()) {
    const reply = await h.command(31 + i, "qm.switchTab", { tabId });
    assert.match((reply.error as { message: string }).message, /cannot be driven/);
  }
  const nav = await h.command(33, "Page.navigate", { url: "chrome-extension://test/popup.html" });
  assert.match((nav.error as { message: string }).message, /cannot be driven/);
  const opened = await h.command(34, "Target.createTarget", { url: "chrome://settings" });
  assert.match((opened.error as { message: string }).message, /cannot be driven/);
  assert.deepEqual(h.created, [], "and no tab is left behind for one");
  assert.ok(!h.attached.some((a) => a.tabId === 21 || a.tabId === 22));
});

test("a driven tab that ends up on an off-limits page is let go, not driven", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[7] = { title: "Browser Bridge", url: "chrome-extension://test/popup.html" };
  const reply = await h.command(35, "Runtime.evaluate", { expression: "chrome.storage" });

  assert.match((reply.error as { message: string }).message, /cannot be driven/);
  assert.ok(!h.commands.some((c) => c.method === "Runtime.evaluate" && c.tabId === 7 && h.commands.length > 1));
  assert.ok(await until(() => h.sent().some((m) => m.qm === "released")));
  assert.ok(!h.live.has(7));
});

test("the banner runs in the page's own world, so no extension context is exposed to the page", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  assert.ok(await until(() => h.banners.length > 0));
  assert.deepEqual([...new Set(h.worlds)], ["MAIN"]);
});

test("messages from anything but the extension's own pages are ignored", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD, activeTab: 7 });
  await bootWorker();
  await booted(h);

  const fromPage = await h.message(
    { type: "share-current-tab" },
    { id: "test", url: "https://evil.example/", tab: {} },
  );
  const fromElsewhere = await h.message(
    { type: "stop-sharing" },
    { id: "other", url: "chrome-extension://other/x.html" },
  );

  assert.deepEqual(fromPage, { ignored: true });
  assert.deepEqual(fromElsewhere, { ignored: true });
  assert.ok(!("stopped" in h.store));
});

test("Share works on the tab the agent is already driving", async () => {
  const h = install({ store: { ...PAIRED }, tabs: DASHBOARD, activeTab: 7 });
  await bootWorker();
  await booted(h);
  await h.command(36, "qm.switchTab", { tabId: 7 });
  assert.ok(h.live.has(7));

  const shared = await h.message({ type: "share-current-tab" });

  assert.equal(shared.ok, true, JSON.stringify(shared));
  assert.equal(shares(h).at(-1)!.restored, undefined, "the person's click is what picks the browser");
});

test("two tabs opened at once leave exactly one driven tab, marked and remembered", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[8] = { title: "A", url: "https://a.example/" };
  h.tabs[9] = { title: "B", url: "https://b.example/" };
  popUp(h, 7, 8);
  popUp(h, 7, 9);
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(h.live.size, 1, `one debugger session, got ${[...h.live]}`);
  const driven = [...h.live][0]!;
  assert.equal(h.store.attachedTabId, driven, "storage names the tab actually driven");
  const lit = new Map<number, boolean>();
  for (const b of h.banners) lit.set(b.tabId, b.on);
  assert.deepEqual(
    [...lit].filter(([, on]) => on).map(([id]) => id),
    [driven],
    "and only that tab carries the banner",
  );
});

test("a tab the person opens in the background is not taken over", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[8] = { title: "Theirs", url: "https://theirs.example/" };
  popUp(h, 7, 8, false);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(h.store.attachedTabId, 7);
});

test("a pop-up is followed by the tab it came from, not by whichever tab was in front", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[8] = { title: "Someone else's", url: "https://elsewhere.example/" };
  popUp(h, 3, 8);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.store.attachedTabId, 7, "a pop-up from another tab is left alone");

  h.tabs[9] = { title: "Receipt", url: "https://receipt.example/" };
  popUp(h, 7, 9);
  assert.ok(await until(() => h.store.attachedTabId === 9), "one from the driven tab is followed");
});

test("the tab list names the tab a pop-up really came from, not Chrome's guess", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[8] = { title: "Receipt", url: "https://receipt.example/", openerTabId: 3 };
  popUp(h, 7, 8, false);
  const listed = await h.command(60, "qm.listTabs");
  const tabs = (listed.result as { tabs: Array<{ tabId: number; openerTabId: number | null }> }).tabs;
  assert.equal(tabs.find((t) => t.tabId === 8)?.openerTabId, 7);
});

test("whether a new tab is in front is judged when it opens, not after the queue drains", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[8] = { title: "Read later", url: "https://later.example/" };
  popUp(h, 7, 8, false);
  h.tabs[8].active = true;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.store.attachedTabId, 7, "a tab they opened in the background and then looked at is theirs");

  h.tabs[9] = { title: "Sign in", url: "https://accounts.example/" };
  popUp(h, 7, 9);
  h.tabs[9].active = false;
  assert.ok(await until(() => h.store.attachedTabId === 9), "a pop-up that opened in front is followed");
});

test("a pop-up is followed even when the tab that opened it closes straight away", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[8] = { title: "Next step", url: "https://accounts.example/" };
  popUp(h, 7, 8);
  delete h.tabs[7];
  h.fire("detach", { tabId: 7 }, "target_closed");
  h.fire("removed", 7);

  assert.ok(await until(() => h.store.attachedTabId === 8), "the sign-in carries on in the pop-up");
});

test("a page busy with a dialog does not wedge every command behind it", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD, hangs: [7] });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7, 4000));
  h.tabs[8] = { title: "Sign in", url: "https://accounts.example/" };
  popUp(h, 7, 8);
  assert.ok(await until(() => h.store.attachedTabId === 8));

  delete h.tabs[8];
  h.fire("removed", 8);
  const reply = await h.command(37, "Page.handleJavaScriptDialog", { accept: true });

  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.deepEqual(h.commands.at(-1), { tabId: 7, method: "Page.handleJavaScriptDialog" });
});

test("Stop wins over a tab that was being opened at that moment", async () => {
  const h = install({ store: { ...PAIRED }, tabs: DASHBOARD, attachGate: true });
  await bootWorker();
  await booted(h);

  const reply = h.command(38, "Page.navigate", { url: "https://x.test/" });
  assert.ok(await until(() => h.created.length === 1), "a tab is on its way");
  const stopped = h.message({ type: "stop-sharing" });
  h.openAttach();
  await stopped;

  assert.match(((await reply).error as { message: string }).message, /stopped/);
  assert.equal(h.live.size, 0, "no debugger session survives the stop");
  assert.deepEqual(h.removed, [h.created[0]!.tabId], "and the half-opened tab is closed again");
  const frames = h
    .sent()
    .filter((m) => m.qm === "attached" || m.qm === "detached")
    .map((m) => m.qm);
  assert.equal(frames.at(-1), "detached", `the relay ends on the stop, got ${frames}`);
});

test("letting go releases the tab without stopping anything", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const reply = await h.command(39, "qm.release");

  assert.ok(!reply.error);
  assert.equal(h.live.size, 0);
  assert.ok(h.sent().some((m) => m.qm === "released"));
  assert.ok(!h.sent().some((m) => m.qm === "detached"));
  assert.ok(!("stopped" in h.store));
});

test("browser-level commands are refused, never sent to a tab", async () => {
  const h = install({ store: { ...PAIRED }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);

  const reply = await h.command(40, "Target.closeTarget", { targetId: "x" });

  assert.match((reply.error as { message: string }).message, /not available/);
  assert.deepEqual(h.created, []);
});

test("a stale socket closing late does not orphan the live one", async () => {
  const h = install({ store: { ...PAIRED }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  const stale = h.sockets[0]!;
  stale.readyState = 2;
  h.fire("alarm");
  assert.ok(await until(() => h.sockets.length === 2), "a fresh socket opened");
  const fresh = h.sockets[1]!;

  stale.onclose?.();
  fresh.onmessage?.({ data: JSON.stringify({ id: 41, method: "qm.listTabs" }) });

  assert.ok(
    await until(() => fresh.sent.some((raw) => (JSON.parse(raw) as { id?: number }).id === 41)),
    "the reply still goes out on the live socket",
  );
});

test("Stop keeps the agent out until the person shares a tab again", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, activeTab: 7 });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => shares(h).length > 0));

  await h.message({ type: "stop-sharing" });

  assert.equal(h.store.stopped, true);
  assert.ok(
    h.sent().some((m) => m.qm === "detached"),
    "qm is told, so the browser choice is handed back",
  );
  const refused = await h.command(12, "Page.navigate", { url: "https://x.test/" });
  assert.match((refused.error as { message: string }).message, /stopped/);
  const listing = await h.command(13, "qm.listTabs");
  assert.match((listing.error as { message: string }).message, /stopped/, "not even a look at the tabs");
  assert.deepEqual(h.created, []);
  assert.equal((await h.message({ type: "status" })).stopped, true, "the popup says so");

  const shared = await h.message({ type: "share-current-tab" });

  assert.equal(shared.ok, true);
  assert.ok(!("stopped" in h.store), "sharing a tab is what lets it back in");
  const back = await h.command(14, "Page.navigate", { url: "https://x.test/" });
  assert.ok(!back.error, JSON.stringify(back.error));
});

test("a tab the driven one opened goes back to its opener when it closes", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.tabs[8] = { title: "Sign in", url: "https://accounts.example/" };
  popUp(h, 7, 8);
  assert.ok(await until(() => h.store.attachedTabId === 8), "followed the pop-up");

  delete h.tabs[8];
  h.fire("detach", { tabId: 8 }, "target_closed");
  h.fire("removed", 8);

  assert.ok(await until(() => h.store.attachedTabId === 7), "back on the tab that opened it");
  assert.equal(shares(h).at(-1)!.title, "Gmail");
  assert.ok(!h.sent().some((m) => m.qm === "released" || m.qm === "detached"), "with no share lost");
});

test("a command that lands while the tab is being handed back waits, rather than opening a stray tab", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));
  h.tabs[8] = { title: "Sign in", url: "https://accounts.example/" };
  popUp(h, 7, 8);
  assert.ok(await until(() => h.store.attachedTabId === 8));

  delete h.tabs[8];
  h.fire("removed", 8);
  const reply = await h.command(16, "Runtime.evaluate", { expression: "1" });

  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.deepEqual(h.created, [], "the opener was still there to go back to");
  assert.deepEqual(h.commands.at(-1), { tabId: 7, method: "Runtime.evaluate" });
});

test("closing the only tab releases it, and the next command opens a fresh one", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  delete h.tabs[7];
  h.fire("removed", 7);

  assert.ok(await until(() => h.sent().some((m) => m.qm === "released")));
  assert.ok(!h.sent().some((m) => m.qm === "detached"), "closing a tab is not a stop");
  const reply = await h.command(15, "Page.enable");
  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.equal(h.created.length, 1);
});

test("a keepalive goes out while connected, so Chrome keeps the extension awake", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();
  await booted(h);

  h.tick();

  assert.ok(h.sent().some((m) => m.qm === "ping"));
});

test("commands that reach local files or every site at once are withheld", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  for (const [i, method] of [
    "DOM.setFileInputFiles",
    "Input.dispatchDragEvent",
    "Network.clearBrowserCookies",
  ].entries()) {
    const reply = await h.command(50 + i, method, { files: ["/Users/someone/.ssh/id_ed25519"] });
    assert.match((reply.error as { message: string }).message, /not available/, method);
  }
  assert.ok(!h.commands.some((c) => c.method === "DOM.setFileInputFiles"));
});

test("QM's own web app is off limits, so the agent cannot act there with the person's session", async () => {
  const h = install({
    store: { origin: "https://relay.qm.example.com", token: "tok" },
    config: { app: "https://qm.example.com" },
    tabs: { ...DASHBOARD, 23: { title: "Keychain", url: "https://qm.example.com/keychain" } },
  });
  await bootWorker();
  await booted(h);

  assert.equal(h.store.app, "https://qm.example.com", "an update fills in the app address it did not have");
  const listed = await h.command(53, "qm.listTabs");
  assert.deepEqual(
    (listed.result as { tabs: Array<{ tabId: number }> }).tabs.map((t) => t.tabId),
    [7],
  );
  const moved = await h.command(54, "qm.switchTab", { tabId: 23 });
  assert.match((moved.error as { message: string }).message, /cannot be driven/);
  const nav = await h.command(55, "Page.navigate", { url: "https://qm.example.com/admin" });
  assert.match((nav.error as { message: string }).message, /cannot be driven/);
});

test("a blank tab that carries an extension's origin is refused, and the agent's own tab is opaque", async () => {
  const h = install({
    store: { ...PAIRED },
    tabs: { ...DASHBOARD, 24: { title: "", url: "about:blank", origin: "chrome-extension://other" } },
  });
  await bootWorker();
  await booted(h);

  const moved = await h.command(56, "qm.switchTab", { tabId: 24 });
  assert.match((moved.error as { message: string }).message, /cannot be driven/);
  assert.ok(!h.live.has(24), "and the probe's session is let go");
  await h.command(57, "Page.enable");
  assert.match(h.created[0]!.url, /^data:text\/html,/, "its own tab is a data: page, which has no origin to inherit");
});

test("Stop pressed while a Share is still attaching stays stopped", async () => {
  const h = install({ store: { ...PAIRED }, tabs: DASHBOARD, activeTab: 7, attachGate: true });
  await bootWorker();
  await booted(h);

  const sharing = h.message({ type: "share-current-tab" });
  await new Promise((r) => setTimeout(r, 20));
  const stopping = h.message({ type: "stop-sharing" });
  h.openAttach();
  await Promise.all([sharing, stopping]);

  assert.equal(h.store.stopped, true, "the later decision wins in storage");
  assert.equal((await h.message({ type: "status" })).stopped, true, "and in the running worker");
  const refused = await h.command(58, "Page.enable");
  assert.match((refused.error as { message: string }).message, /stopped/);
  assert.equal(h.live.size, 0);
});

test("a stored password is typed only while the tab in use is on its site", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const wrong = await h.command(59, "qm.insertText", { text: "s3cret", origin: "https://bank.example" });
  assert.match((wrong.error as { message: string }).message, /refusing to type/);
  assert.ok(!h.commands.some((c) => c.method === "Input.insertText"));

  const right = await h.command(60, "qm.insertText", { text: "s3cret", origin: "https://mail.google.com" });
  assert.ok(!right.error, JSON.stringify(right.error));
  assert.deepEqual(h.commands.at(-1), { tabId: 7, method: "Input.insertText" });
});

test("only the commands the agent's verbs use get through", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const refusedMethods = [
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.navigateToHistoryEntry",
    "Network.getAllCookies",
    "Network.setCookie",
    "Storage.getCookies",
    "Storage.clearDataForStorageKey",
    "IndexedDB.requestData",
  ];
  for (const [i, method] of refusedMethods.entries()) {
    const reply = await h.command(70 + i, method, {});
    assert.match((reply.error as { message: string }).message, /not available/, method);
  }
  const qmCookies = await h.command(80, "Network.getCookies", { urls: ["https://qm.example.com/"] });
  assert.match((qmCookies.error as { message: string }).message, /cannot be driven/);
  const rerouted = await h.command(81, "Fetch.continueRequest", { requestId: "r1", url: "https://qm.example.com/" });
  assert.match((rerouted.error as { message: string }).message, /unchanged/);
  const ok = await h.command(82, "Network.getCookies", {});
  assert.ok(!ok.error, "the page's own cookies still work");
});

test("events about QM's own origin, and anything carrying raw cookie headers, never reach the agent", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));
  const before = h.sent().length;

  h.fire("event", { tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "1",
    request: { url: "https://qm.example.com/" },
  });
  h.fire("event", { tabId: 7 }, "Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { Cookie: "s=1" } });
  h.fire("event", { tabId: 7 }, "Runtime.consoleAPICalled", { args: [{ value: "exfil" }] });
  h.fire("event", { tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "2",
    request: { url: "https://mail.google.com/x" },
  });

  const forwarded = h
    .sent()
    .slice(before)
    .filter((m) => typeof m.method === "string");
  assert.deepEqual(
    forwarded.map((m) => [m.method, (m.params as { requestId?: string }).requestId]),
    [["Network.requestWillBeSent", "2"]],
  );
});

test("the relay tells the extension QM's own address, which is then off limits", async () => {
  const h = install({
    store: { origin: "https://relay.qm.example.com", token: "tok" },
    tabs: { ...DASHBOARD, 25: { title: "QM", url: "https://app.qm.example.com/keychain" } },
  });
  await bootWorker();
  await booted(h);
  h.sockets[0]!.onmessage?.({ data: JSON.stringify({ qm: "origins", app: "https://app.qm.example.com/" }) });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(h.store.apps, ["https://app.qm.example.com"]);
  const moved = await h.command(83, "qm.switchTab", { tabId: 25 });
  assert.match((moved.error as { message: string }).message, /cannot be driven/);
});

test("a password is not typed into a focused frame from another site", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { 7: { title: "Gmail", url: "https://mail.google.com/", focused: "IFRAME" } },
  });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const reply = await h.command(84, "qm.insertText", { text: "s3cret", origin: "https://mail.google.com" });

  assert.match((reply.error as { message: string }).message, /refusing to type/);
  assert.ok(!h.commands.some((c) => c.method === "Input.insertText"));
});

test("a blank tab too busy to say where it came from is not taken", async () => {
  const h = install({
    store: { ...PAIRED },
    tabs: { ...DASHBOARD, 26: { title: "", url: "about:blank", origin: "https://qm.example.com" } },
    hangs: [26],
  });
  await bootWorker();
  await booted(h);

  const moved = await h.command(85, "qm.switchTab", { tabId: 26 });

  assert.match((moved.error as { message: string }).message, /cannot be driven/);
  assert.ok(!h.live.has(26));
});

test("cookies are only ever the driven page's own, never a frame it was made to load", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  await h.command(90, "Network.getCookies", {});
  assert.deepEqual(h.sentParams.at(-1), {
    method: "Network.getCookies",
    params: { urls: ["https://mail.google.com/"] },
  });

  h.tabs[7]!.frames = ["https://qm.example.com/v1/whoami"];
  const framed = await h.command(91, "Network.getCookies", {});
  assert.match((framed.error as { message: string }).message, /QM itself open inside it/);
  for (const [i, method] of ["Input.dispatchMouseEvent", "Page.captureScreenshot", "Runtime.evaluate"].entries()) {
    const reply = await h.command(92 + i, method, method === "Runtime.evaluate" ? { expression: "1" } : {});
    assert.match((reply.error as { message: string }).message, /QM itself open inside it/, method);
  }
});

test("response bodies and streams are only for requests the agent was shown", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const guessed = await h.command(95, "Network.getResponseBody", { requestId: "41" });
  assert.match((guessed.error as { message: string }).message, /not one this tab showed you/);

  h.fire("event", { tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "42",
    request: { url: "https://mail.google.com/a" },
  });
  h.fire("event", { tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "43",
    request: { url: "https://qm.example.com/api" },
  });
  h.fire("event", { tabId: 7 }, "Network.loadingFinished", { requestId: "43" });
  h.fire("event", { tabId: 7 }, "Network.loadingFinished", { requestId: "42" });

  const shown = await h.command(96, "Network.getResponseBody", { requestId: "42" });
  assert.ok(!shown.error, JSON.stringify(shown.error));
  const hidden = await h.command(97, "Network.getResponseBody", { requestId: "43" });
  assert.match((hidden.error as { message: string }).message, /not one this tab showed you/);
  const finished = h.sent().filter((m) => m.method === "Network.loadingFinished");
  assert.deepEqual(
    finished.map((m) => (m.params as { requestId: string }).requestId),
    ["42"],
    "a QM request's completion is not even announced",
  );

  const stray = await h.command(98, "IO.read", { handle: "s-9" });
  assert.match((stray.error as { message: string }).message, /not one this tab gave you/);
  h.fire("event", { tabId: 7 }, "Fetch.requestPaused", {
    requestId: "interception-job-1.0",
    request: { url: "https://mail.google.com/f" },
  });
  await h.command(99, "Fetch.takeResponseBodyAsStream", { requestId: "interception-job-1.0" });
  const read = await h.command(100, "IO.read", { handle: "s-1" });
  assert.ok(!read.error, JSON.stringify(read.error));
});

test("scripts run only in the page itself, and keyboard shortcuts are refused", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const elsewhere = await h.command(101, "Runtime.evaluate", { expression: "1", contextId: 3 });
  assert.match((elsewhere.error as { message: string }).message, /only in the page itself/);
  const paste = await h.command(102, "Input.dispatchKeyEvent", { type: "keyDown", key: "v", modifiers: 4 });
  assert.match((paste.error as { message: string }).message, /plain navigation keys/);
  const command = await h.command(103, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    commands: ["paste"],
  });
  assert.match((command.error as { message: string }).message, /plain navigation keys/);
  const insert = await h.command(108, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Insert", modifiers: 8 });
  assert.match((insert.error as { message: string }).message, /plain navigation keys/, "Shift+Insert pastes too");
  const middle = await h.command(109, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 1,
    y: 1,
    button: "middle",
  });
  assert.match((middle.error as { message: string }).message, /plain left clicks/, "a middle click pastes on Linux");
  const click = await h.command(110, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left" });
  assert.ok(!click.error, JSON.stringify(click.error));
  const wheel = await h.command(111, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 1, deltaY: 300 });
  assert.ok(!wheel.error, JSON.stringify(wheel.error));
  const enter = await h.command(104, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
  assert.ok(!enter.error, JSON.stringify(enter.error));
});

test("the agent cannot pose as the relay to change what counts as QM's address", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.sockets[0]!.onmessage?.({
    data: JSON.stringify({ id: 105, method: "Page.enable", qm: "origins", app: "https://mail.google.com" }),
  });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(h.store.apps, undefined);
  const reply = await h.command(106, "Runtime.evaluate", { expression: "1" });
  assert.ok(!reply.error, "the person's own tab is still usable");
});

test("a page that lies about its origin in script still cannot receive another site's password", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: { 7: { title: "Sign in", url: "https://evil.example/login", says: "https://accounts.google.com" } },
  });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const reply = await h.command(107, "qm.insertText", { text: "s3cret", origin: "https://accounts.google.com" });

  assert.match((reply.error as { message: string }).message, /refusing to type/);
  assert.ok(!h.commands.some((c) => c.method === "Input.insertText"));
});

test("a cookie QM itself would also receive is never handed over, even from a sibling subdomain", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: {
      7: {
        title: "Shop",
        url: "https://shop.apps.qm.example.com/",
        cookies: [
          { name: "portal_session", domain: ".qm.example.com" },
          { name: "cart", domain: "shop.apps.qm.example.com" },
        ],
      },
    },
  });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const reply = await h.command(112, "Network.getCookies", {});

  assert.deepEqual(
    (reply.result as { cookies: Array<{ name: string }> }).cookies.map((c) => c.name),
    ["cart"],
  );
});

test("a request that redirects into QM stops being readable", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  h.fire("event", { tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "60",
    request: { url: "https://mail.google.com/r" },
  });
  h.fire("event", { tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "60",
    request: { url: "https://qm.example.com/v1/me" },
    redirectResponse: { url: "https://mail.google.com/r" },
  });
  h.fire("event", { tabId: 7 }, "Network.loadingFinished", { requestId: "60" });

  const body = await h.command(113, "Network.getResponseBody", { requestId: "60" });
  assert.match((body.error as { message: string }).message, /not one this tab showed you/);
  assert.ok(!h.sent().some((m) => m.method === "Network.loadingFinished"));
});

test("only shared cookies are matched against QM's hosts, so the page's own host-only cookies stay", async () => {
  const h = install({
    store: { ...PAIRED, attachedTabId: 7 },
    tabs: {
      7: {
        title: "Example",
        url: "https://example.com/",
        cookies: [
          { name: "own", domain: "example.com" },
          { name: "shared", domain: ".example.com" },
        ],
      },
    },
  });
  await bootWorker();
  await booted(h);
  h.sockets[0]!.onmessage?.({ data: JSON.stringify({ qm: "origins", app: "https://qm.example.com" }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const reply = await h.command(114, "Network.getCookies", {});

  assert.deepEqual(
    (reply.result as { cookies: Array<{ name: string }> }).cookies.map((c) => c.name),
    ["own"],
    "a host-only cookie for example.com never reaches qm.example.com; a .example.com one does",
  );
});

test("a redirect out of QM does not carry QM's response to the agent", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));
  const before = h.sent().length;

  h.fire("event", { tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "70",
    request: { url: "https://mail.google.com/after" },
    redirectResponse: { url: "https://qm.example.com/login", headers: { location: "https://mail.google.com/after" } },
  });

  assert.equal(
    h
      .sent()
      .slice(before)
      .filter((m) => typeof m.method === "string").length,
    0,
  );
  const body = await h.command(115, "Network.getResponseBody", { requestId: "70" });
  assert.match((body.error as { message: string }).message, /not one this tab showed you/);
});

test("scripts cannot claim a user gesture", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: DASHBOARD });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => h.store.attachedTabId === 7));

  const reply = await h.command(116, "Runtime.evaluate", {
    expression: "navigator.clipboard.readText()",
    userGesture: true,
  });

  assert.match((reply.error as { message: string }).message, /only in the page itself/);
});

test("a fresh pairing token from the relay is kept and used to reconnect", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();
  await booted(h);

  h.sockets[0]!.onmessage?.({ data: JSON.stringify({ qm: "token", token: "fresh" }) });
  assert.ok(await until(() => h.store.token === "fresh"), "the new token is saved");

  h.sockets[0]!.close();
  h.fire("alarm");
  assert.ok(await until(() => h.sockets.length > 1), "reconnected");
  assert.equal(new URL(h.sockets[1]!.url).searchParams.get("t"), "fresh");
});

test("the agent cannot plant a pairing token by posing as the relay", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();
  await booted(h);

  h.sockets[0]!.onmessage?.({
    data: JSON.stringify({ id: 120, method: "Page.enable", qm: "token", token: "planted" }),
  });
  h.sockets[0]!.onmessage?.({ data: JSON.stringify({ qm: "token", token: "" }) });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(h.store.token, "tok");
});

test("a fresh pairing token does not undo a Stop", async () => {
  const h = install({ store: { ...PAIRED, attachedTabId: 7 }, tabs: GMAIL, activeTab: 7 });
  await bootWorker();
  await booted(h);
  assert.ok(await until(() => shares(h).length > 0));
  await h.message({ type: "stop-sharing" });

  h.sockets[0]!.onmessage?.({ data: JSON.stringify({ qm: "token", token: "fresh" }) });
  assert.ok(await until(() => h.store.token === "fresh"));

  assert.equal(h.store.stopped, true);
  const refused = await h.command(121, "Page.navigate", { url: "https://x.test/" });
  assert.match((refused.error as { message: string }).message, /stopped/);
  assert.deepEqual(h.created, []);
});

test("a token the person saves is not overwritten by a renewal meant for the old one", async () => {
  const h = install({ store: { ...PAIRED }, tabs: GMAIL });
  await bootWorker();
  await booted(h);
  const old = h.sockets[0]!;

  await h.message({ type: "save-settings", origin: PAIRED.origin, token: "mine" });
  assert.equal(old.readyState, 3, "a new token drops the old connection at once");
  old.onmessage?.({ data: JSON.stringify({ qm: "token", token: "renewed-old" }) });
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(h.store.token, "mine");
  assert.ok(await until(() => h.sockets.length > 1));
  assert.equal(new URL(h.sockets.at(-1)!.url).searchParams.get("t"), "mine");
});
