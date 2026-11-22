import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AuditLog } from "../audit/audit-log.ts";
import { mintCapabilityToken, verifyCapabilityToken, type CapabilityClaims } from "../auth/capability-token.ts";
import { personalScope } from "../types.ts";
import { errMessage } from "../util/errors.ts";
import { createRelayHub, relaySocket, type BridgeBrowser, type RelayHub, type RelaySide } from "./relay.ts";

export const BROWSER_RELAY_AUD = "browser-relay";
export const BROWSER_RELAY_CDP_AUD = "browser-relay-cdp";
export const PAIRING_REVOKED = "the pairing was revoked";

const RELAY_EXTENSION_PATH = "/v1/browser-relay/extension";
const RELAY_CDP_PATH = "/v1/browser-relay/cdp";

export interface BrowserRelayOptions {
  hub?: RelayHub;
  capabilitySecret?: string;
  authorizesScope?: (claims: CapabilityClaims) => Promise<boolean>;
  stillChosen?: (actorId: string) => Promise<boolean>;
  pairingGeneration?: (actorId: string) => Promise<number>;
  noteBrowser?: (actorId: string, browser: BridgeBrowser) => Promise<string | null | undefined>;
  activeBrowser?: (actorId: string) => Promise<string | null | undefined>;
  auditLog?: Pick<AuditLog, "record">;
  appUrl?: string;
  idleMs?: number;
  pairingRecheckMs?: number;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const PAIRING_TTL_MS = 30 * 24 * 60 * 60_000;
const RENEW_WITHIN_MS = PAIRING_TTL_MS - 24 * 60 * 60_000;
const PAIRING_RECHECK_MS = 60_000;

export async function mintBrowserRelayPairing(
  actorId: string,
  secret: string,
  pairingGeneration: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  const token = await mintCapabilityToken(
    { actorId, aud: BROWSER_RELAY_AUD, scopeId: personalScope(actorId), pairingGeneration, exp: expiresAt },
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

const BROWSER_ID = /^[A-Za-z0-9-]{8,64}$/;

export function browserFromQuery(params: URLSearchParams): BridgeBrowser | undefined {
  const id = params.get("browser") ?? "";
  if (!BROWSER_ID.test(id)) return undefined;
  const name =
    (params.get("name") ?? "")
      .replace(/[^\p{L}\p{N} ._()·-]/gu, "")
      .trim()
      .slice(0, 60) || "Browser";
  const version = (params.get("v") ?? "").replace(/[^0-9.]/g, "").slice(0, 20);
  return { id, name, ...(version ? { version } : {}) };
}

async function chosenBrowser(
  side: RelaySide,
  actorId: string,
  browser: BridgeBrowser | undefined,
  opts: BrowserRelayOptions,
): Promise<string | null | undefined> {
  if (side === "cdp") return opts.activeBrowser?.(actorId);
  if (!browser || !opts.noteBrowser) return undefined;
  return opts.noteBrowser(actorId, browser);
}

function relaySideFor(pathname: string): RelaySide | null {
  if (pathname === RELAY_EXTENSION_PATH) return "extension";
  if (pathname === RELAY_CDP_PATH) return "cdp";
  return null;
}

async function pairingStillCurrent(claims: CapabilityClaims, opts: BrowserRelayOptions): Promise<boolean> {
  if (!opts.pairingGeneration) return true;
  return (claims.pairingGeneration ?? 0) === (await opts.pairingGeneration(claims.actorId));
}

async function relayClaimsFor(
  token: string | null,
  side: RelaySide,
  secret: string,
  opts: BrowserRelayOptions,
): Promise<CapabilityClaims | null> {
  if (!token) return null;
  const claims = await verifyCapabilityToken(token, secret);
  if (!claims?.actorId) return null;
  if (side === "extension") {
    if (claims.aud !== BROWSER_RELAY_AUD) return null;
    return (await pairingStillCurrent(claims, opts)) ? claims : null;
  }
  if (claims.aud !== BROWSER_RELAY_CDP_AUD || !isLivePersonalClaim(claims)) return null;
  if (opts.authorizesScope && !(await opts.authorizesScope(claims))) return null;
  if (opts.stillChosen && !(await opts.stillChosen(claims.actorId))) return null;
  return claims;
}

export function attachBrowserRelay(server: Server, opts: BrowserRelayOptions = {}): RelayHub {
  const hub = opts.hub ?? createRelayHub();
  const secret = opts.capabilitySecret;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const recheckMs = opts.pairingRecheckMs ?? PAIRING_RECHECK_MS;
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
      const claims = await relayClaimsFor(url.searchParams.get("t"), side, secret, opts).catch((e: unknown) => {
        console.error("[browser-relay] token check failed:", errMessage(e));
        return null;
      });
      if (!claims) return refuse(socket, 401, "Unauthorized");
      const browser = side === "extension" ? browserFromQuery(url.searchParams) : undefined;
      const active = await chosenBrowser(side, claims.actorId, browser, opts).catch((e: unknown) => {
        console.error("[browser-relay] browser registry unavailable:", errMessage(e));
        return undefined;
      });
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const owner = claims.actorId;
        const relayed = relaySocket(ws);
        if (side === "extension" && opts.appUrl) relayed.send(JSON.stringify({ qm: "origins", app: opts.appUrl }));
        if (active !== undefined) hub.setActive(owner, active);
        hub.attach(owner, side, relayed, browser);

        let expiresAt = claims.exp;
        let checking = false;
        let unreadable = 0;
        const cutOff = (code: number, reason: string) => {
          hub.detach(owner, side, relayed);
          ws.close(code, reason);
        };
        const recheck = () => {
          if (checking || ws.readyState !== ws.OPEN) return;
          checking = true;
          void (async () => {
            const current = await pairingStillCurrent(claims, opts).catch((e: unknown) => {
              console.error("[browser-relay] pairing check failed:", errMessage(e));
              return null;
            });
            if (current === null) {
              unreadable += 1;
              if (unreadable > 1) cutOff(1011, "the pairing could not be checked");
              return;
            }
            unreadable = 0;
            if (!current) return cutOff(1008, PAIRING_REVOKED);
            const left = expiresAt - Date.now();
            if (left <= 0 || left > RENEW_WITHIN_MS) return;
            const generation = claims.pairingGeneration ?? 0;
            const next = await mintBrowserRelayPairing(owner, secret, generation);
            if (ws.readyState !== ws.OPEN) return;
            expiresAt = next.expiresAt;
            relayed.send(JSON.stringify({ qm: "token", token: next.token }));
            opts.auditLog?.record({
              at: Date.now(),
              principalId: owner,
              action: "browser-relay.renew",
              resource: "browser-relay",
              scopeLabel: personalScope(owner),
              detail: `pairing generation ${generation}`,
            });
          })()
            .catch((e: unknown) => console.error("[browser-relay] pairing renewal failed:", errMessage(e)))
            .finally(() => {
              checking = false;
            });
        };
        const rechecks = side === "extension" ? setInterval(recheck, recheckMs) : undefined;
        if (side === "extension") recheck();

        let idle = setTimeout(() => ws.close(1000, "idle"), idleMs);
        const touch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => ws.close(1000, "idle"), idleMs);
        };
        ws.on("message", (data: Buffer | string) => {
          if (ws.readyState !== ws.OPEN) return;
          touch();
          hub.deliver(owner, side, typeof data === "string" ? data : data.toString("utf8"), relayed);
        });
        ws.on("pong", touch);
        ws.on("close", () => {
          clearTimeout(idle);
          clearInterval(rechecks);
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
