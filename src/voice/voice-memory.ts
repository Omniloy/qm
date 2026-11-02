import type { ServerDeps } from "../api/deps.ts";
import { orgScope } from "../config.ts";
import { resolveEnvironmentId } from "../environments/environment-store.ts";
import { DEFAULT_MEMORY_POLICY } from "../memory/policy.ts";
import { RECALL_MAX_CHARS, capTail } from "../memory/notebook.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import { contextMemory } from "../resolution/turn-context.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { swallow } from "../util/errors.ts";

type VoiceMemoryDeps = Pick<ServerDeps, "memory" | "memoryPolicy" | "memoryMaintain" | "environments">;

export interface VoiceMemory {
  memory: MemoryService;
  write: ScopeId;
  recalled: string;
  capture: boolean;
  compact: boolean;
}

async function recallText(memory: MemoryService, scopes: ScopeId[], actorId: string): Promise<string> {
  if (!scopes.length) return "";
  try {
    const text = await contextMemory({ memory, scopes, actorId }).recall();
    return text ? capTail(text, RECALL_MAX_CHARS) : "";
  } catch (err) {
    swallow("voice: memory recall", err);
    return "";
  }
}

export async function voiceMemory(
  deps: VoiceMemoryDeps,
  principalId: string,
  recall: boolean,
): Promise<VoiceMemory | null> {
  const memory = deps.memory;
  if (!memory) return null;
  const policy = deps.memoryPolicy ?? DEFAULT_MEMORY_POLICY;
  const write = await resolveEnvironmentId(deps.environments, scopeId("personal", principalId));
  const read: ScopeId[] = { off: [], writable: [write], visible: [...new Set([write, orgScope()])] }[policy.recall];
  const capture = policy.capture !== "off";
  return {
    memory,
    write,
    recalled: recall ? await recallText(memory, read, principalId) : "",
    capture,
    compact: capture && !!deps.memoryMaintain,
  };
}
