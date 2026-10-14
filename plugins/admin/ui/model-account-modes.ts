import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { choiceGroup, saveFooter } from "./setting-controls.ts";
import type { SettingsState } from "./settings.ts";

const PROVIDERS = [
  ["anthropic", "Claude"],
  ["openai", "ChatGPT"],
] as const;

const FALLBACKS = [
  [
    "fallbackWhenUnavailable",
    "Use the organization's account when a personal account is unavailable",
    "If someone's own account is disconnected or its sign-in cannot be refreshed, the turn runs on the organization's account instead of failing.",
  ],
  [
    "fallbackWhenRejected",
    "Use the organization's account when the provider rejects a personal account",
    "If the provider refuses someone's own account during a turn, for a failed sign-in or a usage or rate limit, the turn continues on the organization's account instead of failing.",
  ],
] as const;

export function modelAccountModesDraft(data: Record<string, any>) {
  const policy = data.modelAccountModes ?? {};
  return {
    ...Object.fromEntries(
      PROVIDERS.map(([provider]) => [provider, policy[provider] === "personal" ? "personal" : "org"]),
    ),
    ...Object.fromEntries(FALLBACKS.map(([key]) => [key, policy[key] === true])),
  };
}

export function modelAccountModesCard(s: SettingsState) {
  return html`<section
    class=${classMap({ card: true, "sv-models": true, "setting-row": true, hidden: !s.available, dirty: s.dirty })}
    id="card-model-account-modes"
  >
    <div class="head">
      <h2>Personal AI accounts</h2>
      <p>
        Personal accounts are always opt-in: nobody is required to connect one. Choose, per provider, whether every turn
        runs on the organization's account or allowed people may opt into their own. The list below decides who is
        allowed. Switching a provider back to the organization's account keeps saved sign-ins but stops using them.
      </p>
    </div>
    <div class="body">
      ${PROVIDERS.map(
        ([provider, name]) =>
          html`<fieldset class="model-account-mode" data-provider=${provider}>
            <legend>${name}</legend>
            ${choiceGroup(
              {
                name: `model-account-mode-${provider}`,
                value: s.draft[provider],
                onChange: (event: Event) => s.change(provider, (event.target as HTMLInputElement).value),
              },
              [
                ["org", "Org account", `Every ${name} turn uses the organization's account.`],
                ["personal", "Each person's own account", `Allowed people may opt into their own ${name} account.`],
              ],
            )}
          </fieldset>`,
      )}
      ${FALLBACKS.map(
        ([key, title, detail]) =>
          html`<label class="setting-toggle" id=${`model-account-${key}-control`}
            ><input
              type="checkbox"
              id=${`model-account-${key}`}
              .checked=${!!s.draft[key]}
              @change=${(e: Event) => s.change(key, (e.target as HTMLInputElement).checked)}
            /><span class="setting-switch" aria-hidden="true"></span
            ><span class="setting-copy"><strong>${title}</strong><small>${detail}</small></span></label
          >`,
      )}
    </div>
    ${saveFooter(s)}
  </section>`;
}
