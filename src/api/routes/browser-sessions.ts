import type { ApiCtx, Route } from "./route.ts";
import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import { scopeId } from "../../types.ts";
import type { ControlMode, LiveBrowserSession } from "../../connectors/browser-live-session-store.ts";

/**
 * The browser a person has open: registering it, finding it, and arbitrating
 * who is driving.
 *
 * Core does not create browsers. The browse skill does that against whichever
 * provider the person's key names; this router only records the result so the
 * web UI can render a pane, and owns the one thing no vendor provides — a
 * single answer to "who has the wheel right now".
 *
 * Two rules run through every handler:
 *
 * A browser is logged into someone's real accounts, so it is addressable only
 * by its owner. Every route derives the principal from the caller's own token
 * and never from a parameter.
 *
 * Opening or handing over such a browser is a person's decision. Agent turns
 * may register and read; they may not take control, and a triggered turn — a
 * cron, a webhook, anything with no human present — may not mutate at all.
 * Modelled on decideMountMutation in ../../mounts/attach-policy.ts, which
 * refuses before it looks anything up. Deliberately not modelled on
 * ./emoji.ts, the only other route touching a browser session store: it takes
 * capability.actorId correctly but has no triggered check, no liveActor check
 * and writes no audit row.
 */

const callerOf = (ctx: ApiCtx): string | null => ctx.capability?.actorId ?? ctx.actor?.p ?? null;

/** The session a person may act on is the one in their own personal scope. */
function ownScopeViolation(ctx: ApiCtx, principalId: string): string | null {
  const claimed = ctx.capability?.scopeId;
  if (!claimed) return null; // A portal identity carries no scope; the principal is the boundary.
  return claimed === scopeId("personal", principalId) ? null : "a browser belongs to one person, not to a room";
}

function refuseTriggered(ctx: ApiCtx): string | null {
  if (!ctx.capability?.triggered) return null;
  return "opening or handing over a browser is a person's decision — it cannot happen on an unattended run";
}

/** What leaves core. Never the CDP URL: providers embed their API key in it. */
function wire(s: LiveBrowserSession): Record<string, unknown> {
  return {
    provider: s.provider,
    sessionId: s.sessionId,
    threadRef: s.threadRef,
    viewer: s.viewer,
    liveViewUrl: s.liveViewUrl,
    controlMode: s.controlMode,
    expiresAt: s.expiresAt,
    ...(s.handedOffAt === undefined ? {} : { handedOffAt: s.handedOffAt }),
  };
}

// Absent means iframe: that is what every caller sent before the viewer was
// named, and it is the shape that carries a secret.
function requestedViewer(viewer: unknown): "iframe" | null {
  if (viewer === undefined || viewer === "iframe") return "iframe";
  return null;
}

async function registerSession(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const store = deps.liveBrowserSessions;
  if (!store) return sendJson(res, 503, { error: "unavailable", message: "browser sessions are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const triggered = refuseTriggered(ctx);
  if (triggered) return sendJson(res, 403, { error: "forbidden", message: triggered });
  const scopeErr = ownScopeViolation(ctx, principalId);
  if (scopeErr) return sendJson(res, 403, { error: "forbidden", message: scopeErr });

  const b = isObj(ctx.body) ? ctx.body : {};
  const provider = typeof b.provider === "string" ? b.provider.trim() : "";
  const sessionId = typeof b.sessionId === "string" ? b.sessionId.trim() : "";
  const liveViewUrl = typeof b.liveViewUrl === "string" ? b.liveViewUrl.trim() : "";
  const expiresAt = typeof b.expiresAt === "number" ? b.expiresAt : 0;
  const viewer = requestedViewer(b.viewer);
  if (viewer === null) {
    return sendJson(res, 400, { error: "bad_request", message: 'viewer must be "iframe"' });
  }
  if (!provider || !sessionId || !expiresAt) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "provider, sessionId and expiresAt are required",
    });
  }
  if (!liveViewUrl) {
    return sendJson(res, 400, { error: "bad_request", message: "an iframe viewer needs a liveViewUrl" });
  }
  if (/^cdp:|^wss:\/\/connect\./i.test(liveViewUrl)) {
    // Cheap guard against the mistake that would matter most: some providers
    // embed the API key in the CDP URL, and this value reaches a browser tab.
    return sendJson(res, 400, { error: "bad_request", message: "liveViewUrl must be the viewer URL, not the CDP URL" });
  }

  // Refuse before a browser exists rather than after. A browser costs about
  // 1.25 GB, so on a host that also runs other things the honest answer to
  // "one too many" is a sentence, not an out-of-memory kill — and the caller
  // registers before launching so this arrives while it is still free to obey.
  const already = await store.get(principalId, Date.now());
  if (!already) {
    const cap = deps.maxLiveBrowsers ?? 1;
    if ((await store.countLive(Date.now())) >= cap) {
      return sendJson(res, 409, {
        error: "busy",
        message:
          cap === 1
            ? "someone else has a browser open, and there is only room for one at a time — try again in a few minutes"
            : `all ${cap} browsers are in use — try again in a few minutes`,
      });
    }
  }

  // The thread comes from the token, not the body, so a turn cannot attach a
  // browser to a conversation it is not running in.
  const threadRef = ctx.capability?.threadRef ?? "";
  if (!threadRef) {
    return sendJson(res, 400, { error: "bad_request", message: "no thread on this token to attach a browser to" });
  }

  const now = Date.now();
  const session = await store.put({
    principalId,
    provider,
    sessionId,
    threadRef,
    viewer,
    liveViewUrl,
    controlMode: "agent",
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  audit(deps, {
    principalId,
    action: "browser.session.opened",
    // Deliberately not the URL — an audit row is a place secrets go to live
    // forever.
    resource: `${provider}:${sessionId}`,
    scopeLabel: threadRef,
  });
  return sendJson(res, 200, { session: wire(session) });
}

async function currentSession(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const store = deps.liveBrowserSessions;
  if (!store) return sendJson(res, 503, { error: "unavailable", message: "browser sessions are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const session = await store.get(principalId, Date.now());
  // Absence is a state, not an error: the pane renders nothing and says so.
  if (!session) return sendJson(res, 200, { session: null });
  audit(deps, {
    principalId,
    action: "browser.liveview.minted",
    resource: `${session.provider}:${session.sessionId}`,
    scopeLabel: session.threadRef,
  });
  return sendJson(res, 200, { session: wire(session) });
}

/** Just the control flag. The runner polls this between steps, so it stays cheap and secret-free. */
async function sessionState(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const store = deps.liveBrowserSessions;
  if (!store) return sendJson(res, 503, { error: "unavailable", message: "browser sessions are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const session = await store.get(principalId, Date.now());
  if (!session || session.sessionId !== ctx.params.id) return sendJson(res, 404, { error: "not_found" });
  return sendJson(res, 200, {
    controlMode: session.controlMode,
    ...(session.handedOffAt === undefined ? {} : { handedOffAt: session.handedOffAt }),
  });
}

async function handoff(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const store = deps.liveBrowserSessions;
  if (!store) return sendJson(res, 503, { error: "unavailable", message: "browser sessions are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  // Taking the wheel is a person's act. An agent turn may not grant itself
  // control, and may not take it away from someone who has it.
  if (ctx.capability && !ctx.capability.liveActor) {
    return sendJson(res, 403, {
      error: "forbidden",
      message: "control of a browser is handed over by the person, from the browser pane",
    });
  }
  const triggered = refuseTriggered(ctx);
  if (triggered) return sendJson(res, 403, { error: "forbidden", message: triggered });

  const b = isObj(ctx.body) ? ctx.body : {};
  const mode = b.mode;
  if (mode !== "agent" && mode !== "human_control") {
    return sendJson(res, 400, { error: "bad_request", message: 'mode must be "agent" or "human_control"' });
  }

  const now = Date.now();
  const before = await store.get(principalId, now);
  if (!before || before.sessionId !== ctx.params.id) {
    // 409 rather than 404: the person did have a browser, it just ended under
    // them, and the pane should say that rather than "no such thing".
    return sendJson(res, 409, { error: "gone", message: "that browser has already ended" });
  }

  const session = await store.setControl(principalId, mode as ControlMode, now);
  if (!session) return sendJson(res, 409, { error: "gone", message: "that browser has already ended" });
  audit(deps, {
    principalId,
    action: mode === "human_control" ? "browser.control.taken" : "browser.control.released",
    resource: `${session.provider}:${session.sessionId}`,
    scopeLabel: session.threadRef,
  });
  return sendJson(res, 200, { session: wire(session) });
}

async function endSession(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const store = deps.liveBrowserSessions;
  if (!store) return sendJson(res, 503, { error: "unavailable", message: "browser sessions are not configured" });

  const principalId = callerOf(ctx);
  if (!principalId) return sendJson(res, 403, { error: "forbidden", message: "an identified caller is required" });

  const session = await store.get(principalId, Date.now());
  // Idempotent: the skill calls this on cleanup and a person can click End
  // session, and the two racing should not produce an error either way.
  if (!session || session.sessionId !== ctx.params.id) return sendJson(res, 200, { ok: true });

  await store.clear(principalId);
  audit(deps, {
    principalId,
    action: "browser.session.ended",
    resource: `${session.provider}:${session.sessionId}`,
    scopeLabel: session.threadRef,
  });
  return sendJson(res, 200, { ok: true });
}

export const browserSessionRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/browser-sessions", auth: "either", handle: registerSession },
  { method: "GET", path: "/v1/browser-sessions/current", auth: "either", handle: currentSession },
  { method: "GET", path: "/v1/browser-sessions/:id/state", auth: "either", handle: sessionState },
  { method: "POST", path: "/v1/browser-sessions/:id/handoff", auth: "either", handle: handoff },
  { method: "DELETE", path: "/v1/browser-sessions/:id", auth: "either", handle: endSession },
];
