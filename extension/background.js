const RELAY_PATH = "/v1/browser-relay/extension";
const PROTOCOL_VERSION = "1.3";
const TARGET_ID = "qm-extension-page";
const SESSION_ID = "qm-extension-session";
const KEEPALIVE_MS = 20_000;
const DRIVE_CHECK_MS = 2_000;
const BLANK = "data:text/html,%3Ctitle%3EQM%3C%2Ftitle%3E";
const ALLOWED = new Set([
  "Page.enable",
  "Page.navigate",
  "Page.captureScreenshot",
  "Page.handleJavaScriptDialog",
  "Runtime.evaluate",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Network.enable",
  "Network.getCookies",
  "Network.getResponseBody",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Fetch.failRequest",
  "Fetch.takeResponseBodyAsStream",
  "IO.read",
  "IO.close",
]);
const FORWARDED = new Set([
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.frameNavigated",
  "Page.javascriptDialogOpening",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Fetch.requestPaused",
]);
const STOPPED_MESSAGE =
  "they stopped QM using their Chrome — it stays off until they press Share this tab in the Browser Bridge extension";
const OFF_LIMITS_MESSAGE =
  "that tab cannot be driven — only web pages are; Chrome's own pages, extensions and local files stay off limits";
const FOREIGN_FRAME_MESSAGE =
  "Chrome will not let the Browser Bridge control that tab because another extension has put its own frame into the page — usually a password manager's autofill menu (Bitwarden, 1Password) or Chrome's PDF viewer";

const FOREIGN_FRAME = /chrome-extension:\/\/ URL of different extension/i;

function refusalOf(error) {
  const reason = String((error && error.message) || error || "");
  if (FOREIGN_FRAME.test(reason)) return FOREIGN_FRAME_MESSAGE;
  return reason ? `${OFF_LIMITS_MESSAGE} (Chrome said: ${reason})` : OFF_LIMITS_MESSAGE;
}

let socket = null;
let attachedTabId = null;
let lastRefusal = null;
const enabledDomains = new Map();
let previousTabId = null;
let stopped = false;
let ownOrigins = [];
const seenRequests = new Set();
const issuedStreams = new Set();
const openedBy = new Map();
const EVALUATE_PARAMS = new Set(["expression", "returnByValue", "awaitPromise", "timeout"]);
const KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);
const BUTTONS = new Set(["left", "none"]);
const BOUND_TO_REQUEST = new Set([
  "Network.getResponseBody",
  "Fetch.takeResponseBodyAsStream",
  "Fetch.continueRequest",
  "Fetch.failRequest",
]);
const READS_THE_PAGE = new Set([
  "Runtime.evaluate",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.captureScreenshot",
  "Network.getCookies",
]);
let pending = null;
let reconnectDelay = 1000;
let activeHere = null;

let identity = null;

function browserIdentity() {
  identity ??= readIdentity().finally(() => {
    identity = null;
  });
  return identity;
}

async function readIdentity() {
  const stored = await chrome.storage.local.get("browserId").catch(() => ({}));
  let id = typeof stored.browserId === "string" ? stored.browserId : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ browserId: id }).catch(() => {});
  }
  const brands = (navigator.userAgentData?.brands ?? [])
    .map((b) => b.brand)
    .filter((brand) => !/not.?a.?brand|chromium/i.test(brand));
  const platform = navigator.userAgentData?.platform;
  const name = `${brands[0] ?? "Chromium browser"}${platform ? ` · ${platform}` : ""}`;
  return { id, name, version: chrome.runtime.getManifest().version };
}
let settingsEpoch = 0;
let restoreYielded = false;
const ready = (async () => {
  await bootstrapFromConfig().catch(() => {});
  await loadOwnOrigins();
  await loadStopped();
  await Promise.race([restoreShare(), new Promise((resolve) => setTimeout(resolve, 5000))]);
})().catch(() => {});

async function settings() {
  const { origin, token, app } = await chrome.storage.local.get(["origin", "token", "app"]);
  return { origin: origin || "", token: token || "", app: app || "" };
}

async function bootstrapFromConfig() {
  const { origin, app } = await settings();
  if (origin && app) return;
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"));
    const cfg = await res.json();
    const next = {};
    if (!origin && cfg.origin) next.origin = cfg.origin;
    if (!origin && cfg.token) next.token = cfg.token;
    if (!app && cfg.app) next.app = cfg.app;
    if (Object.keys(next).length) await chrome.storage.local.set(next);
  } catch {
    void 0;
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function learnApp(app) {
  const origin = originOf(app);
  if (!origin || origin === "null" || ownOrigins.includes(origin)) return;
  ownOrigins = [...ownOrigins, origin];
  const stored = await chrome.storage.local.get("apps").catch(() => ({}));
  const apps = Array.isArray(stored.apps) ? stored.apps : [];
  await chrome.storage.local.set({ apps: [...new Set([...apps, origin])].slice(-8) }).catch(() => {});
}

async function loadOwnOrigins() {
  const { origin, app } = await settings().catch(() => ({ origin: "", app: "" }));
  const stored = await chrome.storage.local.get("apps").catch(() => ({}));
  const apps = Array.isArray(stored.apps) ? stored.apps : [];
  ownOrigins = [...new Set([origin, app, ...apps].map(originOf).filter((o) => o && o !== "null"))];
}

function remember(set, value) {
  set.add(value);
  if (set.size > 4000) set.delete(set.values().next().value);
}

async function framesOffLimits(tabId) {
  const tree = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree").catch(() => null);
  const pending = tree?.frameTree ? [tree.frameTree] : [];
  while (pending.length) {
    const node = pending.pop();
    const origin = node.frame?.securityOrigin || originOf(node.frame?.url ?? "");
    if (ownOrigins.includes(origin) || ownOrigins.includes(originOf(node.frame?.url ?? ""))) return true;
    pending.push(...(node.childFrames ?? []));
  }
  return false;
}

async function loadStopped() {
  const stored = await chrome.storage.local.get("stopped").catch(() => ({}));
  if (stored.stopped === true) stopped = true;
}

async function isStopped() {
  if (stopped) return true;
  const stored = await chrome.storage.local.get("stopped").catch(() => ({ stopped: true }));
  return stored.stopped === true;
}

function drivable(url) {
  return /^(https?:|data:|blob:https?:|about:blank)/i.test(url) && !ownOrigins.includes(originOf(url));
}

function webOrigin(origin) {
  return origin === "null" || /^https?:\/\//.test(origin);
}

async function tabUrl(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab ? tab.pendingUrl || tab.url || "about:blank" : null;
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
  await chrome.scripting
    .executeScript({ target: { tabId }, world: "MAIN", func: pageBanner, args: [on] })
    .catch(() => {});
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
  let timer;
  const probe = chrome.debugger
    .sendCommand({ tabId }, "Runtime.evaluate", { expression: "location.origin", returnByValue: true })
    .then(
      (r) => {
        const origin = r?.result?.value;
        return typeof origin !== "string" || (webOrigin(origin) && !ownOrigins.includes(origin));
      },
      () => false,
    );
  const busy = new Promise((resolve) => {
    timer = setTimeout(() => resolve("busy"), DRIVE_CHECK_MS);
  });
  return Promise.race([probe, busy]).finally(() => clearTimeout(timer));
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("the page did not respond")), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function removeForeignFrames() {
  const own = chrome.runtime.getURL("");
  let removed = 0;
  const visit = (node) => {
    for (const child of Array.from(node.children)) {
      if (child.tagName === "IFRAME" && /^chrome-extension:\/\//i.test(child.src || "") && !child.src.startsWith(own)) {
        child.remove();
        removed += 1;
        continue;
      }
      const root = chrome.dom?.openOrClosedShadowRoot?.(child);
      if (root) visit(root);
      visit(child);
    }
  };
  visit(document);
  return removed;
}

function clearForeignFrames(tabId) {
  return withTimeout(
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: removeForeignFrames }),
    DRIVE_CHECK_MS,
  ).catch(() => {});
}

async function attachTo(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    if (!FOREIGN_FRAME.test(String((e && e.message) || e))) throw e;
    await clearForeignFrames(tabId);
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  }
}

function settle(work) {
  const run = (pending ?? Promise.resolve()).then(work);
  const tracked = run
    .catch(() => {})
    .finally(() => {
      if (pending === tracked) pending = null;
    });
  pending = tracked;
  return run;
}

async function forget(tabId) {
  enabledDomains.clear();
  await chrome.storage.local.remove("attachedTabId").catch(() => {});
  if ((await tabUrl(tabId)) === BLANK) await chrome.tabs.remove(tabId).catch(() => {});
  await badge(tabId, false);
  void showBanner(tabId, false);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function claim(tabId, chosen = false) {
  lastRefusal = null;
  if (!chosen && (await isStopped())) return false;
  const url = await tabUrl(tabId);
  if (url === null || !drivable(url)) {
    if (chosen) throw new Error(OFF_LIMITS_MESSAGE);
    return false;
  }
  let attachError = null;
  let attachedHere = false;
  if (tabId !== attachedTabId) {
    try {
      await attachTo(tabId);
      attachedHere = true;
    } catch (e) {
      attachError = e;
    }
  }
  const probe = await canDrive(tabId);
  if (probe === false || (probe === "busy" && /^about:/i.test(url)) || (!chosen && stopped)) {
    if (attachedHere && tabId !== attachedTabId) await chrome.debugger.detach({ tabId }).catch(() => {});
    if (attachError) lastRefusal = refusalOf(attachError);
    if (chosen && attachError) throw new Error(lastRefusal);
    return false;
  }
  const old = attachedTabId;
  attachedTabId = tabId;
  if (old !== null && old !== tabId) {
    previousTabId = old;
    await forget(old);
  }
  await chrome.storage.local.set({ attachedTabId: tabId, previousTabId }).catch(() => {});
  if (chosen) await chrome.storage.local.remove("pendingDetach").catch(() => {});
  await announce(tabId, !chosen);
  await badge(tabId, true);
  void showBanner(tabId, true);
  return true;
}

async function fallBack(lost) {
  const back = previousTabId;
  previousTabId = null;
  await forget(lost);
  if (back !== null && back !== lost && (await claim(back))) return;
  send({ qm: "released" });
}

function lose(tabId) {
  return settle(async () => {
    if (tabId === previousTabId) previousTabId = null;
    if (tabId !== attachedTabId) return;
    attachedTabId = null;
    await fallBack(tabId);
  });
}

function release() {
  return settle(async () => {
    const tabId = attachedTabId;
    attachedTabId = null;
    previousTabId = null;
    if (tabId === null) return;
    await forget(tabId);
    send({ qm: "released" });
  });
}

async function stop() {
  stopped = true;
  await chrome.storage.local.set({ stopped: true }).catch(() => {});
  await settle(async () => {
    stopped = true;
    await chrome.storage.local.set({ stopped: true }).catch(() => {});
    const stored = await chrome.storage.local.get("attachedTabId").catch(() => ({}));
    const tabId = attachedTabId ?? (typeof stored.attachedTabId === "number" ? stored.attachedTabId : null);
    attachedTabId = null;
    previousTabId = null;
    if (tabId !== null) await forget(tabId);
    if (!send({ qm: "detached" })) await chrome.storage.local.set({ pendingDetach: true }).catch(() => {});
  });
}

async function restoreShare() {
  const stored = await chrome.storage.local.get(["attachedTabId", "previousTabId"]).catch(() => ({}));
  const saved = stored.attachedTabId;
  if (typeof saved !== "number") return;
  const forgetSaved = () => chrome.storage.local.remove("attachedTabId").catch(() => {});
  await settle(async () => {
    if (attachedTabId !== null || restoreYielded) return;
    if (!(await chrome.tabs.get(saved).catch(() => null))) return forgetSaved();
    if (restoreYielded) return;
    if (typeof stored.previousTabId === "number") previousTabId = stored.previousTabId;
    if (!(await claim(saved))) return forgetSaved();
    if (restoreYielded && attachedTabId === saved) {
      attachedTabId = null;
      await forget(saved);
    }
  });
}

async function openTab(url) {
  if (!drivable(url)) throw new Error(OFF_LIMITS_MESSAGE);
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const tab =
    typeof win?.id === "number"
      ? await chrome.tabs.create({ windowId: win.id, url, active: true })
      : (await chrome.windows.create({ url, focused: true })).tabs?.[0];
  if (typeof tab?.id !== "number") throw new Error("could not open a tab to work in");
  if (await claim(tab.id)) return tab.id;
  await chrome.tabs.remove(tab.id).catch(() => {});
  throw new Error(stopped ? STOPPED_MESSAGE : (lastRefusal ?? "could not open a tab to work in"));
}

async function drivenTab() {
  while (pending) await pending;
  if (attachedTabId !== null) return attachedTabId;
  return settle(async () => {
    if (attachedTabId !== null) return attachedTabId;
    const spare = (await chrome.tabs.query({}).catch(() => [])).find((tab) => tab.url === BLANK && !tab.pendingUrl);
    if (spare && (await claim(spare.id))) return spare.id;
    return openTab(BLANK);
  });
}

async function everyTab() {
  const [tabs, front] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null),
  ]);
  return tabs
    .filter((tab) => typeof tab.id === "number" && drivable(tab.pendingUrl || tab.url || "about:blank"))
    .map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      openerTabId: openedBy.get(tab.id) ?? null,
      title: tab.title || "",
      url: tab.url || "",
      active: Boolean(tab.active),
      front: Boolean(tab.active && tab.windowId === front?.id),
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
    const url = params?.url && params.url !== "about:blank" ? params.url : BLANK;
    await settle(() => openTab(url));
    return { targetId: TARGET_ID };
  },
  "qm.listTabs": async () => ({ tabs: await everyTab() }),
  "qm.switchTab": async (params) => {
    const wanted = params?.tabId;
    const moved = await settle(async () => {
      if (!(await chrome.tabs.get(wanted).catch(() => null))) throw new Error("there is no open tab with that id");
      return claim(wanted);
    });
    if (!moved) throw new Error(stopped ? STOPPED_MESSAGE : (lastRefusal ?? OFF_LIMITS_MESSAGE));
    const now = await chrome.tabs.get(wanted);
    return { tabId: wanted, title: now.title || "", url: now.url || "" };
  },
  "qm.release": async () => {
    await release();
    return {};
  },
  "qm.insertText": async (params) =>
    settle(async () => {
      const tabId = attachedTabId;
      const want = originOf(String(params?.origin ?? ""));
      const refuse = new Error(`refusing to type: the tab in use is not on ${params?.origin}`);
      if (tabId === null || !want) throw refuse;
      const here = await tabUrl(tabId);
      const tree = await withTimeout(chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree"), DRIVE_CHECK_MS);
      const top = tree?.frameTree?.frame;
      if (originOf(here ?? "") !== want || top?.securityOrigin !== want) throw refuse;
      const world = await withTimeout(
        chrome.debugger.sendCommand({ tabId }, "Page.createIsolatedWorld", {
          frameId: top.id,
          worldName: "qm-fill-check",
        }),
        DRIVE_CHECK_MS,
      );
      const probe = await withTimeout(
        chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "document.activeElement ? document.activeElement.tagName : ''",
          contextId: world?.executionContextId,
          returnByValue: true,
        }),
        DRIVE_CHECK_MS,
      );
      if (/^(IFRAME|FRAME|OBJECT|EMBED)$/i.test(String(probe?.result?.value ?? ""))) throw refuse;
      if (stopped) throw new Error(STOPPED_MESSAGE);
      await withTimeout(
        chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: String(params?.text ?? "") }),
        DRIVE_CHECK_MS,
      );
      return {};
    }),
};

async function onCommand(frame) {
  const { id, method, params } = frame;
  try {
    if (await isStopped()) throw new Error(STOPPED_MESSAGE);
    if (Object.hasOwn(LOCAL, method)) return send({ id, result: await LOCAL[method](params) });
    if (!ALLOWED.has(method)) throw new Error(`${method} is not available through the Browser Bridge`);
    if (method === "Page.navigate" && !drivable(String(params?.url ?? ""))) throw new Error(OFF_LIMITS_MESSAGE);
    if (method === "Network.getCookies" && (params?.urls ?? []).some((u) => !drivable(String(u)))) {
      throw new Error(OFF_LIMITS_MESSAGE);
    }
    if (method === "Fetch.continueRequest" && Object.keys(params ?? {}).some((k) => k !== "requestId")) {
      throw new Error("Fetch.continueRequest can only let a request through unchanged");
    }
    if (method === "Runtime.evaluate" && Object.keys(params ?? {}).some((k) => !EVALUATE_PARAMS.has(k))) {
      throw new Error("Runtime.evaluate runs only in the page itself");
    }
    if (
      method === "Input.dispatchKeyEvent" &&
      (params?.commands || Number(params?.modifiers) || !KEYS.has(String(params?.key)))
    ) {
      throw new Error(
        "only plain navigation keys are available through the Browser Bridge — type text with insertText",
      );
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      (Number(params?.modifiers) || !BUTTONS.has(String(params?.button ?? "none")))
    ) {
      throw new Error("only plain left clicks and scrolling are available through the Browser Bridge");
    }
    if (BOUND_TO_REQUEST.has(method) && !seenRequests.has(String(params?.requestId))) {
      throw new Error("that request is not one this tab showed you");
    }
    if (method.startsWith("IO.") && !issuedStreams.has(String(params?.handle))) {
      throw new Error("that stream is not one this tab gave you");
    }
    const tabId = await drivenTab();
    const url = await tabUrl(tabId);
    if (url !== null && !drivable(url)) {
      await lose(tabId);
      throw new Error(OFF_LIMITS_MESSAGE);
    }
    if (READS_THE_PAGE.has(method) && (await framesOffLimits(tabId))) {
      throw new Error("this page has QM itself open inside it, so the Browser Bridge will not act on it");
    }
    if (stopped) throw new Error(STOPPED_MESSAGE);
    const sent = method === "Network.getCookies" && !params?.urls?.length ? { ...params, urls: [url] } : params || {};
    const result = await sendToDriven(tabId, method, sent);
    if (method.endsWith(".enable")) enabledDomains.set(method, sent);
    if (method === "Fetch.disable") enabledDomains.delete("Fetch.enable");
    if (BOUND_TO_REQUEST.has(method) && !seenRequests.has(String(params?.requestId))) {
      throw new Error("that request is not one this tab showed you");
    }
    if (method === "Fetch.takeResponseBodyAsStream" && result?.stream) remember(issuedStreams, String(result.stream));
    if (method === "Network.getCookies" && Array.isArray(result?.cookies)) {
      result.cookies = result.cookies.filter((cookie) => !reachesOwnOrigin(cookie));
    }
    send({ id, result: result ?? {} });
  } catch (e) {
    send({ id, error: { code: -32000, message: String((e && e.message) || e) } });
  }
}

function connect() {
  void (async () => {
    await ready;
    const epoch = settingsEpoch;
    const { origin, token } = await settings().catch(() => ({ origin: "", token: "" }));
    if (epoch !== settingsEpoch || !origin || !token) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const me = await browserIdentity();
    if (epoch !== settingsEpoch) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const query = new URLSearchParams({ t: token, browser: me.id, name: me.name, v: me.version });
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}${RELAY_PATH}?${query}`);
    socket = ws;

    ws.onopen = () => {
      reconnectDelay = 1000;
      void (async () => {
        const stored = await chrome.storage.local.get("pendingDetach").catch(() => ({}));
        if (stored.pendingDetach) {
          send({ qm: "detached" });
          await chrome.storage.local.remove("pendingDetach").catch(() => {});
        }
        await announce(attachedTabId, true);
      })();
    };
    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame?.qm === "origins" && frame.id === undefined && typeof frame.app === "string") {
        void learnApp(frame.app);
        return;
      }
      if (frame?.qm === "active" && frame.id === undefined && typeof frame.active === "boolean") {
        if (socket === ws) activeHere = frame.active;
        return;
      }
      if (frame?.qm === "token" && frame.id === undefined && typeof frame.token === "string" && frame.token) {
        if (socket === ws && ws.readyState === WebSocket.OPEN) {
          void chrome.storage.local.set({ token: frame.token }).catch(() => {});
        }
        return;
      }
      if (typeof frame?.id === "number" && typeof frame.method === "string") void onCommand(frame);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      activeHere = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      setTimeout(connect, reconnectDelay);
    };
    ws.onerror = () => ws.close();
  })();
}

async function reattach(tabId) {
  await settle(async () => {
    if (attachedTabId !== tabId) return;
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await clearForeignFrames(tabId);
    await attachTo(tabId);
    for (const [method, params] of [...enabledDomains]) {
      await chrome.debugger.sendCommand({ tabId }, method, params).catch(() => {});
    }
  });
}

async function sendToDriven(tabId, method, params) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const reason = String((e && e.message) || e);
    if (!/not attached|URL of different extension/i.test(reason)) throw e;
    if (FOREIGN_FRAME.test(reason)) await reattach(tabId).catch(() => {});
    else await new Promise((resolve) => setTimeout(resolve, 300));
    while (pending) await pending;
    if (attachedTabId !== tabId) throw e;
    if (READS_THE_PAGE.has(method) && (await framesOffLimits(tabId))) {
      throw new Error("this page has QM itself open inside it, so the Browser Bridge will not act on it", { cause: e });
    }
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
}

function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function reachesOwnOrigin(cookie) {
  const raw = String(cookie?.domain ?? "").toLowerCase();
  const domain = raw.replace(/^\./, "");
  const shared = raw.startsWith(".");
  return (
    Boolean(domain) &&
    ownOrigins.map(hostOf).some((host) => host && (host === domain || (shared && host.endsWith(`.${domain}`))))
  );
}

function forwardable(method, params) {
  if (!FORWARDED.has(method)) return false;
  const url = params?.request?.url ?? params?.response?.url ?? params?.frame?.url ?? params?.url;
  const id = params?.requestId === undefined ? null : String(params.requestId);
  if (typeof url === "string") {
    const fromOwn = ownOrigins.includes(originOf(String(params?.redirectResponse?.url ?? "")));
    if (ownOrigins.includes(originOf(url)) || fromOwn) {
      if (id !== null) seenRequests.delete(id);
      return false;
    }
    if (id !== null) remember(seenRequests, id);
    return true;
  }
  return id === null || seenRequests.has(id);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (stopped || source.tabId !== attachedTabId) return;
  if (forwardable(method, params)) send({ method, params: params ?? {} });
  if (method === "Page.frameNavigated") {
    void announce(attachedTabId, true);
    void showBanner(attachedTabId, true);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void (async () => {
    await ready;
    if (reason === "canceled_by_user") return stop();
    const tabId = source.tabId;
    await settle(async () => {
      if (tabId !== attachedTabId) return;
      attachedTabId = null;
      if (reason !== "replaced_with_devtools" && (await claim(tabId))) {
        for (const [method, params] of [...enabledDomains]) {
          await chrome.debugger.sendCommand({ tabId }, method, params).catch(() => {});
        }
        return;
      }
      await fallBack(tabId);
    });
  })();
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  openedBy.set(tabId, sourceTabId);
  const opened = chrome.tabs.get(tabId).catch(() => null);
  void (async () => {
    await ready;
    await settle(async () => {
      if (attachedTabId === null || sourceTabId !== attachedTabId) return;
      if (!(await opened)?.active) return;
      await claim(tabId);
    });
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  openedBy.delete(tabId);
  void (async () => {
    await ready;
    await lose(tabId);
  })();
});

function fromThisExtension(sender) {
  return sender?.id === chrome.runtime.id && String(sender.url ?? "").startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!fromThisExtension(sender)) return false;
  if (message.type === "share-current-tab" || message.type === "stop-sharing") restoreYielded = true;
  void (async () => {
    await ready;
    if (message.type === "share-current-tab") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return respond({ ok: false, error: "no active tab" });
      try {
        const shared = await settle(async () => {
          if (!(await claim(tab.id, true))) return false;
          stopped = false;
          await chrome.storage.local.remove("stopped").catch(() => {});
          return true;
        });
        if (!shared) throw new Error("that tab cannot be driven");
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
      const before = await settings().catch(() => ({ origin: "", token: "" }));
      const moved = originOf(before.origin) !== originOf(message.origin);
      const token = message.token || (moved ? "" : before.token);
      if (moved || token !== before.token) {
        settingsEpoch += 1;
        socket?.close();
      }
      await chrome.storage.local.set({ origin: message.origin, token });
      if (moved) await chrome.storage.local.remove(["app", "apps"]).catch(() => {});
      await loadOwnOrigins();
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
        activeHere,
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
