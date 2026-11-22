import type { WebSocket } from "ws";

export type RelaySide = "extension" | "cdp";

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface BridgeBrowser {
  id: string;
  name: string;
  version?: string;
}

interface LiveBrowser extends BridgeBrowser {
  sharing: boolean;
  title?: string;
  url?: string;
}

interface Extension extends BridgeBrowser {
  socket: RelaySocket;
  sharing: boolean;
  title?: string;
  url?: string;
}

interface Pair {
  extensions: Map<string, Extension>;
  cdp?: RelaySocket;
  active?: string | null;
}

const LEGACY_BROWSER_ID = "legacy";
const TARGET_ID = "qm-extension-page";
const SESSION_ID = "qm-extension-session";

export interface RelayHub {
  attach(principalId: string, side: RelaySide, socket: RelaySocket, browser?: BridgeBrowser): void;
  detach(principalId: string, side: RelaySide, socket: RelaySocket): void;
  disconnect(principalId: string, reason: string): void;
  deliver(principalId: string, side: RelaySide, raw: string, socket?: RelaySocket): void;
  setActive(principalId: string, browserId: string | null | undefined): void;
  connected(principalId: string): { extension: boolean; cdp: boolean; sharing: boolean };
  describe(principalId: string): { title?: string; url?: string } | null;
  browsers(principalId: string): { active: string | null | undefined; live: LiveBrowser[] };
}

function parseFrame<T extends object>(raw: string): T | null {
  try {
    const frame: unknown = JSON.parse(raw);
    return typeof frame === "object" && frame !== null && !Array.isArray(frame) ? (frame as T) : null;
  } catch {
    return null;
  }
}

function reply(socket: RelaySocket, id: number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}

function refuse(socket: RelaySocket, id: number | undefined, message: string): void {
  if (typeof id !== "number") return;
  socket.send(JSON.stringify({ id, error: { code: -32000, message } }));
}

function handshake(target: Extension | undefined, method: string, id: number, cdp: RelaySocket): boolean {
  if (method === "Browser.close" || method === "Browser.getVersion") {
    reply(cdp, id, method === "Browser.close" ? {} : { product: "Chrome/extension", protocolVersion: "1.3" });
    return true;
  }
  if (!target?.sharing) return false;
  if (method === "Target.getTargets") {
    reply(cdp, id, {
      targetInfos: [
        {
          targetId: TARGET_ID,
          type: "page",
          title: target.title ?? "Your Chrome",
          url: target.url ?? "about:blank",
          attached: true,
          canAccessOpener: false,
        },
      ],
    });
    return true;
  }
  if (method === "Target.attachToTarget") {
    reply(cdp, id, { sessionId: SESSION_ID });
    return true;
  }
  if (method === "Target.setDiscoverTargets" || method === "Target.setAutoAttach") {
    reply(cdp, id, {});
    return true;
  }
  return false;
}

function targetOf(pair: Pair): Extension | undefined {
  if (typeof pair.active === "string") return pair.extensions.get(pair.active);
  if (pair.active === undefined && pair.extensions.size === 1) return [...pair.extensions.values()][0];
  return undefined;
}

function notConnectedReason(pair: Pair): string {
  if (pair.active === null) {
    return "no browser is active for the agent — the person turned them all off in Keychain → Linked accounts → Browser";
  }
  if (pair.extensions.size > 1) {
    const names = [...pair.extensions.values()].map((e) => e.name).join(", ");
    return `several browsers are connected (${names}) and none is chosen — the person picks one in Keychain → Linked accounts → Browser, or presses Share this tab in the one to use`;
  }
  if (pair.extensions.size > 0) {
    return "the browser chosen for the agent is not connected — it is closed, or its Browser Bridge extension is off; the person can open it or pick another in Keychain → Linked accounts → Browser";
  }
  return "your Chrome is not connected — Chrome is closed, or the Browser Bridge extension is off or not paired";
}

export interface RelayHubOptions {
  onShareChanged?(principalId: string, sharing: boolean): void;
  onActiveChanged?(principalId: string, browserId: string): void;
}

export function createRelayHub(opts: RelayHubOptions = {}): RelayHub {
  const pairs = new Map<string, Pair>();
  const pairOf = (id: string): Pair => {
    const found = pairs.get(id) ?? { extensions: new Map() };
    pairs.set(id, found);
    return found;
  };
  const prune = (principalId: string, pair: Pair): void => {
    if (!pair.extensions.size && !pair.cdp && pair.active === undefined) pairs.delete(principalId);
  };
  const tellActive = (pair: Pair): void => {
    const target = targetOf(pair);
    for (const ext of pair.extensions.values()) {
      ext.socket.send(JSON.stringify({ qm: "active", active: ext === target }));
    }
  };
  const dropAgent = (pair: Pair, reason: string): void => {
    pair.cdp?.close(1001, reason);
    delete pair.cdp;
  };
  const choose = (pair: Pair, browserId: string | null | undefined): boolean => {
    const before = targetOf(pair);
    pair.active = browserId;
    const after = targetOf(pair);
    tellActive(pair);
    if (before === after) return false;
    dropAgent(pair, "the browser the agent uses changed");
    return true;
  };
  const extensionBySocket = (pair: Pair, socket: RelaySocket | undefined): Extension | undefined => {
    for (const ext of pair.extensions.values()) if (ext.socket === socket) return ext;
    return undefined;
  };

  const detach = (principalId: string, side: RelaySide, socket: RelaySocket): void => {
    const pair = pairs.get(principalId);
    if (!pair) return;
    if (side === "cdp") {
      if (pair.cdp !== socket) return;
      delete pair.cdp;
      prune(principalId, pair);
      return;
    }
    const ext = extensionBySocket(pair, socket);
    if (!ext) return;
    const wasTarget = targetOf(pair) === ext;
    pair.extensions.delete(ext.id);
    if (wasTarget) dropAgent(pair, "the extension disconnected");
    tellActive(pair);
    prune(principalId, pair);
  };

  return {
    attach(principalId, side, socket, browser) {
      const pair = pairOf(principalId);
      if (side === "cdp") {
        pair.cdp?.close(1000, "replaced by a newer connection");
        pair.cdp = socket;
        return;
      }
      const id = browser?.id ?? LEGACY_BROWSER_ID;
      const previous = pair.extensions.get(id);
      const wasTarget = previous !== undefined && targetOf(pair) === previous;
      previous?.socket.close(1000, "replaced by a newer connection");
      pair.extensions.set(id, {
        id,
        name: browser?.name ?? "Browser",
        ...(browser?.version ? { version: browser.version } : {}),
        socket,
        sharing: false,
      });
      if (wasTarget) dropAgent(pair, "the extension reconnected");
      tellActive(pair);
    },

    detach,

    disconnect(principalId, reason) {
      const pair = pairs.get(principalId);
      if (!pair) return;
      for (const ext of pair.extensions.values()) {
        detach(principalId, "extension", ext.socket);
        ext.socket.close(1008, reason);
      }
    },

    deliver(principalId, side, raw, socket) {
      const pair = pairs.get(principalId);
      if (!pair) return;
      if (side === "cdp") {
        if (!pair.cdp) return;
        const frame = parseFrame<{ id?: number; method?: string }>(raw);
        if (!frame) return;
        if (typeof frame.id !== "number" || typeof frame.method !== "string") return;
        const target = targetOf(pair);
        if (handshake(target, frame.method, frame.id, pair.cdp)) return;
        if (!target) {
          refuse(pair.cdp, frame.id, notConnectedReason(pair));
          return;
        }
        target.socket.send(raw);
        return;
      }
      const ext = socket ? extensionBySocket(pair, socket) : targetOf(pair);
      if (!ext) return;
      const frame = parseFrame<{ qm?: unknown; title?: string; url?: string; restored?: boolean }>(raw);
      if (!frame) return;
      const isTarget = targetOf(pair) === ext;
      if (frame.qm === undefined) {
        if (isTarget) pair.cdp?.send(raw);
        return;
      }
      if (frame.qm === "attached") {
        ext.title = frame.title ?? ext.title;
        ext.url = frame.url ?? ext.url;
        ext.sharing = true;
        if (frame.restored) return;
        if (!isTarget) {
          choose(pair, ext.id);
          opts.onActiveChanged?.(principalId, ext.id);
        }
        opts.onShareChanged?.(principalId, true);
        return;
      }
      if (frame.qm === "released" || frame.qm === "detached") {
        ext.sharing = false;
        delete ext.title;
        delete ext.url;
        if (frame.qm === "detached" && isTarget) opts.onShareChanged?.(principalId, false);
      }
    },

    setActive(principalId, browserId) {
      const pair = pairOf(principalId);
      if (pair.active === browserId) return;
      choose(pair, browserId);
      prune(principalId, pair);
    },

    connected(principalId) {
      const pair = pairs.get(principalId);
      const target = pair ? targetOf(pair) : undefined;
      return {
        extension: Boolean(target),
        cdp: Boolean(pair?.cdp),
        sharing: Boolean(target?.sharing),
      };
    },

    describe(principalId) {
      const pair = pairs.get(principalId);
      const target = pair ? targetOf(pair) : undefined;
      if (!target?.sharing) return null;
      return { ...(target.title ? { title: target.title } : {}), ...(target.url ? { url: target.url } : {}) };
    },

    browsers(principalId) {
      const pair = pairs.get(principalId);
      if (!pair) return { active: undefined, live: [] };
      return {
        active: pair.active,
        live: [...pair.extensions.values()].map((ext) => ({
          id: ext.id,
          name: ext.name,
          ...(ext.version ? { version: ext.version } : {}),
          sharing: ext.sharing,
          ...(ext.title ? { title: ext.title } : {}),
          ...(ext.url ? { url: ext.url } : {}),
        })),
      };
    },
  };
}

export function relaySocket(ws: WebSocket): RelaySocket {
  return {
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: (code, reason) => ws.close(code ?? 1000, reason ?? ""),
  };
}
