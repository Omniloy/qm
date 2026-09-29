import { decryptSecret, encryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import { personKey } from "../directory/person.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { hashId } from "../util/crypto.ts";
import { errMessage, swallow } from "../util/errors.ts";
import {
  isPermanentOAuthFailure,
  refreshAccessToken,
  type McpOAuthNet,
  type McpOAuthRegistration,
  type McpTokenSet,
} from "./mcp-oauth.ts";

const REFRESH_SKEW_MS = 60_000;
const MAX_REFRESH_ERROR_CHARS = 300;

export interface McpOAuthClient extends Omit<McpOAuthRegistration, "clientSecret" | "registrationAccessToken"> {
  clientSecretEnc?: string;
  registrationAccessTokenEnc?: string;
}

export interface McpUserToken {
  serverId: string;
  principalId: string;
  clientId: string;
  accessTokenEnc: string;
  refreshTokenEnc?: string;
  expiresAt?: number;
  scope?: string;
  fingerprint: string;
  connectedAt: number;
  updatedAt: number;
  refreshFailedAt?: number;
  refreshError?: string;
}

export interface McpCatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCatalog {
  serverId: string;
  tools: McpCatalogTool[];
  fetchedAt: number;
  fetchedBy: string;
}

interface McpTokenStatus {
  connected: boolean;
  needsReconnect?: boolean;
  refreshFailedAt?: number;
  refreshError?: string;
  expiresAt?: number;
}

interface McpOAuthClientStore {
  get(serverId: string): Promise<McpOAuthRegistration | null>;
  put(registration: McpOAuthRegistration): Promise<void>;
  delete(serverId: string): Promise<void>;
}

export interface McpUserTokenStore {
  set(serverId: string, principalId: string, tokens: McpTokenSet, clientId: string): Promise<void>;
  status(serverId: string, principalId: string): Promise<McpTokenStatus>;
  delete(serverId: string, principalId: string): Promise<McpTokenSet | null>;
  deleteAllForServer(serverId: string): Promise<void>;
  accessToken(serverId: string, principalId: string): Promise<string | null>;
  forceRefresh(serverId: string, principalId: string): Promise<string | null>;
  markNeedsReconnect(serverId: string, principalId: string, rejectedToken: string, reason: string): Promise<void>;
}

export interface McpCatalogStore {
  get(serverId: string): Promise<McpCatalog | null>;
  put(catalog: McpCatalog): Promise<void>;
  delete(serverId: string): Promise<void>;
}

export interface McpOAuthStores {
  clients: McpOAuthClientStore;
  tokens: McpUserTokenStore;
  catalogs: McpCatalogStore;
  net: McpOAuthNet;
}

export function clientRefFor(registration: Pick<McpOAuthRegistration, "serverId" | "clientId">): string {
  return `mcp:${registration.serverId}:${registration.clientId}`;
}

const fingerprintOf = (accessToken: string): string => hashId([accessToken]);

function storedError(e: unknown): string {
  const msg = errMessage(e).replace(/\s+/g, " ").trim();
  return msg.length > MAX_REFRESH_ERROR_CHARS ? `${msg.slice(0, MAX_REFRESH_ERROR_CHARS - 3)}...` : msg;
}

export function createMcpOAuthStores(deps: {
  clients: DurableMap<McpOAuthClient>;
  tokens: DurableMap<McpUserToken>;
  catalogs: DurableMap<McpCatalog>;
  key: SecretKey;
  lock: AdvisoryLock;
  net?: McpOAuthNet;
  now?: () => number;
}): McpOAuthStores {
  const now = deps.now ?? Date.now;
  const net = deps.net ?? {};
  const update = deps.tokens.update?.bind(deps.tokens);
  if (!update) throw new Error("MCP sign-in tokens need a store with atomic updates");
  const inflight = new Map<string, Promise<string | null>>();
  const tokenId = (serverId: string, principalId: string) => hashId([serverId, personKey(principalId)]);
  const decrypt = (enc: string, what: string): string | null => {
    try {
      return decryptSecret(enc, deps.key);
    } catch (e) {
      swallow(`mcp-oauth decrypt ${what}`, e);
      return null;
    }
  };

  const clients: McpOAuthClientStore = {
    async get(serverId) {
      const rec = await deps.clients.get(serverId);
      if (!rec) return null;
      const { clientSecretEnc, registrationAccessTokenEnc, ...rest } = rec;
      const clientSecret = clientSecretEnc ? decrypt(clientSecretEnc, `client ${serverId}`) : undefined;
      if (clientSecret === null) return null;
      const registrationAccessToken = registrationAccessTokenEnc
        ? decrypt(registrationAccessTokenEnc, `registration ${serverId}`)
        : undefined;
      return {
        ...rest,
        ...(clientSecret ? { clientSecret } : {}),
        ...(registrationAccessToken ? { registrationAccessToken } : {}),
      };
    },
    async put(registration) {
      const { clientSecret, registrationAccessToken, ...rest } = registration;
      await deps.clients.put(registration.serverId, {
        ...rest,
        ...(clientSecret ? { clientSecretEnc: encryptSecret(clientSecret, deps.key) } : {}),
        ...(registrationAccessToken
          ? { registrationAccessTokenEnc: encryptSecret(registrationAccessToken, deps.key) }
          : {}),
      });
    },
    delete: (serverId) => deps.clients.delete(serverId),
  };

  function record(
    serverId: string,
    principalId: string,
    tokens: McpTokenSet,
    clientId: string,
    prior?: McpUserToken | null,
  ): McpUserToken {
    const t = now();
    return {
      serverId,
      principalId,
      clientId,
      accessTokenEnc: encryptSecret(tokens.accessToken, deps.key),
      ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken, deps.key) } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      fingerprint: fingerprintOf(tokens.accessToken),
      connectedAt: prior?.connectedAt ?? t,
      updatedAt: t,
    };
  }

  const expired = (rec: McpUserToken) => rec.expiresAt !== undefined && now() >= rec.expiresAt - REFRESH_SKEW_MS;
  const usable = (rec: McpUserToken | null, client: McpOAuthRegistration): rec is McpUserToken =>
    !!rec && rec.clientId === client.clientId && rec.refreshFailedAt === undefined;
  const sameVersion = (a: McpUserToken, b: McpUserToken) =>
    a.fingerprint === b.fingerprint && a.updatedAt === b.updatedAt;
  const replaceIfUnchanged = (id: string, seen: McpUserToken, next: (current: McpUserToken) => McpUserToken) =>
    update(id, (current) => (sameVersion(current, seen) ? next(current) : current));

  async function rotate(id: string, stale: McpUserToken, client: McpOAuthRegistration): Promise<string | null> {
    return deps.lock.withLock(`mcp-token:${id}`, async () => {
      const current = await deps.tokens.get(id);
      if (!usable(current, client)) return null;
      if (!sameVersion(current, stale)) return currentAccessToken(id, current, client);
      const refreshToken = current.refreshTokenEnc ? decrypt(current.refreshTokenEnc, `refresh ${id}`) : null;
      if (!refreshToken) return null;
      let fresh: McpTokenSet;
      try {
        fresh = await refreshAccessToken(client, refreshToken, net);
      } catch (e) {
        if (!isPermanentOAuthFailure(e)) throw e;
        const failed = { ...current, refreshFailedAt: now(), refreshError: storedError(e) };
        return settled(id, await replaceIfUnchanged(id, current, () => failed), failed, null, client);
      }
      const rotated = record(
        current.serverId,
        current.principalId,
        { refreshToken, ...fresh },
        current.clientId,
        current,
      );
      return settled(id, await replaceIfUnchanged(id, current, () => rotated), rotated, fresh.accessToken, client);
    });
  }

  function settled(
    id: string,
    stored: McpUserToken | null,
    written: McpUserToken,
    result: string | null,
    client: McpOAuthRegistration,
  ): string | null {
    if (!stored) return null;
    return stored === written ? result : currentAccessToken(id, stored, client);
  }

  function currentAccessToken(id: string, rec: McpUserToken, client: McpOAuthRegistration): string | null {
    return usable(rec, client) && !expired(rec) ? decrypt(rec.accessTokenEnc, `token ${id}`) : null;
  }

  function refreshOnce(id: string, stale: McpUserToken, client: McpOAuthRegistration): Promise<string | null> {
    let pending = inflight.get(id);
    if (!pending) {
      pending = rotate(id, stale, client);
      inflight.set(id, pending);
      void pending.then(
        () => inflight.delete(id),
        () => inflight.delete(id),
      );
    }
    return pending;
  }

  async function load(serverId: string, principalId: string) {
    const client = await clients.get(serverId);
    const id = tokenId(serverId, principalId);
    const rec = client ? await deps.tokens.get(id) : null;
    return { client, id, rec };
  }

  const tokens: McpUserTokenStore = {
    async set(serverId, principalId, tokenSet, clientId) {
      const id = tokenId(serverId, principalId);
      const prior = await deps.tokens.get(id);
      await deps.tokens.put(id, record(serverId, principalId, tokenSet, clientId, prior));
    },
    async status(serverId, principalId) {
      const client = await clients.get(serverId);
      const rec = await deps.tokens.get(tokenId(serverId, principalId));
      if (!rec) return { connected: false };
      const needsReconnect =
        !client ||
        rec.clientId !== client.clientId ||
        rec.refreshFailedAt !== undefined ||
        (expired(rec) && !rec.refreshTokenEnc);
      return {
        connected: !needsReconnect,
        ...(needsReconnect ? { needsReconnect: true } : {}),
        ...(rec.refreshFailedAt !== undefined ? { refreshFailedAt: rec.refreshFailedAt } : {}),
        ...(rec.refreshError ? { refreshError: rec.refreshError } : {}),
        ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
      };
    },
    async delete(serverId, principalId) {
      const id = tokenId(serverId, principalId);
      const rec = await deps.tokens.take(id);
      if (!rec) return null;
      const accessToken = decrypt(rec.accessTokenEnc, `token ${id}`);
      const refreshToken = rec.refreshTokenEnc ? decrypt(rec.refreshTokenEnc, `refresh ${id}`) : null;
      if (!accessToken) return null;
      return { accessToken, ...(refreshToken ? { refreshToken } : {}) };
    },
    async deleteAllForServer(serverId) {
      for (const [id, rec] of await deps.tokens.entries()) {
        if (rec.serverId === serverId) await deps.tokens.delete(id);
      }
    },
    async accessToken(serverId, principalId) {
      const { client, id, rec } = await load(serverId, principalId);
      if (!client || !usable(rec, client)) return null;
      if (!expired(rec)) return decrypt(rec.accessTokenEnc, `token ${id}`);
      if (!rec.refreshTokenEnc) return null;
      return refreshOnce(id, rec, client);
    },
    async forceRefresh(serverId, principalId) {
      const { client, id, rec } = await load(serverId, principalId);
      if (!client || !usable(rec, client) || !rec.refreshTokenEnc) return null;
      return refreshOnce(id, rec, client);
    },
    async markNeedsReconnect(serverId, principalId, rejectedToken, reason) {
      const rejected = fingerprintOf(rejectedToken);
      await update(tokenId(serverId, principalId), (rec) =>
        rec.fingerprint === rejected ? { ...rec, refreshFailedAt: now(), refreshError: storedError(reason) } : rec,
      );
    },
  };

  const catalogs: McpCatalogStore = {
    get: (serverId) => deps.catalogs.get(serverId),
    put: (catalog) => deps.catalogs.put(catalog.serverId, catalog),
    delete: (serverId) => deps.catalogs.delete(serverId),
  };

  return { clients, tokens, catalogs, net };
}
