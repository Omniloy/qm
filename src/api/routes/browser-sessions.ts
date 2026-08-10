import type { ApiCtx, Route } from "./route.ts";
import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import { scopeId } from "../../types.ts";
import { swallow } from "../../util/errors.ts";
import type { ExecResult, SandboxHandle } from "../../sandbox/sandbox.ts";
import type { ControlMode, LiveBrowserSession } from "../../connectors/browser-live-session-store.ts";
import { BRAND } from "../../../plugins/chassis/src/brand.ts";

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
    // Only an iframe viewer has a URL. Emitting the key as undefined would
    // leave the pane unable to tell "streamed" from "iframe we failed to read".
    ...(s.viewer === "iframe" ? { liveViewUrl: s.liveViewUrl } : {}),
    controlMode: s.controlMode,
    expiresAt: s.expiresAt,
    ...(s.handedOffAt === undefined ? {} : { handedOffAt: s.handedOffAt }),
  };
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
  // Absent means iframe: that is what every caller sent before streamed
  // browsers existed, and it is the shape that carries a secret.
  const viewer = b.viewer === "stream" ? "stream" : b.viewer === undefined || b.viewer === "iframe" ? "iframe" : null;
  if (viewer === null) {
    return sendJson(res, 400, { error: "bad_request", message: 'viewer must be "iframe" or "stream"' });
  }
  if (!provider || !sessionId || !expiresAt) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "provider, sessionId and expiresAt are required",
    });
  }
  if (viewer === "iframe" && !liveViewUrl) {
    return sendJson(res, 400, { error: "bad_request", message: "an iframe viewer needs a liveViewUrl" });
  }
  // A streamed browser is reached through Miniomni's own authenticated endpoint, so
  // it has no URL. Accepting one anyway would quietly store bearer material
  // for a viewer that will never render it — and it is the shape a confused
  // caller would send while pasting a CDP URL somewhere it does not belong.
  if (viewer === "stream" && liveViewUrl) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `a streamed browser is reached through ${BRAND.productName} and must not carry a liveViewUrl`,
    });
  }
  if (viewer === "iframe" && /^cdp:|^wss:\/\/connect\./i.test(liveViewUrl)) {
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
    ...(viewer === "iframe" ? { liveViewUrl } : {}),
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

/**
 * Frames and input for a browser Miniomni hosts itself.
 *
 * The picture is fetched rather than streamed. Chrome binds its debug port to
 * loopback and will not be talked out of it, so nothing outside the sandbox can
 * reach the browser directly — which is a good property, not an obstacle: it
 * means there is no port to expose and no unauthenticated CDP endpoint anywhere.
 * Frames therefore travel the path that already exists and is already
 * authenticated. Measured at about 145ms a frame, roughly the same rate CDP's
 * own screencast manages while someone scrolls.
 */
const sandboxHandles = new Map<string, SandboxHandle>();

async function ownSandbox(deps: ApiCtx["deps"], scope: string): Promise<SandboxHandle | null> {
  const sandbox = deps.sandbox;
  if (!sandbox) return null;
  const cached = sandboxHandles.get(scope);
  if (cached) return cached;
  // Provisioning per frame would mean several docker calls a second; the handle
  // is just an address, so it is cached and dropped when a call fails.
  const handle = await sandbox.provision([{ scopeId: scope, mode: "rw", mountPath: "" }]);
  sandboxHandles.set(scope, handle);
  return handle;
}

// Absolute, and cd'd first: the exec path does not guarantee a working
// directory, and a relative path resolved from /root instead of the workspace
// produced a "no such file" that surfaced only as a blank pane.
const BROWSER_CLI = "cd /root/workspace && python3 skills/browse/scripts/browser.py";

async function runInOwnSandbox(ctx: ApiCtx, scope: string, args: string): Promise<ExecResult | null> {
  const sandbox = ctx.deps.sandbox;
  const handle = await ownSandbox(ctx.deps, scope);
  if (!sandbox || !handle) return null;
  try {
    return await sandbox.run(handle, `${BROWSER_CLI} ${args}`, { timeoutMs: 20_000 });
  } catch (e) {
    // A handle outlives a restarted sandbox; drop it so the next call rebuilds.
    sandboxHandles.delete(scope);
    swallow(`browser pane exec ${scope}`, e);
    return null;
  }
}

/**
 * Resolve the session this request may act on.
 *
 * Everything is derived from the caller's own token: the principal, and from it
 * the scope whose sandbox gets executed in. Nothing here is addressable by a
 * parameter, so no request can reach another person's browser.
 */
async function paneTarget(
  ctx: ApiCtx,
): Promise<{ principalId: string; scope: string; session: LiveBrowserSession } | null> {
  const store = ctx.deps.liveBrowserSessions;
  if (!store) {
    sendJson(ctx.res, 503, { error: "unavailable", message: "browser sessions are not configured" });
    return null;
  }
  const principalId = callerOf(ctx);
  if (!principalId) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "an identified caller is required" });
    return null;
  }
  const session = await store.get(principalId, Date.now());
  if (!session || session.sessionId !== ctx.params.id) {
    sendJson(ctx.res, 409, { error: "gone", message: "that browser has already ended" });
    return null;
  }
  if (session.viewer !== "stream") {
    // A vendor's browser renders in its own viewer; we have no frames for it.
    sendJson(ctx.res, 400, { error: "bad_request", message: `this browser is not one ${BRAND.productName} streams` });
    return null;
  }
  return { principalId, scope: scopeId("personal", principalId), session };
}

async function paneFrame(ctx: ApiCtx): Promise<void> {
  const t = await paneTarget(ctx);
  if (!t) return;
  const r = await runInOwnSandbox(ctx, t.scope, "frame");
  if (!r || r.code !== 0 || !r.stdout.trim()) {
    return sendJson(ctx.res, 503, { error: "unavailable", message: "could not read the browser just now" });
  }
  try {
    return sendJson(ctx.res, 200, JSON.parse(r.stdout));
  } catch {
    return sendJson(ctx.res, 503, { error: "unavailable", message: "the browser sent something unreadable" });
  }
}

async function paneInput(ctx: ApiCtx): Promise<void> {
  const t = await paneTarget(ctx);
  if (!t) return;
  // Input from the pane is only ever the person's, and they only have input to
  // give once they have taken the wheel. Accepting it while the agent is
  // driving is the same two-writers problem from the other side.
  if (t.session.controlMode !== "human_control") {
    return sendJson(ctx.res, 409, {
      error: "conflict",
      message: "take control of the browser before driving it",
    });
  }
  const b = isObj(ctx.body) ? ctx.body : {};
  const kind = typeof b.kind === "string" ? b.kind : "";
  let args = "";
  if (kind === "click") {
    const x = Number(b.x);
    const y = Number(b.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: "a click needs x and y" });
    }
    args = `click --at ${Math.round(x)},${Math.round(y)}`;
  } else if (kind === "type") {
    const text = typeof b.text === "string" ? b.text : "";
    if (!text) return sendJson(ctx.res, 400, { error: "bad_request", message: "nothing to type" });
    // Base64 so a person's keystrokes never have to survive a shell.
    args = `type --text-b64 ${Buffer.from(text, "utf8").toString("base64")}`;
  } else if (kind === "key") {
    const name = typeof b.name === "string" ? b.name : "";
    if (!/^[A-Za-z]{1,12}$/.test(name)) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: "unknown key" });
    }
    args = `key ${name}`;
  } else if (kind === "scroll") {
    const by = Number(b.by);
    if (!Number.isFinite(by)) return sendJson(ctx.res, 400, { error: "bad_request", message: "a scroll needs by" });
    args = `scroll --by ${Math.round(by)}`;
  } else {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "kind must be click, type, key or scroll" });
  }

  const r = await runInOwnSandbox(ctx, t.scope, `--from-pane ${args}`);
  if (!r || r.code !== 0) {
    return sendJson(ctx.res, 503, { error: "unavailable", message: "the browser did not take that just now" });
  }
  return sendJson(ctx.res, 200, { ok: true });
}

export const browserSessionRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/browser-sessions", auth: "either", handle: registerSession },
  { method: "GET", path: "/v1/browser-sessions/current", auth: "either", handle: currentSession },
  { method: "GET", path: "/v1/browser-sessions/:id/state", auth: "either", handle: sessionState },
  { method: "POST", path: "/v1/browser-sessions/:id/handoff", auth: "either", handle: handoff },
  { method: "GET", path: "/v1/browser-sessions/:id/frame", auth: "either", handle: paneFrame },
  { method: "POST", path: "/v1/browser-sessions/:id/input", auth: "either", handle: paneInput },
  { method: "DELETE", path: "/v1/browser-sessions/:id", auth: "either", handle: endSession },
];
