import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { HarnessId } from "../model/pi-models.ts";
import { swallowAs } from "../util/errors.ts";

export interface StoredHarnessAuth {
  harnessId: HarnessId;
  tokenEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface HarnessAuthStatus {
  harnessId: HarnessId;
  configured: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

type HarnessAuthResolution = { kind: "token"; token: string } | { kind: "disabled" } | { kind: "unset" };

export interface HarnessAuthStore {
  resolve(harnessId: HarnessId): Promise<HarnessAuthResolution>;
  set(harnessId: HarnessId, token: string, updatedBy: string): Promise<void>;
  delete(harnessId: HarnessId, updatedBy: string): Promise<void>;
  status(harnessId: HarnessId): Promise<HarnessAuthStatus>;
}

export function createHarnessAuthStore(input: {
  backing: DurableMap<StoredHarnessAuth>;
  keyMaterial: string | Buffer;
}): HarnessAuthStore {
  const key = deriveConnectorKey(input.keyMaterial, "harness-auth");

  return {
    async resolve(harnessId) {
      const saved = await input.backing.get(harnessId);
      if (saved?.disabled) return { kind: "disabled" };
      if (!saved?.tokenEnc) return { kind: "unset" };
      try {
        return { kind: "token", token: decryptSecret(saved.tokenEnc, key) };
      } catch {
        return { kind: "unset" };
      }
    },

    async set(harnessId, token, updatedBy) {
      const secret = token.trim();
      if (!secret) throw new Error("token is required");
      const actor = updatedBy.trim();
      if (!actor) throw new Error("updatedBy is required");
      await input.backing.put(harnessId, {
        harnessId,
        tokenEnc: encryptSecret(secret, key),
        disabled: false,
        updatedAt: Date.now(),
        updatedBy: actor,
      });
    },

    async delete(harnessId, updatedBy) {
      await input.backing.put(harnessId, {
        harnessId,
        disabled: true,
        updatedAt: Date.now(),
        updatedBy,
      });
    },

    async status(harnessId) {
      const saved = await input.backing.get(harnessId);
      if (!saved) return { harnessId, configured: false };
      return {
        harnessId,
        configured: !saved.disabled && !!saved.tokenEnc,
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
      };
    },
  };
}

export async function claudeHarnessAuthEnv(
  store: Pick<HarnessAuthStore, "resolve">,
  fallbackEnv: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const saved = await store
    .resolve("claude")
    .catch(swallowAs("harness auth: claude", { kind: "unset" } as HarnessAuthResolution));
  if (saved.kind === "token") return { ...fallbackEnv, CLAUDE_CODE_OAUTH_TOKEN: saved.token };
  if (saved.kind === "disabled")
    return { ...fallbackEnv, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_AUTH_TOKEN: undefined };
  return fallbackEnv;
}

const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat";

export function claudeSubscriptionTokenProblem(token: string): string | null {
  const value = token.trim();
  if (!value) return "A token is required.";
  if (!value.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
    return "That does not look like a Claude subscription token. Run `claude setup-token` and paste the value it prints; a Console API key belongs in the model provider form instead.";
  }
  return null;
}
