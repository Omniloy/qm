import { codexProxyResetAt, type CodexProxy } from "../model/codex-proxy.ts";
import { headSlice } from "../util/text.ts";

export class NonRetryableTurnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableTurnError";
  }
}

export class TitleRejected extends Error {
  readonly rule: string;
  constructor(rule: string, sample: string) {
    super(`${rule}: ${JSON.stringify(headSlice(sample, 80))}`);
    this.name = "TitleRejected";
    this.rule = rule;
  }
}

export type TurnFailurePayload = { kind: "turn_failure"; message: string; runId?: string };

const GENERIC_TURN_FAILURE = "That turn failed and couldn't be completed. The details are in the operator error log.";

export interface ProviderLimit {
  kind: "usage" | "rate";
  provider?: string;
  model?: string;
  viaCodexProxy: boolean;
  subscription?: string;
  resetAt?: number;
}

const USAGE_LIMIT_CODE = /model_cooldown|usage_limit_reached/;
const RATE_LIMIT_CODE = /rate_limit_error|API error \(429\)/;
const BILLING_CODE = /insufficient_quota|billing_hard_limit/;
const TRANSIENT_RESET_MS = 60_000;

function resetAtFrom(text: string, now: number): number | undefined {
  const at = /resets_at\W{0,3}(\d+)/.exec(text)?.[1];
  if (at) return Number(at) * 1000;
  const inSeconds = /(?:resets_in_seconds|reset_seconds)\W{0,3}(\d+)/.exec(text)?.[1];
  return inSeconds ? now + Number(inSeconds) * 1000 : undefined;
}

function providerFrom(text: string): string | undefined {
  if (/anthropic|claude|rate_limit_error/i.test(text)) return "Anthropic";
  if (/openai|codex|chatgpt|\bgpt-/i.test(text)) return "OpenAI";
  return undefined;
}

export function providerLimit(err: unknown, fallbackModel?: string, now = Date.now()): ProviderLimit | null {
  const text = err instanceof Error ? err.message : String(err);
  const usage = USAGE_LIMIT_CODE.test(text);
  if (!usage && (!RATE_LIMIT_CODE.test(text) || BILLING_CODE.test(text))) return null;
  const model = /for model ([\w:/-]+(?:\.[\w:/-]+)*)/.exec(text)?.[1] ?? fallbackModel;
  const viaCodexProxy = /model_cooldown|via provider codex/.test(text);
  const provider = providerFrom(`${text} ${model ?? ""}`);
  const resetAt = resetAtFrom(text, now);
  return {
    kind: usage ? "usage" : "rate",
    viaCodexProxy,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(provider === "OpenAI" && (viaCodexProxy || /plan_type/.test(text))
      ? { subscription: "the connected ChatGPT subscription" }
      : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

function resetsIn(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
  return `in about ${Math.round(hours / 24)} days`;
}

function utcLabel(epochMs: number): string {
  const [weekday = "", day = "", month = "", , time = ""] = new Date(epochMs).toUTCString().split(" ");
  return `${weekday.slice(0, 3)} ${Number(day)} ${month}, ${time.slice(0, 5)} UTC`;
}

export function providerLimitMessage(limit: ProviderLimit, now = Date.now()): string {
  const owner = limit.provider ? `the ${limit.provider}` : "the model provider's";
  const head =
    `You've reached ${owner} ${limit.kind} limit` +
    (limit.model ? ` for ${limit.model}` : "") +
    (limit.subscription ? ` on ${limit.subscription}` : "") +
    ".";
  if (limit.resetAt && limit.resetAt > now)
    return `${head} It resets ${resetsIn(limit.resetAt - now)} (${utcLabel(limit.resetAt)}). Pick another model to keep working now.`;
  return `${head} Try again later or pick another model.`;
}

export async function settleProviderLimit(
  err: unknown,
  opts: { model?: string; codexProxy?: CodexProxy },
): Promise<unknown> {
  const limit = providerLimit(err, opts.model);
  if (!limit) return err;
  const resetAt =
    limit.resetAt ?? (limit.viaCodexProxy && opts.codexProxy ? await codexProxyResetAt(opts.codexProxy) : undefined);
  const settled = resetAt ? { ...limit, resetAt } : limit;
  const now = Date.now();
  const transient = settled.resetAt ? settled.resetAt - now <= TRANSIENT_RESET_MS : settled.kind === "rate";
  if (transient) return err;
  return new NonRetryableTurnError(providerLimitMessage(settled, now), { cause: err });
}

export function turnFailureMessage(err: unknown): string {
  const limit = providerLimit(err);
  if (limit) return providerLimitMessage(limit);
  return err instanceof NonRetryableTurnError && err.message.trim() ? err.message : GENERIC_TURN_FAILURE;
}
