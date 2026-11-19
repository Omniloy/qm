const RELAY_PATH = "/v1/browser-relay/extension";
const PROTOCOL_VERSION = "1.3";
const TARGET_ID = "qm-extension-page";
const SESSION_ID = "qm-extension-session";
const KEEPALIVE_MS = 20_000;
const STOPPED_MESSAGE =
  "they stopped QM using their Chrome — it stays off until they press Share this tab in the Browser Bridge extension";

let socket = null;
let attachedTabId = null;
let previousTabId = null;
let pending = null;
let reconnectDelay = 1000;
let restoreYielded = false;
const ready = Promise.race([
  bootstrapFromConfig().then(restoreShare),
  new Promise((resolve) => setTimeout(resolve, 5000)),
]).catch(() => {});

async function settings() {
  const { origin, token } = await chrome.storage.local.get(["origin", "token"]);
  return { origin: origin || "", token: token || "" };
}

async function bootstrapFromConfig() {
  const { origin } = await settings();
  if (origin) return;
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"));
    const cfg = await res.json();
    const next = {};
    if (cfg.origin) next.origin = cfg.origin;
    if (cfg.token) next.token = cfg.token;
    if (Object.keys(next).length) await chrome.storage.local.set(next);
  } catch {
    void 0;
  }
}

async function isStopped() {
  const { stopped } = await chrome.storage.local.get("stopped").catch(() => ({ stopped: true }));
  return stopped === true;
}

async function badge(tabId, on) {
  await chrome.action.setBadgeText({ tabId, text: on ? "●" : "" }).catch(() => {});
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f9254" }).catch(() => {});
}

function pageBanner(on) {
  const ID = "__qm_bridge_banner__";
  const existing = document.getElementById(ID);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const el = document.createElement("div");
  el.id = ID;
  el.textContent = "● QM is using this tab";
  el.setAttribute("data-qm-bridge", "1");
  el.style.cssText = [
    "position:fixed",
    "top:8px",
    "right:8px",
    "z-index:2147483647",
    "pointer-events:none",
    "font:600 12px/1 system-ui,sans-serif",
    "color:#fff",
    "background:#1f9254",
    "padding:6px 10px",
    "border-radius:999px",
    "box-shadow:0 2px 8px rgba(0,0,0,.25)",
  ].join(";");
  document.documentElement.appendChild(el);
}

async function showBanner(tabId, on) {
  await chrome.scripting.executeScript({ target: { tabId }, func: pageBanner, args: [on] }).catch(() => {});
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

async function announce(tabId, restored) {
  if (tabId === null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    send({
      qm: "attached",
      title: tab.title || "Your Chrome",
      url: tab.url || "about:blank",
      ...(restored ? { restored: true } : {}),
    });
  } catch {
    void 0;
  }
}

async function canDrive(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1", returnByValue: true });
    return true;
  } catch {
    return false;
  }
}

async function forget(tabId) {
  await chrome.storage.local.remove("attachedTabId").catch(() => {});
  await badge(tabId, false);
  await showBanner(tabId, false);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function detach() {
  const tabId = attachedTabId;
  attachedTabId = null;
  if (tabId !== null) await forget(tabId);
}

async function claim(tabId, chosen = false) {
  if (!chosen && (await isStopped())) return false;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    if (chosen) throw e;
  }
  if (!(await canDrive(tabId))) return false;
  const old = attachedTabId;
  attachedTabId = tabId;
  if (old !== null && old !== tabId) {
    previousTabId = old;
    await forget(old);
  }
  await chrome.storage.local.set({ attachedTabId: tabId });
  await chrome.storage.local.remove("pendingDetach").catch(() => {});
  await announce(tabId, !chosen);
  await badge(tabId, true);
  await showBanner(tabId, true);
  return true;
}

function settle(work) {
  const run = (pending ?? Promise.resolve()).catch(() => {}).then(() => work());
  const tracked = run.finally(() => {
    if (pending === tracked) pending = null;
  });
  tracked.catch(() => {});
  pending = tracked;
  return run;
}

async function lose(tabId) {
  if (tabId !== attachedTabId) return;
  attachedTabId = null;
  const back = previousTabId;
  previousTabId = null;
  await settle(async () => {
    await forget(tabId);
    if (attachedTabId !== null) return;
    if (back !== null && back !== tabId && (await claim(back))) return;
    send({ qm: "released" });
  });
}

async function stop() {
  await chrome.storage.local.set({ stopped: true }).catch(() => {});
  const stored = await chrome.storage.local.get("attachedTabId").catch(() => ({}));
  const tabId = attachedTabId ?? (typeof stored.attachedTabId === "number" ? stored.attachedTabId : null);
  attachedTabId = null;
  previousTabId = null;
  if (tabId !== null) await forget(tabId);
  if (!send({ qm: "detached" })) await chrome.storage.local.set({ pendingDetach: true }).catch(() => {});
}

async function restoreShare() {
  const stored = await chrome.storage.local.get("attachedTabId").catch(() => ({}));
  const saved = stored.attachedTabId;
  if (typeof saved !== "number") return;
  const forgetSaved = () => chrome.storage.local.remove("attachedTabId").catch(() => {});
  const yielded = () => attachedTabId !== null || restoreYielded;
  if (yielded()) return;
  try {
    await chrome.tabs.get(saved);
  } catch {
    return forgetSaved();
  }
  if (yielded()) return;
  if (!(await claim(saved))) return forgetSaved();
  if (restoreYielded && attachedTabId === saved) await detach();
}

async function openTab(url = "about:blank") {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const tab =
    typeof win?.id === "number"
      ? await chrome.tabs.create({ windowId: win.id, url, active: true })
      : (await chrome.windows.create({ url, focused: true })).tabs?.[0];
  if (typeof tab?.id !== "number" || !(await claim(tab.id))) throw new Error("could not open a tab to work in");
  return tab.id;
}

async function drivenTab() {
  while (pending) await pending.catch(() => {});
  if (attachedTabId !== null) return attachedTabId;
  return settle(() => openTab());
}

async function everyTab() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => typeof tab.id === "number")
    .map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
      shared: tab.id === attachedTabId,
    }));
}

async function targetInfo() {
  const tab = attachedTabId === null ? null : await chrome.tabs.get(attachedTabId).catch(() => null);
  return {
    targetId: TARGET_ID,
    type: "page",
    title: tab?.title || "New tab",
    url: tab?.url || "about:blank",
    attached: true,
    canAccessOpener: false,
  };
}

const LOCAL = {
  "Target.getTargets": async () => ({ targetInfos: [await targetInfo()] }),
  "Target.attachToTarget": async () => ({ sessionId: SESSION_ID }),
  "Target.setDiscoverTargets": async () => ({}),
  "Target.setAutoAttach": async () => ({}),
  "Target.createTarget": async (params) => {
    await openTab(params?.url || "about:blank");
    return { targetId: TARGET_ID };
  },
  "qm.listTabs": async () => ({ tabs: await everyTab() }),
  "qm.switchTab": async (params) => {
    const wanted = params?.tabId;
    if (!(await chrome.tabs.get(wanted).catch(() => null))) throw new Error("there is no open tab with that id");
    if (!(await claim(wanted))) {
      throw new Error(
        "that tab cannot be driven — Chrome's own pages, the Web Store and other extensions are off limits",
      );
    }
    const now = await chrome.tabs.get(wanted);
    return { tabId: wanted, title: now.title || "", url: now.url || "" };
  },
};

async function onCommand(frame) {
  const { id, method, params } = frame;
  try {
    if (await isStopped()) throw new Error(STOPPED_MESSAGE);
    if (Object.hasOwn(LOCAL, method)) return send({ id, result: await LOCAL[method](params) });
    if (method.startsWith("qm.")) throw new Error(`unknown control command ${method}`);
    const tabId = await drivenTab();
    const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
    send({ id, result: result ?? {} });
  } catch (e) {
    send({ id, error: { code: -32000, message: String((e && e.message) || e) } });
  }
}

function connect() {
  void (async () => {
    await ready;
    const { origin, token } = await settings().catch(() => ({ origin: "", token: "" }));
    if (!origin || !token) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const url = `${origin.replace(/^http/, "ws")}${RELAY_PATH}?t=${encodeURIComponent(token)}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      reconnectDelay = 1000;
      void (async () => {
        const pending = await chrome.storage.local.get("pendingDetach").catch(() => ({}));
        if (pending.pendingDetach) {
          send({ qm: "detached" });
          await chrome.storage.local.remove("pendingDetach").catch(() => {});
        }
        await announce(attachedTabId, true);
      })();
    };
    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof frame.id === "number" && typeof frame.method === "string") void onCommand(frame);
    };
    socket.onclose = () => {
      socket = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      setTimeout(connect, reconnectDelay);
    };
    socket.onerror = () => socket && socket.close();
  })();
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  send({ method, params: params ?? {} });
  if (method === "Page.frameNavigated") {
    void announce(attachedTabId, true);
    void showBanner(attachedTabId, true);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void (async () => {
    await ready;
    const tabId = source.tabId;
    if (tabId !== attachedTabId) return;
    if (reason === "canceled_by_user") return stop();
    if (reason !== "replaced_with_devtools" && (await claim(tabId))) return;
    await lose(tabId);
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    await ready;
    if (attachedTabId === null || tab.openerTabId !== attachedTabId) return;
    if (typeof tab.id !== "number") return;
    const from = attachedTabId;
    if (!(await claim(tab.id))) await claim(from);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await ready;
    if (tabId === previousTabId) previousTabId = null;
    await lose(tabId);
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "share-current-tab" || message.type === "stop-sharing") restoreYielded = true;
  void (async () => {
    await ready;
    if (message.type === "share-current-tab") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return respond({ ok: false, error: "no active tab" });
      try {
        if (!(await claim(tab.id, true))) throw new Error("that tab cannot be driven");
        await chrome.storage.local.remove("stopped").catch(() => {});
        connect();
        respond({ ok: true, tabId: tab.id, title: tab.title });
      } catch (e) {
        respond({ ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    if (message.type === "stop-sharing") {
      await stop();
      respond({ ok: true });
      return;
    }
    if (message.type === "save-settings") {
      await chrome.storage.local.set({ origin: message.origin, token: message.token });
      connect();
      respond({ ok: true });
      return;
    }
    if (message.type === "status") {
      const { origin, token } = await settings();
      let sharedTitle = null;
      if (attachedTabId !== null) {
        try {
          sharedTitle = (await chrome.tabs.get(attachedTabId)).title ?? null;
        } catch {
          sharedTitle = null;
        }
      }
      respond({
        origin,
        hasToken: Boolean(token),
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
        stopped: await isStopped(),
        sharedTabId: attachedTabId,
        sharedTitle,
      });
      return;
    }
    respond({ ok: false, error: "unknown message" });
  })();
  return true;
});

chrome.alarms.create("qm-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
setInterval(() => send({ qm: "ping" }), KEEPALIVE_MS);
void connect();
