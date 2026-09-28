import { html, nothing } from "lit";
import { settingStatus } from "./setting-controls.ts";
import { connectors, context } from "./integrations-state.ts";

const ENV_KEY = "COMPOSIO_API_KEY";

class ComposioState {
  key = "";
  saving = false;
  message = "";
  tone = "";
  render = () => {};
  get credential() {
    return connectors.serviceCredentials?.find((c) => c.delivery === "env" && c.envKey === ENV_KEY);
  }
  setStatus(message: string, tone: string) {
    this.message = message;
    this.tone = tone;
    this.render();
  }
  async save() {
    if (this.saving) return;
    if (!this.key.trim()) return this.setStatus("Paste the Composio project API key.", "err");
    const existing = this.credential;
    this.saving = true;
    this.setStatus("Saving…", "saving");
    try {
      const result = await context.api(
        "PUT",
        "/api/scopes/" + encodeURIComponent(context.orgScope()) + "/service-credentials",
        {
          slug: existing?.slug ?? "composio",
          name: "Composio",
          delivery: "env",
          envKey: ENV_KEY,
          secret: this.key.trim(),
          enabled: true,
          ...(existing ? { expectedUpdatedAt: existing.updatedAt } : {}),
        },
      );
      if (!result.ok) return this.setStatus(result.data?.message || "Save failed.", "err");
      this.key = "";
      await connectors.load();
      this.setStatus("Saved", "ok");
    } catch {
      this.setStatus("Save failed. Please try again.", "err");
    } finally {
      this.saving = false;
      this.render();
    }
  }
}
export const composio = new ComposioState();

function composioState() {
  const c = composio.credential;
  if (!connectors.serviceCredentials) return "Loading…";
  if (c?.enabled && c.hasSecret)
    return html`<span class="badge ok">Configured</span> People can connect apps from the web UI or by asking the agent.`;
  if (!c) return html`<span class="badge muted">Not configured</span>`;
  return html`<span class="badge warn">${c.enabled ? "Key missing" : "Disabled"}</span> Paste a key below, or re-enable
    the <code>${c.slug}</code> credential under Credentials.`;
}

export function composioCard() {
  const c = composio.credential;
  return html`<section class="card" id="card-composio">
    <div class="head">
      <h2>Composio</h2>
      <p>
        Lets people connect their own apps (Gmail, Notion, HubSpot, and hundreds more) through your Composio project.
        The project key stays in the backend; agents reach Composio only through the platform, and each person connects
        their own accounts.
      </p>
    </div>
    <div class="body">
      <p class="hint" id="composio-state">${composioState()}</p>
      <label style="display: block; margin-bottom: 8px"
        >${c ? "Replace project API key" : "Project API key"}
        <input
          type="password"
          id="composio-key"
          .value=${composio.key}
          autocomplete="off"
          placeholder="(write-only)"
          style="width: 100%"
          @input=${(e: Event) => {
            composio.key = (e.target as HTMLInputElement).value;
            composio.render();
          }}
      /></label>
      <p class="field-hint">
        From the Composio dashboard, Settings → API keys. Before production use, set the project's callback verifier URL
        to <code>${location.origin}/api/composio/callback</code>.
      </p>
      ${c ? html`<p class="field-hint">Stored as the <code>${c.slug}</code> credential under Credentials.</p>` : nothing}
    </div>
    <div class="foot">
      <button
        class="primary"
        id="composio-save"
        ?disabled=${composio.saving || !composio.key.trim()}
        @click=${() => composio.save()}
      >
        ${c ? "Replace key" : "Save key"}</button
      >${settingStatus(composio, "st-composio")}
    </div>
  </section>`;
}
