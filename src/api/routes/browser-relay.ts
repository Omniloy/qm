import { mintBrowserRelayPairing, PAIRING_REVOKED } from "../../browser-relay/server.ts";
import { EXTENSION_BROWSER_ID } from "../../connectors/browser-providers.ts";
import type { ScopedConfigStore } from "../../resolution/config-store.ts";
import { personalScope } from "../../types.ts";
import { sendJson } from "../http.ts";
import type { ServerDeps } from "../deps.ts";
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

export interface BridgeBrowserView {
  id: string;
  name: string;
  version?: string;
  connected: boolean;
  active: boolean;
  sharing: boolean;
  title?: string;
  lastSeenAt?: number;
}

export async function bridgeBrowsers(deps: ServerDeps, principalId: string): Promise<BridgeBrowserView[]> {
  const known = (await deps.config?.getBridgeBrowsers(personalScope(principalId))) ?? {
    active: undefined,
    at: 0,
    browsers: {},
  };
  const live = deps.browserRelay?.browsers(principalId) ?? { active: undefined, live: [] };
  const active = live.active !== undefined ? live.active : known.active;
  const liveById = new Map(live.live.map((b) => [b.id, b]));
  const ids = new Set([...Object.keys(known.browsers), ...liveById.keys()]);
  const onlyOne = active === undefined && liveById.size === 1;
  return [...ids]
    .map((id): BridgeBrowserView => {
      const seen = liveById.get(id);
      const stored = known.browsers[id];
      return {
        id,
        name: seen?.name ?? stored?.name ?? "Browser",
        ...((seen?.version ?? stored?.version) ? { version: seen?.version ?? stored?.version } : {}),
        connected: Boolean(seen),
        active: active === id || (onlyOne && Boolean(seen)),
        sharing: Boolean(seen?.sharing),
        ...(seen?.title ? { title: seen.title } : {}),
        ...(stored?.lastSeenAt ? { lastSeenAt: stored.lastSeenAt } : {}),
      };
    })
    .sort((a, b) => Number(b.connected) - Number(a.connected) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

async function chooseBrowser(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const config = deps.config;
  if (!config) return sendJson(res, 503, { error: "unavailable", message: "the relay is not configured" });
  const principalId = personThemselves(ctx);
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "choosing a browser is only available to the person themselves, from their own web session",
    });
  const wanted = (body as { browserId?: unknown } | undefined)?.browserId;
  if (wanted !== null && typeof wanted !== "string")
    return sendJson(res, 400, { error: "bad_request", message: "browserId must be a browser id or null" });
  const scope = personalScope(principalId);
  if (typeof wanted === "string" && !(await bridgeBrowsers(deps, principalId)).some((b) => b.id === wanted))
    return sendJson(res, 404, { error: "not_found", message: "no browser with that id has connected" });
  const saved = await config.setActiveBridgeBrowser(scope, wanted, Date.now());
  deps.browserRelay?.setActive(principalId, saved.active, saved.at);
  if (saved.active !== wanted)
    return sendJson(res, 409, {
      error: "conflict",
      message: "a newer browser choice was made a moment ago — check the list and choose again",
      browsers: await bridgeBrowsers(deps, principalId),
    });
  if (wanted) config.setBrowserProvider(scope, EXTENSION_BROWSER_ID);
  audit(deps, {
    principalId,
    action: "browser-relay.choose",
    resource: "browser-relay",
    scopeLabel: scope,
    detail: wanted ?? "none",
  });
  return sendJson(res, 200, { browsers: await bridgeBrowsers(deps, principalId) });
}

async function forgetBrowser(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const config = deps.config;
  if (!config) return sendJson(res, 503, { error: "unavailable", message: "the relay is not configured" });
  const principalId = personThemselves(ctx);
  if (!principalId)
    return sendJson(res, 403, {
      error: "forbidden",
      message: "forgetting a browser is only available to the person themselves, from their own web session",
    });
  const wanted = (body as { browserId?: unknown } | undefined)?.browserId;
  if (typeof wanted !== "string") return sendJson(res, 400, { error: "bad_request", message: "browserId is required" });
  if (deps.browserRelay?.browsers(principalId).live.some((b) => b.id === wanted))
    return sendJson(res, 409, {
      error: "conflict",
      message: "that browser is connected right now — close it or turn its Browser Bridge off, then forget it",
    });
  const scope = personalScope(principalId);
  const after = await config.forgetBridgeBrowser(scope, wanted);
  if (after.active === null) deps.browserRelay?.setActive(principalId, null, after.at);
  audit(deps, {
    principalId,
    action: "browser-relay.forget",
    resource: "browser-relay",
    scopeLabel: scope,
    detail: wanted,
  });
  return sendJson(res, 200, { browsers: await bridgeBrowsers(deps, principalId) });
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
    ...(personThemselves(ctx) ? { browsers: await bridgeBrowsers(deps, principalId) } : {}),
  });
}

export const browserRelayRoutes: Route[] = [
  { method: "POST", path: "/v1/browser-relay/pairing", auth: "source", handle: mintRelayPairing },
  { method: "POST", path: "/v1/browser-relay/disconnect", auth: "source", handle: disconnectRelay },
  { method: "GET", path: "/v1/browser-relay/status", auth: "either", handle: relayStatus },
  { method: "POST", path: "/v1/browser-relay/active", auth: "source", handle: chooseBrowser },
  { method: "POST", path: "/v1/browser-relay/forget", auth: "source", handle: forgetBrowser },
];
