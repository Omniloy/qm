import { sendJson } from "../../http.ts";
import { errMessage } from "../../../util/errors.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

/**
 * Signing a ChatGPT account in to the Codex proxy.
 *
 * The proxy owns the credential and refreshes it; core only starts the OAuth
 * flow, hands back the code, and reads which account is connected. No ChatGPT
 * token passes through here, which is why there is no store behind these
 * routes — the proxy's auth directory is the record.
 *
 * The sign-in ends at `http://localhost:1455`, an address baked into OpenAI's
 * client. The proxy is on the server, so nothing answers there and the browser
 * shows a connection error with the code in the URL bar. That is expected, and
 * the reason `complete` takes a pasted URL rather than a redirect.
 */

/** How long the proxy holds a pending login before it forgets the state. */
const LOGIN_TTL_MS = 5 * 60_000;

async function actor(ctx: ApiCtx) {
  return authorizeAdmin(ctx, orgScope(ctx.deps));
}

interface ProxyCall {
  status: number;
  body: unknown;
}

async function callProxy(ctx: ApiCtx, path: string, init?: RequestInit): Promise<ProxyCall | null> {
  const proxy = ctx.deps.codexProxy;
  if (!proxy) return null;
  const r = await fetch(new URL(path, proxy.url), {
    ...init,
    headers: { ...init?.headers, "X-Management-Key": proxy.managementKey },
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

function unavailable(ctx: ApiCtx): void {
  return sendJson(ctx.res, 503, {
    error: "unavailable",
    message: "No ChatGPT proxy is configured on this instance.",
  });
}

interface AuthFile {
  name?: unknown;
  provider?: unknown;
  status?: unknown;
  disabled?: unknown;
  email?: unknown;
}

export async function getCodexAuth(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  let call: ProxyCall | null;
  try {
    call = await callProxy(ctx, "/v0/management/auth-files");
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "proxy_unreachable", message: errMessage(e) });
  }
  if (!call) return unavailable(ctx);
  if (call.status !== 200) {
    return sendJson(ctx.res, 502, { error: "proxy_error", message: `the proxy answered ${call.status}` });
  }
  const files = ((call.body as { files?: unknown })?.files ?? []) as AuthFile[];
  // Only the Codex accounts, and only what an operator needs to see: which
  // account is connected and whether it still works. Never the file itself.
  const accounts = files
    .filter((f) => f.provider === "codex")
    .map((f) => ({
      name: String(f.name ?? ""),
      email: typeof f.email === "string" ? f.email : undefined,
      status: String(f.status ?? "unknown"),
      disabled: Boolean(f.disabled),
    }));
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "codex-auth.read",
    resource: "codex-auth",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { accounts });
}

export async function startCodexAuth(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  let call: ProxyCall | null;
  try {
    call = await callProxy(ctx, "/v0/management/codex-auth-url");
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "proxy_unreachable", message: errMessage(e) });
  }
  if (!call) return unavailable(ctx);
  const body = call.body as { url?: unknown; state?: unknown };
  if (call.status !== 200 || typeof body?.url !== "string" || typeof body?.state !== "string") {
    return sendJson(ctx.res, 502, { error: "proxy_error", message: `the proxy answered ${call.status}` });
  }
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "codex-auth.start",
    resource: "codex-auth",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { url: body.url, state: body.state, expiresAt: Date.now() + LOGIN_TTL_MS });
}

/**
 * Pull the code and state out of whatever the operator pasted.
 *
 * They are copying out of a browser that failed to connect, so accept the whole
 * URL, a bare query string, or the two values on their own.
 */
export function parseCodexCallback(input: string): { code: string; state: string } | null {
  const text = input.trim();
  if (!text) return null;
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const state = params.get("state");
  return code && state ? { code, state } : null;
}

export async function completeCodexAuth(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  const raw = (ctx.body as { callback?: unknown })?.callback;
  if (typeof raw !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "Paste the address the sign-in ended on." });
  }
  const parsed = parseCodexCallback(raw);
  if (!parsed) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "That address carries no sign-in code. Copy the whole localhost address the browser landed on.",
    });
  }
  let call: ProxyCall | null;
  try {
    call = await callProxy(ctx, "/v0/management/oauth-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex", state: parsed.state, code: parsed.code }),
    });
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "proxy_unreachable", message: errMessage(e) });
  }
  if (!call) return unavailable(ctx);
  if (call.status !== 200) {
    // The pending login is held in memory for five minutes, and this is what
    // taking longer than that looks like from here.
    const expired = call.status === 404;
    return sendJson(ctx.res, 400, {
      error: expired ? "expired" : "proxy_error",
      message: expired
        ? "That sign-in expired. Start again — the link is good for five minutes."
        : `The proxy refused the code (${call.status}).`,
    });
  }
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "codex-auth.complete",
    resource: "codex-auth",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}

export async function deleteCodexAuth(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  // A query parameter rather than a body: the admin plugin forwards DELETE
  // without one, so a body here would arrive empty.
  const name = ctx.url.searchParams.get("name");
  if (!name) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "Which account to sign out is required." });
  }
  let call: ProxyCall | null;
  try {
    call = await callProxy(ctx, `/v0/management/auth-files?name=${encodeURIComponent(name)}`, { method: "DELETE" });
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "proxy_unreachable", message: errMessage(e) });
  }
  if (!call) return unavailable(ctx);
  if (call.status !== 200) {
    return sendJson(ctx.res, 502, { error: "proxy_error", message: `the proxy answered ${call.status}` });
  }
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "codex-auth.delete",
    resource: name,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
