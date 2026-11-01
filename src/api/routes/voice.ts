import { scopeId } from "../../types.ts";
import { countTokens } from "../../util/tokens.ts";
import { swallow } from "../../util/errors.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { HarnessVoiceReplyEvent } from "../../harness/harness.ts";
import {
  parseVoiceReplyRequest,
  voiceCandidates,
  voiceSystemPrompt,
  VOICE_MAX_OUTPUT_TOKENS,
  VOICE_TOOLS,
} from "../../voice/voice-reply.ts";
import type { ApiCtx, Route } from "./route.ts";

const VOICE_THREAD_PREFIX = "voice:";

function voicePrincipal(ctx: ApiCtx, asserted: unknown): string | null {
  if (ctx.capability) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "voice requires a person, not an agent capability" });
    return null;
  }
  const principalId = ctx.actor?.p ?? (typeof asserted === "string" ? asserted.trim() : "");
  if (principalId) return principalId;
  sendJson(ctx.res, 403, { error: "forbidden", message: "voice needs a principalId" });
  return null;
}

async function voiceEnabled(ctx: ApiCtx, principalId: string): Promise<boolean> {
  return (await ctx.deps.featureFlags?.enabled("voice_assistant", scopeId("personal", principalId))) === true;
}

async function access(ctx: ApiCtx): Promise<void> {
  const principalId = voicePrincipal(ctx, ctx.url.searchParams.get("principalId"));
  if (!principalId) return;
  sendJson(ctx.res, 200, { enabled: await voiceEnabled(ctx, principalId) });
}

async function reply(ctx: ApiCtx): Promise<void> {
  const { deps, res, req } = ctx;
  const principalId = voicePrincipal(ctx, isObj(ctx.body) ? ctx.body.principalId : undefined);
  if (!principalId) return;
  if (!(await voiceEnabled(ctx, principalId))) return sendJson(res, 403, { error: "feature_disabled" });
  const request = parseVoiceReplyRequest(ctx.body);
  if (!request) return sendJson(res, 400, { error: "invalid_request" });
  const stream = deps.streamVoiceReply;
  if (!stream) return sendJson(res, 409, { error: "voice_model_unsupported" });
  const rate = await deps.rateLimiter?.check(`voice:${principalId}`);
  if (rate && !rate.allowed) return sendJson(res, 429, { error: "rate_limited" });
  if (deps.budget && !(await deps.budget.check(principalId)).allowed)
    return sendJson(res, 429, { error: "over_budget" });
  const candidates = await voiceCandidates(deps, principalId);
  const scope = scopeId("personal", principalId);
  const systemPrompt = voiceSystemPrompt(request);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  res.on("close", abort);
  req.on("error", () => res.destroy());
  const events = stream({
    candidates,
    systemPrompt,
    messages: request.messages,
    tools: request.tools ? VOICE_TOOLS : [],
    maxTokens: VOICE_MAX_OUTPUT_TOKENS,
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  try {
    const first = await events.next();
    if (first.done || first.value.type !== "start") return sendJson(res, 409, { error: "voice_model_unsupported" });
    const inputTokens = countTokens(systemPrompt) + countTokens(JSON.stringify(request.messages));
    void deps.budget?.record(principalId, estimateCostUsd(inputTokens));
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (frame: unknown): void => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    let end: Extract<HarnessVoiceReplyEvent, { type: "end" }> | undefined;
    try {
      for (let next = await events.next(); !next.done; next = await events.next()) {
        const event = next.value;
        if (event.type === "delta") send({ type: "delta", text: event.text });
        else if (event.type === "tool_call")
          send({ type: "tool_call", id: event.id, name: event.name, args: event.args });
        else if (event.type === "end") end = event;
      }
    } catch (err) {
      swallow("voice: reply stream", err);
    }
    deps.modelGateway?.recordCall({
      at: Date.now(),
      scopeLabel: scope,
      model: end?.modelId ?? first.value.modelId,
      inputTokens,
      entryCount: request.messages.length,
    });
    await recordVoiceUsage(ctx, principalId, end);
    if (!end || end.outcome === "error") send({ type: "error", reason: "upstream_error" });
    else if (end.outcome === "aborted") send({ type: "error", reason: "aborted" });
    else
      send({
        type: "done",
        model: end.modelId,
        ...(end.usage ? { usage: { input: end.usage.input, output: end.usage.output } } : {}),
      });
    res.end();
  } finally {
    res.off("close", abort);
    await events.return?.();
  }
}

async function recordVoiceUsage(
  ctx: ApiCtx,
  principalId: string,
  end: Extract<HarnessVoiceReplyEvent, { type: "end" }> | undefined,
): Promise<void> {
  const sessions = ctx.deps.sessions;
  if (!sessions || !end?.usage) return;
  const scope = scopeId("personal", principalId);
  try {
    const session = await sessions.getOrCreateByThread(
      `${VOICE_THREAD_PREFIX}${principalId}`,
      "dm",
      scope,
      undefined,
      "web",
    );
    await sessions.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: end.modelId,
      scopeLabel: scope,
      truncated: false,
      ttftMs: end.ttftMs,
      durationMs: end.durationMs,
      usage: end.usage,
    });
  } catch (err) {
    swallow("voice: record usage", err);
  }
}

export const voiceRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/voice/access", auth: "source", handle: access },
  { method: "POST", path: "/v1/voice/reply", auth: "source", handle: reply },
];
