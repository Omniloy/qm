import {
  codexProviderModelId,
  codexSubscriptionModelId,
  CODEX_SUBSCRIPTION_PROVIDER,
  DEFAULT_AGENT_MODEL_ID,
  DEFAULT_CODEX_MODEL_ID,
  defaultModelForHarness,
  defaultModelForProvider,
  resolveModel,
  isOverlayModel,
  modelUnavailableReason,
  type ModelProvider,
} from "../model/pi-models.ts";
import type { UserModelCredential, UserModelCredentialStore } from "../model/user-model-credential-store.ts";
import {
  DEFAULT_MODEL_ACCOUNT_MODES,
  PERSONAL_MODEL_PROVIDERS,
  type ModelAccount,
  type PersonalModelProvider,
  type ScopedConfigStore,
} from "../resolution/config-store.ts";

export type IndividualAuthRouting =
  | { kind: "apikey"; provider: ModelProvider; harness: "pi"; model: string | undefined; apiKey: string }
  | { kind: "oauth"; provider: "anthropic"; harness: "claude"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "codex"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "pi"; model: string }
  | null;

export interface PersonalModelAccess {
  anthropic: UserModelCredential | null;
  openai: UserModelCredential | null;
  orgServed: ReadonlySet<PersonalModelProvider>;
}

function requestedProviderOf(model: string | undefined) {
  const provider = model ? resolveModel(model)?.provider : undefined;
  return provider === CODEX_SUBSCRIPTION_PROVIDER ? "openai" : provider;
}

export async function loadPersonalModelAccess(
  config: Pick<ScopedConfigStore, "getModelAccountModesDurable"> | undefined,
  store: Pick<UserModelCredentialStore, "get">,
  actorId: string,
  account: Exclude<ModelAccount, "company">,
): Promise<PersonalModelAccess> {
  const modes = (await config?.getModelAccountModesDurable()) ?? DEFAULT_MODEL_ACCOUNT_MODES;
  const own = account === "personal" ? PERSONAL_MODEL_PROVIDERS : [account];
  const orgServed = new Set(PERSONAL_MODEL_PROVIDERS.filter((provider) => modes[provider] === "org"));
  const usable = (provider: PersonalModelProvider) => own.includes(provider) && !orgServed.has(provider);
  const [anthropic, openai] = await Promise.all(
    PERSONAL_MODEL_PROVIDERS.map(async (provider) => (usable(provider) ? await store.get(actorId, provider) : null)),
  );
  return {
    anthropic: anthropic ?? null,
    openai: openai ?? null,
    orgServed: own.some(usable) ? orgServed : new Set(PERSONAL_MODEL_PROVIDERS),
  };
}

export function routePersonalModelAccess(
  access: PersonalModelAccess,
  requestedModel: string | undefined,
  preferredHarness?: string,
): IndividualAuthRouting | "org" {
  const provider = requestedProviderOf(requestedModel);
  if (
    access.orgServed.size === PERSONAL_MODEL_PROVIDERS.length ||
    ((provider === "anthropic" || provider === "openai") && access.orgServed.has(provider))
  )
    return "org";
  return resolveIndividualAuthRouting(access.anthropic, access.openai, requestedModel, preferredHarness);
}

export function resolveIndividualAuthRouting(
  anthCred: UserModelCredential | null,
  oaiCred: UserModelCredential | null,
  requestedModel: string | undefined,
  preferredHarness?: string,
): IndividualAuthRouting {
  if (requestedModel && (modelUnavailableReason(requestedModel) || !resolveModel(requestedModel))) return null;
  const rawProvider = requestedModel ? resolveModel(requestedModel)?.provider : undefined;
  const requestedProvider = requestedProviderOf(requestedModel);
  const pick = ((): { provider: "anthropic" | "openai"; cred: UserModelCredential } | null => {
    if (requestedProvider === "anthropic" && anthCred) return { provider: "anthropic", cred: anthCred };
    if (requestedProvider === "openai" && oaiCred) return { provider: "openai", cred: oaiCred };
    if (anthCred) return { provider: "anthropic", cred: anthCred };
    if (oaiCred) return { provider: "openai", cred: oaiCred };
    return null;
  })();
  if (!pick) return null;
  if (
    requestedModel &&
    isOverlayModel(requestedModel) &&
    (pick.cred.kind !== "apikey" || requestedProvider !== pick.provider)
  )
    return null;
  if (pick.cred.kind === "apikey" && rawProvider === CODEX_SUBSCRIPTION_PROVIDER) return null;
  if (pick.cred.kind === "apikey" && pick.cred.apiKey) {
    return {
      kind: "apikey",
      provider: pick.provider,
      harness: "pi",
      apiKey: pick.cred.apiKey,
      model:
        requestedModel && requestedProvider === pick.provider
          ? requestedModel
          : defaultModelForProvider("pi", pick.provider),
    };
  }
  if (pick.cred.kind === "oauth" && pick.cred.oauth) {
    if (pick.provider === "anthropic") {
      return {
        kind: "oauth",
        provider: "anthropic",
        harness: "claude",
        model:
          requestedModel && requestedProvider === "anthropic"
            ? requestedModel
            : defaultModelForHarness("claude", DEFAULT_AGENT_MODEL_ID),
      };
    }
    if (preferredHarness === "pi") {
      // pi-on-ChatGPT: the org runs the pi harness, so serve the
      // subscription through pi-ai's Codex provider instead of switching
      // the person onto the codex harness.
      return {
        kind: "oauth",
        provider: "openai",
        harness: "pi",
        model: codexSubscriptionModelId(
          requestedModel && requestedProvider === "openai" ? requestedModel : DEFAULT_CODEX_MODEL_ID,
        ),
      };
    }
    return {
      kind: "oauth",
      provider: "openai",
      harness: "codex",
      model:
        requestedModel && requestedProvider === "openai"
          ? codexProviderModelId(requestedModel)
          : defaultModelForHarness("codex", DEFAULT_CODEX_MODEL_ID),
    };
  }
  return null;
}
