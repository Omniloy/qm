import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { choiceGroup, saveFooter } from "./setting-controls.ts";
import type { SettingsState } from "./settings.ts";

const PROVIDERS = [
  ["anthropic", "Claude"],
  ["openai", "ChatGPT"],
] as const;

export function modelAccountModesDraft(data: Record<string, any>) {
  return Object.fromEntries(
    PROVIDERS.map(([provider]) => [provider, data.modelAccountModes?.[provider] === "personal" ? "personal" : "org"]),
  );
}

export function modelAccountModesCard(s: SettingsState) {
  return html`<section
    class=${classMap({ card: true, "sv-models": true, "setting-row": true, hidden: !s.available, dirty: s.dirty })}
    id="card-model-account-modes"
  >
    <div class="head">
      <h2>Personal AI accounts</h2>
      <p>
        Choose, per provider, whether every turn runs on the organization's account or people may sign in with their
        own. Switching a provider back to the organization's account keeps saved sign-ins but stops using them.
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
                ["personal", "Each person's own account", `People may connect their own ${name} account.`],
              ],
            )}
          </fieldset>`,
      )}
    </div>
    ${saveFooter(s)}
  </section>`;
}
