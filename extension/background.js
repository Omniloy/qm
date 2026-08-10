/**
 * QM Browser Bridge — the extension half of the relay.
 *
 * Chrome refuses `--remote-debugging-port` on a real profile on purpose, so
 * this is the only way an agent can work in the browser where someone is
 * actually signed in. It attaches Chrome's debugger to ONE tab the person
 * nominates and relays the protocol to QM. It is deliberately not a
 * whole-browser bridge: the tab is the boundary, and everything outside it
 * stays out of reach.
 */

const RELAY_PATH = "/v1/browser-relay/extension";
const PROTOCOL_VERSION = "1.3";

let socket = null;
let attachedTabId = null;
let reconnectDelay = 1000;

async function settings() {
  const { origin, token } = await chrome.storage.local.get(["origin", "token"]);
  return { origin: origin || "", token: token || "" };
}

async function setBadge(text, colour) {
  await chrome.action.setBadgeText({ text });
  if (colour) await chrome.action.setBadgeBackgroundColor({ color: colour });
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

/** Tell QM which tab this is, so the agent's page list names something real. */
async function announce() {
  if (attachedTabId === null) return;
  try {
    const tab = await chrome.tabs.get(attachedTabId);
    send({ qm: "attached", title: tab.title || "Your Chrome", url: tab.url || "about:blank" });
  } catch {
    // The tab went away between attaching and announcing; detach handles it.
  }
}

async function attach(tabId) {
  await detach();
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attachedTabId = tabId;
  await chrome.storage.local.set({ attachedTabId: tabId });
  await setBadge("ON", "#1f9254");
  await announce();
}

async function detach() {
  if (attachedTabId === null) return;
  const tabId = attachedTabId;
  attachedTabId = null;
  await chrome.storage.local.remove("attachedTabId");
  await setBadge("", null);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already gone — the tab closed, or DevTools took the session.
  }
}

/**
 * Commands arrive addressed to a session that only exists in the relay, so the
 * sessionId is stripped before Chrome sees it. Errors are returned rather than
 * thrown: a CDP client waits for a reply to every id it sends, and a swallowed
 * failure is a turn that hangs until its wall clock rather than one that says
 * what went wrong.
 */
async function onCommand(frame) {
  const { id, method, params } = frame;
  if (attachedTabId === null) {
    return send({ id, error: { code: -32000, message: "no tab is shared — click the QM extension and pick one" } });
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
    const { origin, token } = await settings();
    if (!origin || !token) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const url = `${origin.replace(/^http/, "ws")}${RELAY_PATH}?t=${encodeURIComponent(token)}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      reconnectDelay = 1000;
      void announce();
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
  if (method === "Page.frameNavigated") void announce();
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) void detach();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) void detach();
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  void (async () => {
    if (message.type === "share-current-tab") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return respond({ ok: false, error: "no active tab" });
      try {
        await attach(tab.id);
        connect();
        respond({ ok: true, tabId: tab.id, title: tab.title });
      } catch (e) {
        respond({ ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    if (message.type === "stop-sharing") {
      await detach();
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
      const { origin } = await settings();
      respond({
        origin,
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
        sharedTabId: attachedTabId,
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
connect();
