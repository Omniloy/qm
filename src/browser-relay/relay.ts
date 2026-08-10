import type { WebSocket } from "ws";

/**
 * Pairs a person's own Chrome with the browser their agent drives.
 *
 * The two problems a sandbox browser cannot solve are the same problem: it is
 * not the browser the person actually uses. It holds none of their sign-ins and
 * it looks like automation to anything that checks. Their own Chrome holds both
 * — so an extension attaches Chrome's debugger to one tab and this relays the
 * protocol between it and the sandbox.
 *
 * Chrome refuses `--remote-debugging-port` on a real profile on purpose, so an
 * extension is the only way in. What that extension speaks is still CDP, which
 * is why nothing above this file changes: the skill points its existing
 * `open --cdp` at a relay URL and every verb behaves as before.
 */

export type RelaySide = "extension" | "cdp";

export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Pair {
  extension?: RelaySocket;
  cdp?: RelaySocket;
  /** The tab the extension attached to, as the extension reported it. */
  title?: string;
  url?: string;
  /** True between "share this tab" and "stop sharing". */
  sharing?: boolean;
}

/** The single page the sandbox is allowed to see, whatever Chrome calls it. */
const TARGET_ID = "qm-extension-page";
const SESSION_ID = "qm-extension-session";

export interface RelayHub {
  attach(principalId: string, side: RelaySide, socket: RelaySocket): void;
  detach(principalId: string, side: RelaySide): void;
  /** A frame from one side, to be acted on or forwarded. */
  deliver(principalId: string, side: RelaySide, raw: string): void;
  connected(principalId: string): { extension: boolean; cdp: boolean };
  describe(principalId: string): { title?: string; url?: string } | null;
}

function reply(socket: RelaySocket, id: number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}

/**
 * `chrome.debugger` attaches to one tab; it is not a browser-level endpoint,
 * so the handshake a remote CDP client opens with has no counterpart to
 * forward to. Answer it here with a single synthetic page instead. That keeps
 * the client — and every skill built on it — unchanged.
 */
function handshake(pair: Pair, method: string, id: number, cdp: RelaySocket): boolean {
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
  // Chrome's debugger API exposes no Browser domain, so a graceful
  // browser-level close has nothing to call. Closing the person's own browser
  // would be wrong anyway — this ends the agent's use of it, nothing more.
  if (method === "Browser.close" || method === "Browser.getVersion") {
    reply(cdp, id, method === "Browser.close" ? {} : { product: "Chrome/extension", protocolVersion: "1.3" });
    return true;
  }
  return false;
}

export interface RelayHubOptions {
  /**
   * Called when a person shares a tab, or explicitly stops sharing.
   *
   * Connecting the extension and choosing it as your browser were two separate
   * steps, and doing only the first left every turn quietly on the sandbox
   * browser — which is exactly the state someone thinks they have fixed. So
   * sharing a tab IS the choice, and stopping sharing takes it back.
   */
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
      // One of each. A second connection on the same side is the newer one
      // taking over — reconnects after a service worker restart are routine,
      // and leaving the stale socket wired up would black-hole every reply.
      pair[side]?.close(1000, "replaced by a newer connection");
      pair[side] = socket;
    },

    detach(principalId, side) {
      const pair = pairs.get(principalId);
      if (!pair) return;
      delete pair[side];
      if (side === "extension") {
        // The browser went away. Say so rather than leaving the agent waiting
        // on replies that are never coming.
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
          if (typeof frame.id === "number") {
            pair.cdp.send(
              JSON.stringify({
                id: frame.id,
                error: { code: -32000, message: "your Chrome is not connected — open the QM extension" },
              }),
            );
          }
          return;
        }
        pair.extension.send(raw);
        return;
      }
      // From the extension: command results and page events, plus the one
      // message that is ours — what tab it attached to.
      let frame: { qm?: string; title?: string; url?: string };
      try {
        frame = JSON.parse(raw) as { qm?: string; title?: string; url?: string };
      } catch {
        return;
      }
      if (frame.qm === "attached") {
        pair.title = frame.title ?? pair.title;
        pair.url = frame.url ?? pair.url;
        pair.sharing = true;
        opts.onShareChanged?.(principalId, true);
        return;
      }
      if (frame.qm === "detached") {
        // Explicit "stop sharing" only. A socket that merely closed is a
        // sleeping service worker, not a decision — reverting on that would
        // undo the person's choice every time Chrome idled the extension.
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
      return { extension: Boolean(pair?.extension), cdp: Boolean(pair?.cdp) };
    },

    describe(principalId) {
      const pair = pairs.get(principalId);
      if (!pair?.extension) return null;
      return { ...(pair.title ? { title: pair.title } : {}), ...(pair.url ? { url: pair.url } : {}) };
    },
  };
}

/** Adapts a `ws` socket to the narrow surface the hub needs. */
export function relaySocket(ws: WebSocket): RelaySocket {
  return {
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: (code, reason) => ws.close(code ?? 1000, reason ?? ""),
  };
}
