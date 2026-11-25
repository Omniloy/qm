import { randomBytes } from "node:crypto";
import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import {
  IALABS_TIMEOUT_MS,
  IalabsInvalidTokenError,
  IalabsRejectedError,
  IalabsUnavailableError,
  refreshIalabsTokens,
  revokeIalabsToken,
  verifyIalabsAccessToken,
  type IalabsConfig,
} from "./oidc.ts";

type FetchLike = typeof fetch;

export type IalabsSessionState = "ok" | "reauth" | "gone" | "unavailable";

type Claim =
  | { state: "missing" }
  | { state: "current" | "busy"; principal: string; expiresAtMs: number }
  | { state: "claimed"; principal: string; expiresAtMs: number; lease: string; refreshToken: string };

type Known = { principal: string; expiresAtMs: number };

interface IalabsSessionOptions {
  core: string;
  signingSecret: string | undefined;
  ialabs: IalabsConfig;
  refreshAfterMs: number;
  reauthBeforeMs: number;
  fetchImpl?: FetchLike;
  pollMs?: number;
  busyWaitMs?: number;
  settleRetryMs?: number;
}

const CORE_TIMEOUT_MS = 4_000;
const VERIFIED_TTL_MS = 60_000;
const SETTLE_ATTEMPTS = 3;

class CoreUnavailableError extends Error {}

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function createIalabsSessions(opts: IalabsSessionOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 250;
  const busyWaitMs = opts.busyWaitMs ?? 5_000;
  const settleRetryMs = opts.settleRetryMs ?? 500;
  const leaseMs = (opts.ialabs.timeoutMs ?? IALABS_TIMEOUT_MS) * 2 + 10_000;
  const verifiedTtlMs = Math.min(VERIFIED_TTL_MS, opts.refreshAfterMs);
  const verified = new LRUCache<string, Known>({ max: 10_000, ttl: verifiedTtlMs });
  const inflight = new Map<string, Promise<Known | null>>();

  async function core<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const path = withSourceAuthNonce(`/v1/auth/portal-sessions${action}`, opts.signingSecret);
    const raw = JSON.stringify(body);
    let r: Response;
    try {
      r = await fetch(`${opts.core}${path}`, {
        method: "POST",
        headers: signedHeaders(opts.signingSecret, "POST", path, raw),
        body: raw,
        signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CoreUnavailableError(`core portal-session store unreachable: ${errMessage(error)}`);
    }
    if (!r.ok) throw new CoreUnavailableError(`core portal-session store answered HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  async function settle(sid: string, lease: string, outcome: Record<string, unknown>): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        return (await core<{ settled: boolean }>("/settle", { sessionId: sid, lease, ...outcome })).settled;
      } catch (error) {
        if (!(error instanceof CoreUnavailableError) || attempt >= SETTLE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, settleRetryMs * attempt));
      }
    }
  }

  async function revoked(sid: string, lease: string, refreshToken?: string): Promise<null> {
    await settle(sid, lease, { outcome: "revoked" });
    if (refreshToken) {
      await revokeIalabsToken(opts.ialabs, refreshToken, fetchImpl).catch((error: unknown) => {
        console.warn(`[portal] ialabs revoke failed: ${errMessage(error)}`);
      });
    }
    return null;
  }

  async function refresh(sid: string, claim: Extract<Claim, { state: "claimed" }>): Promise<Known | null> {
    const previous = { principal: claim.principal, expiresAtMs: claim.expiresAtMs };
    let tokens;
    try {
      tokens = await refreshIalabsTokens(opts.ialabs, claim.refreshToken, fetchImpl);
    } catch (error) {
      if (error instanceof IalabsRejectedError) return revoked(sid, claim.lease);
      if (error instanceof IalabsUnavailableError) {
        console.warn(`[portal] ialabs refresh deferred: ${error.message}`);
        await settle(sid, claim.lease, { outcome: "unavailable", retryAfterMs: error.retryAfterMs });
        return previous;
      }
      console.warn(`[portal] ialabs refresh outcome unknown, holding the lease: ${errMessage(error)}`);
      verified.set(sid, previous, { ttl: leaseMs });
      return previous;
    }
    try {
      const identity = await verifyIalabsAccessToken(opts.ialabs, tokens.accessToken, fetchImpl);
      if (identity.email !== claim.principal) throw new IalabsInvalidTokenError("the token names another person");
    } catch (error) {
      if (error instanceof IalabsInvalidTokenError) {
        console.warn(`[portal] ialabs refresh returned an unacceptable token: ${error.message}`);
        return revoked(sid, claim.lease, tokens.refreshToken);
      }
      console.warn(`[portal] ialabs refreshed token not verified yet: ${errMessage(error)}`);
    }
    const known = { principal: claim.principal, expiresAtMs: tokens.refreshExpiresAtMs };
    try {
      await settle(sid, claim.lease, {
        outcome: "rotated",
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.refreshExpiresAtMs,
      });
    } catch (error) {
      console.error(`[portal] could not store the rotated ialabs token: ${errMessage(error)}`);
      verified.set(sid, known, { ttl: leaseMs });
      return known;
    }
    verified.set(sid, known);
    return known;
  }

  async function check(sid: string): Promise<Known | null> {
    const deadline = Date.now() + busyWaitMs;
    for (;;) {
      const claim = await core<Claim>("/claim", { sessionId: sid, leaseMs });
      if (claim.state === "missing") return null;
      if (claim.state === "claimed") return refresh(sid, claim);
      const known = { principal: claim.principal, expiresAtMs: claim.expiresAtMs };
      if (claim.state === "current") {
        verified.set(sid, known);
        return known;
      }
      if (Date.now() >= deadline) {
        verified.set(sid, known, { ttl: Math.min(verifiedTtlMs, 10_000) });
        return known;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  const judged = (known: Known | null, sub: string, page: boolean, authenticatedAtMs: number): IalabsSessionState => {
    if (!known || known.principal !== sub) return "gone";
    const window = Math.min(opts.reauthBeforeMs, Math.max(0, (known.expiresAtMs - authenticatedAtMs) / 2));
    return page && Date.now() >= known.expiresAtMs - window ? "reauth" : "ok";
  };

  return {
    async start(sid: string, principal: string, refreshToken: string, expiresAtMs: number): Promise<void> {
      await core("", { sessionId: sid, principal, refreshToken, expiresAtMs, refreshAfterMs: opts.refreshAfterMs });
      verified.set(sid, { principal, expiresAtMs });
    },

    async state(sid: string, sub: string, page: boolean, authenticatedAtMs: number): Promise<IalabsSessionState> {
      const hit = verified.get(sid);
      if (hit) return judged(hit, sub, page, authenticatedAtMs);
      let pending = inflight.get(sid);
      if (!pending) {
        pending = check(sid).finally(() => inflight.delete(sid));
        inflight.set(sid, pending);
      }
      try {
        return judged(await pending, sub, page, authenticatedAtMs);
      } catch (error) {
        if (!(error instanceof CoreUnavailableError)) throw error;
        console.warn(`[portal] ${error.message}`);
        return "unavailable";
      }
    },

    async end(sid: string): Promise<void> {
      verified.delete(sid);
      const { refreshToken } = await core<{ refreshToken: string | null }>("/end", { sessionId: sid });
      if (!refreshToken) return;
      await revokeIalabsToken(opts.ialabs, refreshToken, fetchImpl).catch((error: unknown) => {
        console.warn(`[portal] ialabs revoke failed: ${errMessage(error)}`);
      });
    },
  };
}

export type IalabsSessions = ReturnType<typeof createIalabsSessions>;
