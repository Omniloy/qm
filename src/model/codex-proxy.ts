import { swallow } from "../util/errors.ts";

export interface CodexProxy {
  url: string;
  managementKey: string;
}

export interface CodexProxyCall {
  status: number;
  body: unknown;
}

const RESET_LOOKUP_TIMEOUT_MS = 2_000;

export async function callCodexProxy(proxy: CodexProxy, path: string, init?: RequestInit): Promise<CodexProxyCall> {
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

interface CodexAccountState {
  planType?: string;
  limitReached: boolean;
  limitWindowMinutes?: number;
  resetsAt?: number;
}

interface StatusError {
  type?: unknown;
  plan_type?: unknown;
  limit_window_minutes?: unknown;
  resets_at?: unknown;
  resets_in_seconds?: unknown;
}

const PLAN_TYPE = /^[a-z][a-z0-9_]{0,31}$/;

function statusError(statusMessage: unknown): StatusError | undefined {
  if (typeof statusMessage !== "string") return undefined;
  try {
    const error = (JSON.parse(statusMessage) as { error?: unknown })?.error;
    return error && typeof error === "object" ? (error as StatusError) : undefined;
  } catch {
    return undefined;
  }
}

function resetTime(error: StatusError | undefined, now: number): number | undefined {
  if (typeof error?.resets_at === "number") return error.resets_at * 1000;
  if (typeof error?.resets_in_seconds === "number") return now + error.resets_in_seconds * 1000;
  return undefined;
}

export function codexAccountState(statusMessage: unknown, now: number): CodexAccountState {
  const error = statusError(statusMessage);
  const window = error?.limit_window_minutes;
  const resetsAt = resetTime(error, now);
  return {
    ...(typeof error?.plan_type === "string" && PLAN_TYPE.test(error.plan_type) ? { planType: error.plan_type } : {}),
    limitReached: error?.type === "usage_limit_reached",
    ...(typeof window === "number" && Number.isInteger(window) && window > 0 ? { limitWindowMinutes: window } : {}),
    ...(resetsAt !== undefined && Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

export async function codexProxyResetAt(
  proxy: CodexProxy,
  timeoutMs = RESET_LOOKUP_TIMEOUT_MS,
): Promise<number | undefined> {
  try {
    const call = await callCodexProxy(proxy, "/v0/management/auth-files", { signal: AbortSignal.timeout(timeoutMs) });
    if (call.status !== 200) return undefined;
    const now = Date.now();
    const files = (call.body as { files?: unknown })?.files;
    const resets = (Array.isArray(files) ? files : [])
      .filter((f: { provider?: unknown }) => f?.provider === "codex")
      .map((f: { status_message?: unknown }) => codexAccountState(f.status_message, now).resetsAt)
      .filter((at): at is number => at !== undefined && at > now);
    return resets.length ? Math.min(...resets) : undefined;
  } catch (e) {
    swallow("codex proxy: usage reset lookup", e);
    return undefined;
  }
}
