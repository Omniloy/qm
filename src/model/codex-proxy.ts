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

function accountResetAt(statusMessage: unknown, now: number): number | undefined {
  if (typeof statusMessage !== "string") return undefined;
  try {
    const error = (JSON.parse(statusMessage) as { error?: { resets_at?: unknown; resets_in_seconds?: unknown } })
      ?.error;
    if (typeof error?.resets_at === "number") return error.resets_at * 1000;
    if (typeof error?.resets_in_seconds === "number") return now + error.resets_in_seconds * 1000;
  } catch {
    return undefined;
  }
  return undefined;
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
      .map((f: { status_message?: unknown }) => accountResetAt(f.status_message, now))
      .filter((at): at is number => at !== undefined && at > now);
    return resets.length ? Math.min(...resets) : undefined;
  } catch (e) {
    swallow("codex proxy: usage reset lookup", e);
    return undefined;
  }
}
