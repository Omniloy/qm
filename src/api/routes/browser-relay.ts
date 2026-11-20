import { mintBrowserRelayPairing, PAIRING_REVOKED } from "../../browser-relay/server.ts";
import { EXTENSION_BROWSER_ID } from "../../connectors/browser-providers.ts";
import type { ScopedConfigStore } from "../../resolution/config-store.ts";
import { personalScope } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { audit } from "./shared.ts";

function callerOf(ctx: ApiCtx): string | null {
  return ctx.capability?.actorId ?? ctx.actor?.p ?? null;
}

function personThemselves(ctx: ApiCtx): string | undefined {
  return ctx.actor?.imp ? undefined : ctx.actor?.p;
}

async function replacePairing(ctx: ApiCtx, config: ScopedConfigStore, principalId: string): Promise<number> {
  const generation = await config.bumpBrowserPairingGeneration(personalScope(principalId));
  ctx.deps.browserRelay?.disconnect(principalId, PAIRING_REVOKED);
  return generation;
}

async function mintRelayPairing(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const secret = deps.capabilitySecret;
  const config = deps.config;
  if (!secret || !config) return sendJson(res, 503, { error: "unavailable", message: "the relay is not configured" });
  const principalId = personThemselves(ctx);
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "pairing is only available to the person themselves, from their own web session",
    });
  const generation = await replacePairing(ctx, config, principalId);
  const { token, expiresAt } = await mintBrowserRelayPairing(principalId, secret, generation);
  config.setBrowserProvider(personalScope(principalId), EXTENSION_BROWSER_ID);
  audit(deps, {
    principalId,
    action: "browser-relay.pair",
    resource: "browser-relay",
    scopeLabel: personalScope(principalId),
    detail: `pairing generation ${generation}`,
  });
  const relayUrl = deps.relayPublicUrl;
  return sendJson(res, 200, {
    token,
    expiresAt,
    ...(relayUrl ? { relayUrl } : {}),
  });
}

async function disconnectRelay(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const config = deps.config;
  if (!config) return sendJson(res, 503, { error: "unavailable", message: "the relay is not configured" });
  const principalId = personThemselves(ctx);
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "disconnecting Chrome is only available to the person themselves, from their own web session",
    });
  const scope = personalScope(principalId);
  const generation = await replacePairing(ctx, config, principalId);
  if ((await config.getBrowserProviderDurable(scope)) === EXTENSION_BROWSER_ID) config.setBrowserProvider(scope, null);
  audit(deps, {
    principalId,
    action: "browser-relay.disconnect",
    resource: "browser-relay",
    scopeLabel: scope,
    detail: `pairing generation ${generation}`,
  });
  return sendJson(res, 200, { ok: true });
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
  { method: "POST", path: "/v1/browser-relay/pairing", auth: "source", handle: mintRelayPairing },
  { method: "POST", path: "/v1/browser-relay/disconnect", auth: "source", handle: disconnectRelay },
  { method: "GET", path: "/v1/browser-relay/status", auth: "either", handle: relayStatus },
];
