import { isHarnessId, type HarnessId } from "../../../model/pi-models.ts";
import { claudeSubscriptionTokenProblem } from "../../../credentials/harness-auth-store.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

/** Harnesses that sign in as an account rather than billing a provider key. */
const SUBSCRIPTION_HARNESSES = new Set<HarnessId>(["claude"]);

async function actor(ctx: ApiCtx) {
  return authorizeAdmin(ctx, orgScope(ctx.deps));
}

function harnessParam(ctx: ApiCtx): HarnessId | null {
  const value = ctx.params.harness;
  return isHarnessId(value) && SUBSCRIPTION_HARNESSES.has(value) ? value : null;
}

export async function getHarnessAuth(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.harnessAuth) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "harness-auth.read",
    resource: "harness-auth",
    scopeLabel: orgScope(ctx.deps),
  });
  const statuses = await Promise.all([...SUBSCRIPTION_HARNESSES].map((id) => ctx.deps.harnessAuth!.status(id)));
  // Statuses carry who and when, never the token itself.
  return sendJson(ctx.res, 200, { harnesses: statuses });
}

export async function putHarnessAuth(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.harnessAuth) return sendJson(ctx.res, 404, { error: "not_found" });
  const harnessId = harnessParam(ctx);
  if (!harnessId) return sendJson(ctx.res, 404, { error: "not_found" });
  const token = (ctx.body as { token?: unknown }).token;
  if (typeof token !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "A token is required" });
  }
  const problem = claudeSubscriptionTokenProblem(token);
  if (problem) return sendJson(ctx.res, 400, { error: "invalid_token", message: problem });
  // Prove the credential before storing it: a token that only fails on the
  // next agent run reads as a broken agent, not as a bad paste.
  const runProbe = ctx.deps.harnessAuthProbe;
  if (!runProbe) {
    return sendJson(ctx.res, 503, {
      error: "unavailable",
      message: "This instance cannot verify a subscription token.",
    });
  }
  const probe = await runProbe(token.trim());
  if (!probe.ok) {
    return sendJson(ctx.res, 400, {
      error: "invalid_token",
      message: probe.detail ?? "Claude rejected this token.",
    });
  }
  await ctx.deps.harnessAuth.set(harnessId, token.trim(), authorized.id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "harness-auth.update",
    resource: harnessId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, status: await ctx.deps.harnessAuth.status(harnessId) });
}

export async function deleteHarnessAuth(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.harnessAuth) return sendJson(ctx.res, 404, { error: "not_found" });
  const harnessId = harnessParam(ctx);
  if (!harnessId) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.harnessAuth.delete(harnessId, authorized.id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "harness-auth.delete",
    resource: harnessId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
