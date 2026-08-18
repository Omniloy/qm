import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyCapabilityToken } from "../auth/capability-token.ts";
import { errMessage } from "../util/errors.ts";
import { createRelayHub, relaySocket, type RelayHub, type RelaySide } from "./relay.ts";

/** The audience a pairing token carries, so it cannot stand in for anything else. */
export const BROWSER_RELAY_AUD = "browser-relay";

const RELAY_EXTENSION_PATH = "/v1/browser-relay/extension";
const RELAY_CDP_PATH = "/v1/browser-relay/cdp";

export interface BrowserRelayOptions {
  hub?: RelayHub;
  capabilitySecret?: string;
  /** Sockets with nothing to say for this long are dropped. */
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;

/**
 * Which person a socket speaks for, or null.
 *
 * Both legs prove identity with a signed token and the relay pairs strictly on
 * the actor inside it. That is the whole access-control story here, and it has
 * to be: the socket on the other end can read every cookie its owner holds, so
 * a token that identified the wrong person would hand one person's signed-in
 * browser to somebody else's agent.
 */
function relaySideFor(pathname: string): RelaySide | null {
  if (pathname === RELAY_EXTENSION_PATH) return "extension";
  if (pathname === RELAY_CDP_PATH) return "cdp";
  return null;
}

async function principalFor(url: URL, side: RelaySide, secret: string): Promise<string | null> {
  const token = url.searchParams.get("t");
  if (!token) return null;
  const claims = await verifyCapabilityToken(token, secret);
  if (!claims) return null;
  if (side === "extension" && claims.aud !== BROWSER_RELAY_AUD) return null;
  // A pairing token is for pairing. Letting it drive CDP as well would mean a
  // token pasted into an extension could also be replayed as the agent.
  if (side === "cdp" && claims.aud === BROWSER_RELAY_AUD) return null;
  return claims.actorId || null;
}

export function attachBrowserRelay(server: Server, opts: BrowserRelayOptions = {}): RelayHub {
  const hub = opts.hub ?? createRelayHub();
  const secret = opts.capabilitySecret;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const wss = new WebSocketServer({ noServer: true });

  const refuse = (socket: Duplex, code: number, text: string): void => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://relay.invalid");
    } catch {
      return refuse(socket, 400, "Bad Request");
    }
    const side = relaySideFor(url.pathname);
    // Anything else is not ours; leaving it alone lets other upgrade handlers
    // (or none) deal with it rather than answering for them.
    if (!side) return;
    if (!secret) return refuse(socket, 503, "Service Unavailable");

    void (async () => {
      let principalId: string | null = null;
      try {
        principalId = await principalFor(url, side, secret);
      } catch (e) {
        console.error("[browser-relay] token check failed:", errMessage(e));
      }
      if (!principalId) return refuse(socket, 401, "Unauthorized");
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const owner = principalId!;
        hub.attach(owner, side, relaySocket(ws));

        let idle = setTimeout(() => ws.close(1000, "idle"), idleMs);
        const touch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => ws.close(1000, "idle"), idleMs);
        };
        ws.on("message", (data: Buffer | string) => {
          touch();
          hub.deliver(owner, side, typeof data === "string" ? data : data.toString("utf8"));
        });
        ws.on("pong", touch);
        ws.on("close", () => {
          clearTimeout(idle);
          hub.detach(owner, side);
        });
        ws.on("error", () => ws.close());
      });
    })();
  });

  // Chrome puts a service worker to sleep when it goes quiet, and a proxy in
  // front of this will drop a silent connection long before that. A ping is
  // what keeps a browser someone left open still reachable.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.ping();
  }, 30_000);
  heartbeat.unref?.();
  server.on("close", () => {
    clearInterval(heartbeat);
    wss.close();
  });

  return hub;
}
