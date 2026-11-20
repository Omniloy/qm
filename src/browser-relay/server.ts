import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { mintCapabilityToken, verifyCapabilityToken, type CapabilityClaims } from "../auth/capability-token.ts";
import { personalScope } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { createRelayHub, relaySocket, type RelayHub, type RelaySide } from "./relay.ts";

export const BROWSER_RELAY_AUD = "browser-relay";
export const BROWSER_RELAY_CDP_AUD = "browser-relay-cdp";

const RELAY_EXTENSION_PATH = "/v1/browser-relay/extension";
const RELAY_CDP_PATH = "/v1/browser-relay/cdp";

type ScopeAuthorizer = (claims: CapabilityClaims) => Promise<boolean>;
type ChoiceCheck = (actorId: string) => Promise<boolean>;

export interface BrowserRelayOptions {
  hub?: RelayHub;
  capabilitySecret?: string;
  authorizesScope?: ScopeAuthorizer;
  stillChosen?: ChoiceCheck;
  appUrl?: string;
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const PAIRING_TTL_MS = 30 * 24 * 60 * 60_000;
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60_000;

export async function mintBrowserRelayPairing(
  actorId: string,
  secret: string,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  const token = await mintCapabilityToken(
    { actorId, aud: BROWSER_RELAY_AUD, scopeId: personalScope(actorId), exp: expiresAt },
    secret,
  );
  return { token, expiresAt };
}

export function isLivePersonalClaim(claims: CapabilityClaims): boolean {
  return (
    claims.liveActor === true &&
    claims.triggered !== true &&
    claims.externalSlack !== true &&
    claims.deployment === undefined &&
    claims.scopeId === personalScope(claims.actorId)
  );
}

function relaySideFor(pathname: string): RelaySide | null {
  if (pathname === RELAY_EXTENSION_PATH) return "extension";
  if (pathname === RELAY_CDP_PATH) return "cdp";
  return null;
}

async function relayClaimsFor(
  token: string | null,
  side: RelaySide,
  secret: string,
  authorizesScope?: ScopeAuthorizer,
  stillChosen?: ChoiceCheck,
): Promise<CapabilityClaims | null> {
  if (!token) return null;
  const claims = await verifyCapabilityToken(token, secret);
  if (!claims?.actorId) return null;
  if (side === "extension") return claims.aud === BROWSER_RELAY_AUD ? claims : null;
  if (claims.aud !== BROWSER_RELAY_CDP_AUD || !isLivePersonalClaim(claims)) return null;
  if (authorizesScope && !(await authorizesScope(claims))) return null;
  if (stillChosen && !(await stillChosen(claims.actorId))) return null;
  return claims;
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
    if (!side) return;
    if (!secret) return refuse(socket, 503, "Service Unavailable");

    void (async () => {
      const claims = await relayClaimsFor(
        url.searchParams.get("t"),
        side,
        secret,
        opts.authorizesScope,
        opts.stillChosen,
      ).catch((e: unknown) => {
        console.error("[browser-relay] token check failed:", errMessage(e));
        return null;
      });
      if (!claims) return refuse(socket, 401, "Unauthorized");
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const owner = claims.actorId;
        const relayed = relaySocket(ws);
        hub.attach(owner, side, relayed);
        if (side === "extension" && opts.appUrl) relayed.send(JSON.stringify({ qm: "origins", app: opts.appUrl }));

        let expiresAt = claims.exp;
        const renew = () => {
          if (side !== "extension" || expiresAt - Date.now() > RENEW_WITHIN_MS) return;
          expiresAt = Number.POSITIVE_INFINITY;
          mintBrowserRelayPairing(owner, secret).then(
            (next) => {
              expiresAt = next.expiresAt;
              relayed.send(JSON.stringify({ qm: "token", token: next.token }));
            },
            (e: unknown) => {
              expiresAt = claims.exp;
              console.error("[browser-relay] pairing renewal failed:", errMessage(e));
            },
          );
        };
        renew();

        let idle = setTimeout(() => ws.close(1000, "idle"), idleMs);
        const touch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => ws.close(1000, "idle"), idleMs);
        };
        ws.on("message", (data: Buffer | string) => {
          touch();
          hub.deliver(owner, side, typeof data === "string" ? data : data.toString("utf8"));
        });
        ws.on("pong", () => {
          touch();
          renew();
        });
        ws.on("close", () => {
          clearTimeout(idle);
          hub.detach(owner, side, relayed);
        });
        ws.on("error", () => ws.close());
      });
    })();
  });

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
