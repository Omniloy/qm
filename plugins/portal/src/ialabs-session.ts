import { randomBytes } from "node:crypto";
import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { IalabsRejectedError, refreshIalabsTokens, revokeIalabsToken, type IalabsConfig } from "./oidc.ts";

type FetchLike = typeof fetch;

export type IalabsSessionState = "ok" | "reauth" | "gone" | "unavailable";

type Claim =
  | { state: "missing" }
  | { state: "current" | "busy"; principal: string; expiresAtMs: number }
  | { state: "claimed"; principal: string; expiresAtMs: number; lease: string; refreshToken: string };

type Known = { principal: string; expiresAtMs: number };

export interface IalabsSessionOptions {
  core: string;
  signingSecret: string | undefined;
  ialabs: IalabsConfig;
  refreshAfterMs: number;
  reauthBeforeMs: number;
  fetchImpl?: FetchLike;
  pollMs?: number;
}

const CORE_TIMEOUT_MS = 4_000;
const LEASE_MS = 30_000;
const VERIFIED_TTL_MS = 60_000;

export class CoreUnavailableError extends Error {}

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function createIalabsSessions(opts: IalabsSessionOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 250;
  const verified = new LRUCache<string, Known>({
    max: 10_000,
    ttl: Math.min(VERIFIED_TTL_MS, opts.refreshAfterMs),
  });
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

  async function refresh(sid: string, claim: Extract<Claim, { state: "claimed" }>): Promise<Known | null> {
    const settle = (outcome: Record<string, unknown>) =>
      core<{ settled: boolean }>("/settle", { sessionId: sid, lease: claim.lease, ...outcome });
    let tokens;
    try {
      tokens = await refreshIalabsTokens(opts.ialabs, claim.refreshToken, fetchImpl);
    } catch (error) {
      if (error instanceof IalabsRejectedError) {
        await settle({ outcome: "revoked" });
        return null;
      }
      console.warn(`[portal] ialabs refresh deferred: ${errMessage(error)}`);
      await settle({ outcome: "unavailable" });
      return { principal: claim.principal, expiresAtMs: claim.expiresAtMs };
    }
    await settle({ outcome: "rotated", refreshToken: tokens.refreshToken, expiresAtMs: tokens.refreshExpiresAtMs });
    const known = { principal: claim.principal, expiresAtMs: tokens.refreshExpiresAtMs };
    verified.set(sid, known);
    return known;
  }

  async function check(sid: string): Promise<Known | null> {
    const deadline = Date.now() + LEASE_MS;
    for (;;) {
      const claim = await core<Claim>("/claim", {
        sessionId: sid,
        staleAfterMs: opts.refreshAfterMs,
        leaseMs: LEASE_MS,
      });
      if (claim.state === "missing") return null;
      if (claim.state === "claimed") return refresh(sid, claim);
      const known = { principal: claim.principal, expiresAtMs: claim.expiresAtMs };
      if (claim.state === "current") {
        verified.set(sid, known);
        return known;
      }
      if (Date.now() >= deadline) return known;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  const judged = (known: Known | null, sub: string, page: boolean): IalabsSessionState => {
    if (!known || known.principal !== sub) return "gone";
    return page && Date.now() >= known.expiresAtMs - opts.reauthBeforeMs ? "reauth" : "ok";
  };

  return {
    async start(sid: string, principal: string, refreshToken: string, expiresAtMs: number): Promise<void> {
      await core("", { sessionId: sid, principal, refreshToken, expiresAtMs });
      verified.set(sid, { principal, expiresAtMs });
    },

    async state(sid: string, sub: string, page: boolean): Promise<IalabsSessionState> {
      const hit = verified.get(sid);
      if (hit) return judged(hit, sub, page);
      let pending = inflight.get(sid);
      if (!pending) {
        pending = check(sid).finally(() => inflight.delete(sid));
        inflight.set(sid, pending);
      }
      try {
        return judged(await pending, sub, page);
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
