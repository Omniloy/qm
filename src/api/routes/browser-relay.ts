import { mintCapabilityToken } from "../../auth/capability-token.ts";
import { BROWSER_RELAY_AUD, isLivePersonalClaim } from "../../browser-relay/server.ts";
import { personalScope } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit } from "./shared.ts";

const PAIRING_TTL_MS = 30 * 24 * 60 * 60_000;

function callerOf(ctx: ApiCtx): string | null {
  return ctx.capability?.actorId ?? ctx.actor?.p ?? null;
}

function pairingCallerOf(ctx: ApiCtx): string | null {
  if (!ctx.capability) return ctx.actor?.p ?? null;
  return isLivePersonalClaim(ctx.capability) ? ctx.capability.actorId : null;
}

async function mintRelayPairing(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const secret = deps.capabilitySecret;
  if (!secret) return sendJson(res, 503, { error: "unavailable", message: "the relay is not configured" });
  const principalId = pairingCallerOf(ctx);
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "pairing is only available to the person themselves, live, in their own conversation",
    });
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  const token = await mintCapabilityToken(
    {
      actorId: principalId,
      aud: BROWSER_RELAY_AUD,
      scopeId: personalScope(principalId),
      exp: expiresAt,
    },
    secret,
  );
  audit(deps, {
    principalId,
    action: "browser-relay.pair",
    resource: "browser-relay",
    scopeLabel: personalScope(principalId),
  });
  const relayUrl = deps.relayPublicUrl;
  return sendJson(res, 200, {
    token,
    expiresAt,
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
