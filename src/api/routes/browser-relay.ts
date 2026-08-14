import { mintCapabilityToken } from "../../auth/capability-token.ts";
import { BROWSER_RELAY_AUD } from "../../browser-relay/server.ts";
import { personalScope } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit } from "./shared.ts";

/**
 * A pairing token lasts this long. It is not a session — the extension holds
 * it and reconnects with it — so it is deliberately not indefinite: the token
 * grants a socket that can drive a fully signed-in browser, and something that
 * powerful should expire on its own if forgotten.
 */
const PAIRING_TTL_MS = 30 * 24 * 60 * 60_000;

function callerOf(ctx: ApiCtx): string | null {
  return ctx.capability?.actorId ?? ctx.actor?.p ?? null;
}

async function mintRelayPairing(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const secret = deps.capabilitySecret;
  if (!secret) return sendJson(res, 503, { error: "unavailable", message: "the relay is not configured" });
  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });
  // A person pairs their own browser and nobody else's, so the token is minted
  // for the caller rather than for anyone they name.
  const token = await mintCapabilityToken(
    {
      actorId: principalId,
      aud: BROWSER_RELAY_AUD,
      scopeId: personalScope(principalId),
      exp: Date.now() + PAIRING_TTL_MS,
    },
    secret,
  );
  audit(deps, {
    principalId,
    action: "browser-relay.pair",
    resource: "browser-relay",
    scopeLabel: personalScope(principalId),
  });
  // The address the extension dials, so the person pastes a token and nothing
  // else. Absent until the relay host is configured — the extension can still
  // be pointed by hand.
  const relayUrl = deps.relayPublicUrl;
  return sendJson(res, 200, {
    token,
    expiresAt: Date.now() + PAIRING_TTL_MS,
    ...(relayUrl ? { relayUrl } : {}),
  });
}

async function relayStatus(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });
  const hub = deps.browserRelay;
  if (!hub) return sendJson(res, 200, { connected: false, sharing: false, available: false });
  const state = hub.connected(principalId);
  return sendJson(res, 200, {
    available: true,
    connected: state.extension,
    sharing: state.sharing,
    inUse: state.cdp,
    ...hub.describe(principalId),
  });
}

export const browserRelayRoutes: Route[] = [
  { method: "POST", path: "/v1/browser-relay/pairing", auth: "either", handle: mintRelayPairing },
  { method: "GET", path: "/v1/browser-relay/status", auth: "either", handle: relayStatus },
];
