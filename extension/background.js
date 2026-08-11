/**
 * MiniOmni Browser Bridge — the extension half of the relay.
 *
 * Chrome refuses `--remote-debugging-port` on a real profile on purpose, so
 * this is the only way an agent can work in the browser where someone is
 * actually signed in. It attaches Chrome's debugger to ONE tab the person
 * nominates and relays the protocol to MiniOmni. It is deliberately not a
 * whole-browser bridge: one tab at a time, within the window that tab is in,
 * and the rest of Chrome stays out of reach.
 */

const RELAY_PATH = "/v1/browser-relay/extension";
const PROTOCOL_VERSION = "1.3";

let socket = null;
let attachedTabId = null;
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

/**
 * The download is built for this person on this MiniOmni, so it can carry both the
 * address and a pairing token. Load them once, the first time, so a fresh
 * install connects with nothing to paste.
 */
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
    // No baked config (e.g. a hand-assembled folder); the popup still works.
  }
}

async function badge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? "●" : "" });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f9254" });
  } catch {
    // The tab may have closed; nothing to mark.
  }
}

/**
 * A banner on the page itself, so the shared tab is obvious from the tab and
 * not only from the toolbar. It is inert — no pointer events, its own marker —
 * so it never becomes something the agent reads or clicks by mistake.
 */
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
  el.textContent = "● MiniOmni is using this tab";
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
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageBanner, args: [on] });
  } catch {
    // Some pages (chrome://, the Web Store) refuse injection; the badge and
    // native debugger bar still signal the shared tab.
  }
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

/** Tell MiniOmni which tab this is, so the agent's page list names something real. */
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
    // The tab went away between attaching and announcing; detach handles it.
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

async function claim(tabId, restored) {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    if (!restored) throw e;
  }
  if (!(await canDrive(tabId))) return false;
  if (attachedTabId !== null && attachedTabId !== tabId) await detach();
  attachedTabId = tabId;
  await chrome.storage.local.set({ attachedTabId: tabId });
  await chrome.storage.local.remove("pendingDetach").catch(() => {});
  await announce(tabId, restored);
  await badge(tabId, true);
  await showBanner(tabId, true);
  return true;
}

async function detach(explicit = false) {
  const stored = await chrome.storage.local.get("attachedTabId").catch(() => ({}));
  const tabId = attachedTabId ?? (typeof stored.attachedTabId === "number" ? stored.attachedTabId : null);
  if (tabId === null) return;
  // Tell MiniOmni only when the person meant it. A closing socket is a sleeping
  // service worker, and reverting their browser choice on that would undo it
  // every time Chrome idled this extension.
  if (explicit && !send({ qm: "detached" })) {
    await chrome.storage.local.set({ pendingDetach: true }).catch(() => {});
  }
  attachedTabId = null;
  await chrome.storage.local.remove("attachedTabId");
  await badge(tabId, false);
  await showBanner(tabId, false);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already gone — the tab closed, or DevTools took the session.
  }
}

async function restoreShare() {
  const stored = await chrome.storage.local.get("attachedTabId").catch(() => ({}));
  const saved = stored.attachedTabId;
  if (typeof saved !== "number") return;
  const forget = () => chrome.storage.local.remove("attachedTabId").catch(() => {});
  const yielded = () => attachedTabId !== null || restoreYielded;
  if (yielded()) return;
  try {
    await chrome.tabs.get(saved);
  } catch {
    return forget();
  }
  if (yielded()) return;
  if (!(await claim(saved, true))) return forget();
  if (restoreYielded && attachedTabId === saved) await detach();
}

/**
 * Commands arrive addressed to a session that only exists in the relay, so the
 * sessionId is stripped before Chrome sees it. Errors are returned rather than
 * thrown: a CDP client waits for a reply to every id it sends, and a swallowed
 * failure is a turn that hangs until its wall clock rather than one that says
 * what went wrong.
 */
/**
 *
 */
async function windowTabs() {
  if (attachedTabId === null) return [];
  const current = await chrome.tabs.get(attachedTabId).catch(() => null);
  if (!current) return [];
  const tabs = await chrome.tabs.query({ windowId: current.windowId });
  return tabs
    .filter((tab) => typeof tab.id === "number")
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
      shared: tab.id === attachedTabId,
    }));
}

async function onQmCommand(id, method, params) {
  if (method === "qm.listTabs") {
    return send({ id, result: { tabs: await windowTabs() } });
  }
  if (method === "qm.switchTab") {
    const wanted = params?.tabId;
    const allowed = await windowTabs();
    if (!allowed.some((tab) => tab.tabId === wanted)) {
      return send({
        id,
        error: { code: -32000, message: "that tab is not in the window you are sharing from" },
      });
    }
    try {
      if (!(await claim(wanted, false))) throw new Error("that tab cannot be driven");
      const now = await chrome.tabs.get(wanted);
      return send({ id, result: { tabId: wanted, title: now.title || "", url: now.url || "" } });
    } catch (e) {
      return send({ id, error: { code: -32000, message: String((e && e.message) || e) } });
    }
  }
  return send({ id, error: { code: -32000, message: `unknown control command ${method}` } });
}

async function onCommand(frame) {
  const { id, method, params } = frame;
  if (typeof method === "string" && method.startsWith("qm.") && attachedTabId !== null) {
    return onQmCommand(id, method, params);
  }
  if (attachedTabId === null) {
    return send({
      id,
      error: { code: -32000, message: "no tab is shared — click the MiniOmni extension and pick one" },
    });
  }
  try {
    const result = await chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params || {});
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
      // Chrome stops a service worker when it goes quiet, so losing this is
      // ordinary rather than exceptional. Back off, but keep coming back.
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      setTimeout(connect, reconnectDelay);
    };
    socket.onerror = () => socket && socket.close();
  })();
}

// Page events travel the other way: the client subscribed to them and is
// waiting. Without this, `Page.loadEventFired` never arrives and navigation
// looks like it hung.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  send({ method, params: params ?? {} });
  // The agent navigating the tab replaces the page, so re-announce the new one
  // and re-paint the banner it just wiped out.
  if (method === "Page.frameNavigated") {
    void announce(attachedTabId, true);
    void showBanner(attachedTabId, true);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void (async () => {
    await ready;
    if (source.tabId !== attachedTabId) return;
    if (reason === "canceled_by_user" || reason === "replaced_with_devtools") {
      await detach(true);
      return;
    }
    if (await claim(attachedTabId, true)) return;
    await detach(true);
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    await ready;
    if (attachedTabId === null || tab.openerTabId !== attachedTabId) return;
    if (typeof tab.id !== "number") return;
    const from = attachedTabId;
    if (!(await claim(tab.id, true))) await claim(from, true);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // The shared tab is gone, so the share is over in the same sense as pressing
  // stop — there is nothing left to drive.
  void (async () => {
    await ready;
    if (tabId === attachedTabId) await detach(true);
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
        if (!(await claim(tab.id, false))) throw new Error("that tab cannot be driven");
        connect();
        respond({ ok: true, tabId: tab.id, title: tab.title });
      } catch (e) {
        respond({ ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    if (message.type === "stop-sharing") {
      await detach(true);
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
        sharedTabId: attachedTabId,
        sharedTitle,
      });
      return;
    }
    respond({ ok: false, error: "unknown message" });
  })();
  return true;
});

// A dormant service worker cannot hold the socket open, and the alarm is what
// wakes it to reconnect after Chrome has stopped it.
chrome.alarms.create("qm-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
void connect();
