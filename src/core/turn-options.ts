import type { RuntimePurpose, ScopedConfigStore } from "../resolution/config-store.ts";
import { samePersonMatcher, type RosterPerson } from "../directory/person.ts";
import {
  defaultWebuiModelIds,
  THINKING_LEVELS,
  serviceableModelIds,
  modelServiceable,
  resolveModel,
  ALL_PROVIDERS_AVAILABLE,
  type ModelProviderAvailability,
} from "../model/pi-models.ts";

export const NON_INTERACTIVE_THINKING_LEVEL = "xhigh";
export const NON_INTERACTIVE_FAST_MODE = false;

export function turnRuntimePurpose(
  input: { surface?: string; triggered?: boolean },
  subagent = false,
): RuntimePurpose | undefined {
  if (subagent) return "subagent";
  if (input.triggered && (input.surface === "cron" || input.surface === "loop")) return "cron";
  return undefined;
}

export function resolveTurnFastMode(
  requested: boolean | undefined,
  humanTurn: boolean,
  interactiveDefault: boolean,
): boolean | undefined {
  if (typeof requested === "boolean") return requested;
  return humanTurn && interactiveDefault ? true : undefined;
}

export async function fastModeAllowed(
  config: Pick<ScopedConfigStore, "getFastModeAccess"> | undefined,
  directory: { get(principalId: string): Promise<RosterPerson | null> } | undefined,
  actorId: string | undefined,
): Promise<boolean> {
  const people = (await config?.getFastModeAccess()) ?? null;
  if (people === null) return true;
  if (!actorId || !people.length) return false;
  const matches = await samePersonMatcher(directory ?? { get: async () => null }, actorId);
  for (const person of people) if (await matches(person)) return true;
  return false;
}

export function turnModelOptions(input: {
  triggered?: boolean;
  surface?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
}): {
  thinkingLevel?: string;
  fastMode?: boolean;
} {
  const legacyDefaults = input.triggered && input.surface !== "cron" && input.surface !== "loop";
  let thinkingLevel = input.thinkingLevel;
  if (!thinkingLevel && legacyDefaults) thinkingLevel = NON_INTERACTIVE_THINKING_LEVEL;
  let fastMode = input.fastMode;
  if (typeof fastMode !== "boolean" && legacyDefaults) fastMode = NON_INTERACTIVE_FAST_MODE;
  return {
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

export function validateWebTurnModelOptions(
  input: { model?: string; thinkingLevel?: string },
  enabledModels: readonly string[] | null,
  providers: ModelProviderAvailability = ALL_PROVIDERS_AVAILABLE,
): string | null {
  const enabled = enabledModels ?? defaultWebuiModelIds();
  const allowedModels = serviceableModelIds(enabled, providers);
  if (input.model && !allowedModels.includes(input.model)) {
    return resolveModel(input.model) && !modelServiceable(input.model, providers)
      ? "that model isn't available on this deployment (its provider isn't configured)"
      : "that model is not enabled for the web UI";
  }
  if (input.thinkingLevel && !(THINKING_LEVELS as readonly string[]).includes(input.thinkingLevel))
    return "unsupported thinking level";
  return null;
}
