import type { WebSocket } from "ws";

export type RelaySide = "extension" | "cdp";

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Pair {
  extension?: RelaySocket;
  cdp?: RelaySocket;
  title?: string;
  url?: string;
  sharing?: boolean;
}

const TARGET_ID = "qm-extension-page";
const SESSION_ID = "qm-extension-session";

export interface RelayHub {
  attach(principalId: string, side: RelaySide, socket: RelaySocket): void;
  detach(principalId: string, side: RelaySide): void;
  deliver(principalId: string, side: RelaySide, raw: string): void;
  connected(principalId: string): { extension: boolean; cdp: boolean; sharing: boolean };
  describe(principalId: string): { title?: string; url?: string } | null;
}

function reply(socket: RelaySocket, id: number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}

function refuse(socket: RelaySocket, id: number | undefined, message: string): void {
  if (typeof id !== "number") return;
  socket.send(JSON.stringify({ id, error: { code: -32000, message } }));
}

function handshake(pair: Pair, method: string, id: number, cdp: RelaySocket): boolean {
  if (method === "Browser.close" || method === "Browser.getVersion") {
    reply(cdp, id, method === "Browser.close" ? {} : { product: "Chrome/extension", protocolVersion: "1.3" });
    return true;
  }
  if (!pair.sharing) return false;
  if (method === "Target.getTargets") {
    reply(cdp, id, {
      targetInfos: [
        {
          targetId: TARGET_ID,
          type: "page",
          title: pair.title ?? "Your Chrome",
          url: pair.url ?? "about:blank",
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

export interface RelayHubOptions {
  onShareChanged?(principalId: string, sharing: boolean): void;
}

export function createRelayHub(opts: RelayHubOptions = {}): RelayHub {
  const pairs = new Map<string, Pair>();
  const pairOf = (id: string): Pair => {
    const found = pairs.get(id) ?? {};
    pairs.set(id, found);
    return found;
  };

  return {
    attach(principalId, side, socket) {
      const pair = pairOf(principalId);
      pair[side]?.close(1000, "replaced by a newer connection");
      pair[side] = socket;
    },

    detach(principalId, side) {
      const pair = pairs.get(principalId);
      if (!pair) return;
      delete pair[side];
      if (side === "extension") {
        pair.cdp?.close(1001, "the extension disconnected");
        delete pair.cdp;
      }
      if (!pair.extension && !pair.cdp) pairs.delete(principalId);
    },

    deliver(principalId, side, raw) {
      const pair = pairs.get(principalId);
      if (!pair) return;
      if (side === "cdp") {
        if (!pair.cdp) return;
        let frame: { id?: number; method?: string };
        try {
          frame = JSON.parse(raw) as { id?: number; method?: string };
        } catch {
          return;
        }
        if (typeof frame.id === "number" && typeof frame.method === "string") {
          if (handshake(pair, frame.method, frame.id, pair.cdp)) return;
        }
        if (!pair.extension) {
          refuse(pair.cdp, frame.id, "your Chrome is not connected — open the QM extension");
          return;
        }
        if (!pair.sharing && typeof frame.method === "string" && frame.method.startsWith("Target.")) {
          refuse(pair.cdp, frame.id, "no tab is shared — open the QM extension and press Share this tab");
          return;
        }
        pair.extension.send(raw);
        return;
      }
      let frame: { qm?: string; title?: string; url?: string; restored?: boolean };
      try {
        frame = JSON.parse(raw) as { qm?: string; title?: string; url?: string; restored?: boolean };
      } catch {
        return;
      }
      if (frame.qm === "attached") {
        pair.title = frame.title ?? pair.title;
        pair.url = frame.url ?? pair.url;
        pair.sharing = true;
        if (!frame.restored) opts.onShareChanged?.(principalId, true);
        return;
      }
      if (frame.qm === "detached") {
        pair.sharing = false;
        delete pair.title;
        delete pair.url;
        opts.onShareChanged?.(principalId, false);
        return;
      }
      pair.cdp?.send(raw);
    },

    connected(principalId) {
      const pair = pairs.get(principalId);
      return {
        extension: Boolean(pair?.extension),
        cdp: Boolean(pair?.cdp),
        sharing: Boolean(pair?.extension && pair.sharing),
      };
    },

    describe(principalId) {
      const pair = pairs.get(principalId);
      if (!pair?.extension || !pair.sharing) return null;
      return { ...(pair.title ? { title: pair.title } : {}), ...(pair.url ? { url: pair.url } : {}) };
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
