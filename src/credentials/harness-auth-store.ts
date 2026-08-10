import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { HarnessId } from "../model/pi-models.ts";

/**
 * Subscription credentials for harnesses that authenticate themselves.
 *
 * The model credential store answers "which provider key bills this model".
 * This answers a different question — "which account does this agent CLI sign
 * in as" — and the two are not interchangeable: a subscription token is not a
 * provider key, cannot be validated like one, and belongs to a harness rather
 * than to a model. Keeping them apart also keeps ModelProvider from growing a
 * member that the model catalog, the turn-admission gate, and the custom
 * provider surface would each have to learn to ignore.
 */
export interface StoredHarnessAuth {
  harnessId: HarnessId;
  tokenEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface HarnessAuthStatus {
  harnessId: HarnessId;
  configured: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

export interface HarnessAuthStore {
  resolve(harnessId: HarnessId): Promise<string | null>;
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
      if (!saved || saved.disabled || !saved.tokenEnc) return null;
      // An undecryptable token means the key material changed under us. Report
      // absent so the harness falls back to its boot credential; throwing here
      // would take down every turn on this harness instead.
      try {
        return decryptSecret(saved.tokenEnc, key);
      } catch {
        return null;
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
      // A tombstone rather than a removal: a deployment that still carries the
      // token in its environment must not silently resurrect a credential an
      // admin has just switched off.
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

/** Claude subscription tokens from `claude setup-token` carry this prefix. */
const CLAUDE_OAUTH_TOKEN_PREFIX = "sk-ant-oat";

/**
 * Reject the likely mistake — pasting a Console API key — before spending a
 * model call to validate it, and say which command produces the right thing.
 */
export function claudeSubscriptionTokenProblem(token: string): string | null {
  const value = token.trim();
  if (!value) return "A token is required.";
  if (!value.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
    return "That does not look like a Claude subscription token. Run `claude setup-token` and paste the value it prints; a Console API key belongs in the model provider form instead.";
  }
  return null;
}
