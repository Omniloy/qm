import { html, render, type TemplateResult } from "lit";
import { Globe, KeyRound, Link } from "lucide";
import { api, type CoreContext } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon, productName } from "./ui";
import { connectorLogo } from "./connector-logo";
import { appState, replacePanePreservingFocus } from "./shell";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { isActiveGrant, isExpiredCredential, KeychainOperations } from "./keychain-state";
import { listPageTpl } from "./list-page";
import {
  grantBlockedReason,
  grantConfirmLabel,
  grantImpact,
  grantRequest,
  grantSuccessNotice,
  grantTargets,
  type GrantMode,
  type GrantScopeOption,
} from "./keychain-grant";
import {
  browserAction,
  browserById,
  browserSummary,
  browserTabs,
  connectDraft,
  extensionLabel,
  extensionNote,
  extensionState,
  initialBrowserTab,
  isExtensionTab,
  type BrowserAction,
  type BrowserProvider,
} from "./browser-picker-state";

interface ConnectorProvider {
  connected?: boolean;
  needsReconnect?: boolean;
  refreshError?: string;
  available?: boolean;
  hosts?: Array<{ host?: string } | string>;
}

const CONNECTOR_LABELS: Record<string, { name: string; hosts: string }> = {
  google: {
    name: "Google Workspace",
    hosts: "Gmail, Calendar, Drive, Sheets",
  },
  slack: {
    name: "Slack",
    hosts: "Channels & messages",
  },
  notion: {
    name: "Notion",
    hosts: "Pages & databases",
  },
  linear: {
    name: "Linear",
    hosts: "Issues & projects",
  },
  github: {
    name: "GitHub",
    hosts: "Repos, issues & PRs",
  },
  dropbox: {
    name: "Dropbox",
    hosts: "Files & folders",
  },
  x: {
    name: "X (Twitter)",
    hosts: "Posts & profile",
  },
};

interface KeychainCredential {
  id: string;
  service: string;
  kind?: string;
  envKey?: string;
  fields?: Array<{ envKey: string }>;
  accountLabel?: string;
  host?: string;
  fingerprint?: string;
  expiresAt?: number;
  createdAt?: number;
}

interface KeychainConnectorCredential {
  credentialId: string;
  host: string;
  accountType?: string;
  expiresAt?: number;
  connected: boolean;
  needsReconnect?: boolean;
}

interface KeychainGrant {
  id: string;
  credentialId: string;
  audienceScopeId: string;
  mode: "once" | "standing";
  purpose: string;
  status: "active" | "revoked" | "used";
  expiresAt?: number;
}

interface KeychainAsk {
  id: string;
  credentialId: string;
  requesterId: string;
  requesterScopeId: string;
  purpose: string;
  requestedMode?: "once" | "standing";
  expiresAt: number;
}

let connectorProviders: Record<string, ConnectorProvider> = {};
let keychainCredentials: KeychainCredential[] = [];
let keychainConnectorCredentials: KeychainConnectorCredential[] = [];
let keychainGrants: KeychainGrant[] = [];
let keychainAsks: KeychainAsk[] = [];
let keychainScopeNames: Record<string, string> = {};
let connectorNotice = "";
let loadNotice = "";
let addingCredential: { service: string; envKey: string; purpose: string } | null = null;
let secureDropUrl: string | null = null;
let browserProviders: BrowserProvider[] = [];
let activeBrowser: string | null = null;
let browserTab: string | null = null;
let relayChecking = false;
let browserConnect: { provider: BrowserProvider; path: string; value: string; error: string } | null = null;
let confirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;
let confirmationOpener: HTMLElement | null = null;
let keychainContexts: GrantScopeOption[] = [];
let granting: {
  credential: KeychainCredential;
  audienceScopeId: string;
  mode: GrantMode;
  purpose: string;
} | null = null;
let grantBusy = false;
let grantError = "";
let grantOpener: HTMLElement | null = null;
const keychainOperations = new KeychainOperations();

let connectorsLoading = false;
let keysLoading = false;
let connectorsEverLoaded = false;
let keysEverLoaded = false;

export function resetKeychainState(): void {
  keychainOperations.reset();
  connectorProviders = {};
  keychainCredentials = [];
  keychainConnectorCredentials = [];
  keychainGrants = [];
  keychainAsks = [];
  keychainScopeNames = {};
  browserProviders = [];
  activeBrowser = null;
  browserTab = null;
  relayChecking = false;
  browserConnect = null;
  connectorNotice = "";
  loadNotice = "";
  connectorsLoading = false;
  keysLoading = false;
  connectorsEverLoaded = false;
  keysEverLoaded = false;
  addingCredential = null;
  secureDropUrl = null;
  confirmation = null;
  confirmationOpener = null;
}

function fmtDate(ms?: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "";
  }
}

function accessModeLabel(mode?: "once" | "standing"): string {
  return mode === "standing" ? "standing" : "one-time";
}

function credentialCard(c: KeychainCredential): TemplateResult {
  const envNames = c.envKey ?? c.fields?.map((field) => field.envKey).join(", ");
  const subtitle = [c.accountLabel, c.host, envNames].filter(Boolean).join(" · ");
  const expired = isExpiredCredential(c);
  const grants = keychainGrants.filter((grant) => grant.credentialId === c.id && isActiveGrant(grant, c));
  const asks = keychainAsks.filter((ask) => ask.credentialId === c.id);
  const grantBlocked = grantBlockedReason(c, grantTargets(keychainContexts, c.id, keychainGrants, personalScopeId()));
  return html`
    <article class="kc-resource kc-credential">
      <div class="kc-resource-main">
        <div class="kc-resource-icon">${icon(KeyRound, 18)}</div>
        <div class="kc-resource-copy">
          <div class="kc-resource-title-row">
            <h3>${c.service}</h3>
            ${expired ? html`<span class="kc-state warning">Expired</span>` : ""}
          </div>
          ${subtitle ? html`<div class="kc-resource-meta">${subtitle}</div>` : ""}
        </div>
        <div class="kc-resource-actions">
          <button
            class="kc-text-action"
            type="button"
            data-confirm-key=${`grant:${c.id}`}
            ?disabled=${keychainOperations.mutationInFlight || Boolean(grantBlocked)}
            title=${grantBlocked ?? ""}
            @click=${(event: Event) => startGrant(c, event.currentTarget as HTMLElement)}
          >
            Give access…
          </button>
          <button
            class="kc-text-action danger"
            type="button"
            data-confirm-key=${`delete:${c.id}`}
            ?disabled=${keychainOperations.mutationInFlight}
            @click=${() => void deleteCredential(c)}
          >
            Delete
          </button>
        </div>
      </div>
      ${
        asks.length
          ? html`<div class="kc-access-block pending">
              ${asks.map(
                (ask) =>
                  html`<div class="kc-access-row">
                    <div>
                      <span class="kc-access-label">Pending</span>
                      <bdi><strong>${scopeName(ask.requesterScopeId)}</strong></bdi>
                      <span
                        >· ${accessModeLabel(ask.requestedMode)} · ${ask.purpose} · expires
                        ${fmtDate(ask.expiresAt)}</span
                      >
                    </div>
                  </div>`,
              )}
            </div>`
          : ""
      }
      ${
        grants.length
          ? html`<div class="kc-access-block">
              ${grants.map(
                (grant) =>
                  html` <div class="kc-access-row">
                    <div>
                      <span class="kc-access-label">Access</span>
                      <bdi><strong>${scopeName(grant.audienceScopeId)}</strong></bdi>
                      <span
                        >· ${accessModeLabel(grant.mode)} ·
                        ${grant.purpose}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ""}</span
                      >
                    </div>
                    <button
                      class="kc-text-action"
                      type="button"
                      data-confirm-key=${`revoke:${grant.id}`}
                      ?disabled=${keychainOperations.mutationInFlight}
                      @click=${() => void revokeGrant(grant)}
                    >
                      Revoke
                    </button>
                  </div>`,
              )}
            </div>`
          : ""
      }
    </article>
  `;
}

// Raw Slack IDs (C0…, G0…) mean nothing to people — always prefer a resolved
// name, and fall back to a human description. The raw ID appears only as a
// parenthetical of last resort, to disambiguate when no name is available.
function scopeName(scope: string): string {
  const resolved = keychainScopeNames[scope];
  if (resolved) return resolved;
  const [kind, ...rest] = scope.split(":");
  const ref = rest.join(":");
  switch (kind) {
    case "personal":
      return ref || "a personal DM";
    case "channel":
      return ref ? `a Slack channel (${ref})` : "a Slack channel";
    case "group":
      return "a group DM";
    case "team":
      return ref ? `a team (${ref})` : "a team";
    case "org":
      return "the whole org";
    default:
      return scope;
  }
}

function addCredentialCard(): TemplateResult {
  const draft = addingCredential!;
  return html`<section class="kc-add-card" aria-labelledby="kc-add-title">
    <div class="kc-panel-head">
      <div>
        <h2 id="kc-add-title">Add a credential</h2>
        <p>You’ll paste the secret on an encrypted one-time page next.</p>
      </div>
    </div>
    ${
      secureDropUrl
        ? html`
            <div class="kc-success" role="status">
              <strong>Your one-time page is ready</strong><span>Open it in a new tab and paste the secret there.</span>
            </div>
            <div class="kc-form-actions">
              <a class="btn primary" href=${secureDropUrl} target="_blank" rel="noopener noreferrer"
                >Open the one-time page</a
              ><button
                class="btn"
                type="button"
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                Done
              </button>
            </div>
          `
        : html`
            <div class="kc-form-grid">
              <label class="skill-field"
                ><span>Service</span
                ><input
                  class="skill-desc-input"
                  placeholder="Stripe"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.service}
                  @input=${(e: Event) => {
                    draft.service = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field"
                ><span>Environment variable <em>optional</em></span
                ><input
                  class="skill-desc-input"
                  placeholder="STRIPE_API_KEY"
                  autocapitalize="characters"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.envKey}
                  @input=${(e: Event) => {
                    draft.envKey = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field kc-purpose-field"
                ><span>Purpose</span
                ><input
                  class="skill-desc-input"
                  placeholder="What may the agent use this credential for?"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.purpose}
                  @input=${(e: Event) => {
                    draft.purpose = (e.target as HTMLInputElement).value;
                  }}
              /></label>
            </div>
            <div class="kc-form-actions">
              <button
                class="btn"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                Cancel</button
              ><button
                class="btn primary"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => void createDrop()}
              >
                ${keychainOperations.dropInFlight ? "Preparing…" : "Continue"}
              </button>
            </div>
          `
    }
  </section>`;
}

function confirmationCard(): TemplateResult {
  const pending = confirmation!;
  return html`<div
    class="kc-dialog-scrim"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeConfirmation()}
  >
    <article
      class="kc-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kc-confirm-title"
      aria-describedby="kc-confirm-body"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeConfirmation)}
    >
      <span class="kc-eyebrow danger">Check impact</span>
      <h2 id="kc-confirm-title">${pending.title}</h2>
      <p id="kc-confirm-body">${pending.body}</p>
      <div class="kc-form-actions">
        <button class="btn" type="button" data-dialog-cancel @click=${closeConfirmation}>Cancel</button
        ><button class="btn danger" type="button" @click=${() => void pending.run()}>${pending.action}</button>
      </div>
    </article>
  </div>`;
}

function extensionPanel(provider: BrowserProvider): TemplateResult {
  const state = extensionState(provider);
  const note = extensionNote(state);
  const label = extensionLabel(state);
  return html`
    <div class="kc-browser-connect">
      <p class="kc-browser-note">
        <span class="kc-state ${note.tone}">${label}</span>
        ${note.text}
      </p>
      ${
        state.kind === "absent"
          ? ""
          : html`<div class="kc-form-actions">
                <button class="btn" type="button" ?disabled=${relayChecking} @click=${() => void recheckExtension()}>
                  ${relayChecking ? "Checking…" : "Re-check"}
                </button>
                <a class="btn" href="/api/browser-relay/extension.zip" download="miniomni-browser-bridge.zip"
                  >Download again</a
                >
              </div>
              <p class="kc-browser-note">
                Updating? Download, unzip over the old folder, then press the reload arrow on the extension in
                <code>chrome://extensions</code>.
              </p>`
      }
      ${
        state.kind !== "absent"
          ? ""
          : html`<ol class="kc-ext-steps">
                <li>
                  <a class="btn" href="/api/browser-relay/extension.zip" download="miniomni-browser-bridge.zip"
                    >Download the extension</a
                  >
                  and unzip it. It comes set up with your ${productName()} address and a pairing token — nothing to
                  paste.
                </li>
                <li>
                  Open <code>chrome://extensions</code> (copy-paste it — Chrome blocks links there), turn on
                  <strong>Developer mode</strong>, click <strong>Load unpacked</strong>, and pick the unzipped folder.
                </li>
                <li>Click the extension, then <strong>Share this tab</strong> on any tab you want the agent to use.</li>
              </ol>
              <p class="kc-browser-note">
                The download carries a token that lets it connect as you — treat the unzipped folder like a password.
              </p>`
      }
    </div>
  `;
}

function browserActionTpl(action: BrowserAction, tabId: string, provider: BrowserProvider): TemplateResult {
  if (action.kind === "in-use") return html`<span class="kc-state ok">In use</span>`;
  if (action.kind === "use") {
    return html`<button
      class="btn"
      type="button"
      ?disabled=${keychainOperations.mutationInFlight}
      @click=${() => void chooseBrowser(tabId)}
    >
      ${action.label}
    </button>`;
  }
  return html`<button
    class="btn"
    type="button"
    ?disabled=${keychainOperations.dropInFlight}
    @click=${() => void connectBrowser(provider)}
  >
    ${keychainOperations.dropInFlight ? "Preparing…" : action.label}
  </button>`;
}

function browserCard(): TemplateResult {
  const tabs = browserTabs(browserProviders, activeBrowser);
  const live = tabs.find((tab) => tab.active);
  if (tabs.length === 0) {
    return html`
      <article class="kc-resource kc-account kc-browser">
        <div class="kc-resource-main">
          <span class="connector-logo">${icon(Globe, 18)}</span>
          <div class="kc-resource-copy">
            <div class="kc-resource-title-row">
              <h3>Browser</h3>
              <span class="kc-state neutral">None</span>
            </div>
            <div class="kc-resource-meta">Which browser the agent uses for you</div>
          </div>
        </div>
        <p class="kc-browser-summary">
          No browser is connected yet. Connect your own Chrome with the browser extension, or add a hosted provider key,
          to let the agent browse for you.
        </p>
      </article>
    `;
  }
  const shownId = browserTab ?? initialBrowserTab(browserProviders, activeBrowser);
  const shown = tabs.find((tab) => tab.id === shownId) ?? tabs[0]!;
  const provider = browserById(browserProviders, shown.id)!;
  const action = browserAction(shown);
  return html`
    <article class="kc-resource kc-account kc-browser">
      <div class="kc-resource-main">
        <span class="connector-logo">${icon(Globe, 18)}</span>
        <div class="kc-resource-copy">
          <div class="kc-resource-title-row">
            <h3>Browser</h3>
            <span class="kc-state neutral">${live ? live.name : "None"}</span>
          </div>
          <div class="kc-resource-meta">Which browser the agent uses for you</div>
        </div>
      </div>
      <div class="kc-browser-tabs" role="tablist" aria-label="Browser">
        ${tabs.map(
          (tab) =>
            html`<button
              class="kc-browser-tab${tab.id === shown.id ? " selected" : ""}${tab.active ? " live" : ""}"
              type="button"
              role="tab"
              aria-selected=${tab.id === shown.id ? "true" : "false"}
              @click=${() => {
                browserTab = tab.id;
                drawConnectors();
              }}
            >
              ${tab.name}${tab.active ? html`<span class="kc-browser-dot" aria-label="in use"></span>` : ""}
            </button>`,
        )}
      </div>
      <p class="kc-browser-summary">${browserSummary(provider, shown)}</p>
      ${
        browserConnect && browserConnect.provider.id === shown.id
          ? html`<form
              class="kc-browser-connect"
              @submit=${(e: Event) => {
                e.preventDefault();
                void submitBrowserKey();
              }}
            >
              <label class="skill-field"
                ><span>${provider.name} API key</span
                ><input
                  class="skill-desc-input"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder=${provider.keyEnv}
                  .value=${browserConnect.value}
                  ?disabled=${keychainOperations.dropInFlight}
                  @input=${(e: Event) => {
                    if (browserConnect) browserConnect.value = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <p class="kc-browser-note">
                Goes straight to your encrypted keychain over TLS. It is never shown in chat.
              </p>
              ${browserConnect.error ? html`<p class="kc-inline-warning" role="status">${browserConnect.error}</p>` : ""}
              <div class="kc-form-actions">
                <button class="btn primary" type="submit" ?disabled=${keychainOperations.dropInFlight}>
                  ${keychainOperations.dropInFlight ? "Saving…" : "Save key"}</button
                ><button
                  class="btn"
                  type="button"
                  @click=${() => {
                    browserConnect = null;
                    drawConnectors();
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>`
          : ""
      }
      ${isExtensionTab(shown.id) ? extensionPanel(provider) : ""}
      <div class="kc-resource-actions">
        ${browserActionTpl(action, shown.id, provider)}
        ${
          provider.signupUrl
            ? html`<a class="kc-text-action" href=${provider.signupUrl} target="_blank" rel="noopener noreferrer"
                >Get an API key ↗</a
              >`
            : ""
        }
        ${
          live
            ? html`<button class="kc-text-action" type="button" @click=${() => void chooseBrowser(null)}>
                Use org default
              </button>`
            : ""
        }
      </div>
    </article>
  `;
}

async function submitBrowserKey(): Promise<void> {
  if (!browserConnect || keychainOperations.dropInFlight) return;
  const key = browserConnect.value.trim();
  if (!key) {
    browserConnect.error = "Paste the key first.";
    return drawConnectors();
  }
  const pending = browserConnect;
  const stateEpoch = keychainOperations.beginDrop();
  if (stateEpoch === null) return;
  pending.error = "";
  drawConnectors();
  try {
    const res = await fetch(pending.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { [pending.provider.keyEnv]: key } }),
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      pending.error = detail?.message ?? "That key could not be saved. Try Connect again for a fresh link.";
      return;
    }
    pending.value = "";
    browserConnect = null;
    connectorNotice = `${pending.provider.name} is connected.`;
    await renderConnectors();
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    pending.error = errMessage(e, "That key could not be saved.");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      keychainOperations.finishDrop(stateEpoch);
      drawConnectors();
    }
  }
}

async function recheckExtension(): Promise<void> {
  if (relayChecking) return;
  relayChecking = true;
  connectorNotice = "";
  drawConnectors();
  try {
    await renderConnectors();
  } finally {
    relayChecking = false;
    drawConnectors();
  }
}

async function chooseBrowser(providerId: string | null): Promise<void> {
  const operation = beginKeychainMutation();
  if (!operation) return;
  connectorNotice = "";
  drawConnectors();
  try {
    await api("/api/keychain/browser", { method: "POST", body: JSON.stringify({ provider: providerId ?? "" }) });
    if (!keychainOperations.isCurrentEpoch(operation.epoch)) return;
    activeBrowser = providerId;
    browserTab = providerId;
    connectorNotice = providerId
      ? `${browserById(browserProviders, providerId)?.name ?? providerId} is now your browser.`
      : "The agent will use your organization's default browser.";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(operation.epoch)) return;
    connectorNotice = errMessage(e, "Could not switch browser.");
  } finally {
    if (keychainOperations.finishMutation(operation)) drawConnectors();
  }
}

async function connectBrowser(provider: BrowserProvider): Promise<void> {
  const draft = connectDraft(provider);
  if (!draft || keychainOperations.dropInFlight) return;
  const stateEpoch = keychainOperations.beginDrop();
  if (stateEpoch === null) return;
  connectorNotice = "";
  drawConnectors();
  try {
    const result = await api<{ url?: string }>("/api/keychain/drops", {
      method: "POST",
      body: JSON.stringify(draft),
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (!result.url) throw new Error("No one-time page URL was returned.");
    const url = new URL(result.url, window.location.origin);
    browserConnect = { provider, path: `${url.pathname.replace(/\/form$/, "")}${url.search}`, value: "", error: "" };
    connectorNotice = "";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = errMessage(e, "Could not create the one-time page.");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      keychainOperations.finishDrop(stateEpoch);
      drawConnectors();
    }
  }
}

function personalScopeId(): string {
  return appState.me ? `personal:${appState.me.user}` : "";
}

function startGrant(credential: KeychainCredential, opener: HTMLElement): void {
  if (granting) return;
  const targets = grantTargets(keychainContexts, credential.id, keychainGrants, personalScopeId());
  if (grantBlockedReason(credential, targets)) return;
  grantOpener = opener;
  granting = { credential, audienceScopeId: targets[0]?.scopeId ?? "", mode: "standing", purpose: "" };
  grantError = "";
  grantBusy = false;
  drawConnectors();
  queueMicrotask(() => {
    const host = document.querySelector<HTMLElement>(".keychain-page");
    if (host && granting) focusDialogCancel(host);
  });
}

function closeGrant(): void {
  if (grantBusy) return;
  const opener = grantOpener;
  const key = opener?.dataset.confirmKey;
  granting = null;
  grantError = "";
  grantOpener = null;
  drawConnectors();
  restoreDialogFocus(opener, () =>
    key
      ? [...document.querySelectorAll<HTMLElement>("[data-confirm-key]")].find((el) => el.dataset.confirmKey === key)
      : null,
  );
}

function grantCard(): TemplateResult {
  const g = granting!;
  const targets = grantTargets(keychainContexts, g.credential.id, keychainGrants, personalScopeId());
  const label = targets.find((t) => t.scopeId === g.audienceScopeId)?.name ?? "the context you pick";
  return html`<div
    class="kc-dialog-scrim"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeGrant()}
  >
    <article
      class="kc-confirm kc-grant"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kc-grant-title"
      aria-describedby="kc-grant-impact"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeGrant)}
    >
      <span class="kc-eyebrow">Give access</span>
      <h2 id="kc-grant-title">Let a context use ${g.credential.service}</h2>
      <label class="kc-field">
        <span>Give it to</span>
        ${fieldSelect({
          className: "kc-grant-scope",
          value: g.audienceScopeId,
          disabled: grantBusy,
          onChange: (value) => {
            g.audienceScopeId = value;
            drawConnectors();
          },
          options: targets.map((t) => html`<option value=${t.scopeId}>${t.name}</option>`),
        })}
      </label>
      <fieldset class="kc-grant-mode">
        <legend>For how long</legend>
        ${(
          [
            ["standing", "Until I revoke it", "Anyone in that context can use it from now on."],
            ["once", "Just the next turn", "One use, then it lapses on its own."],
          ] as const
        ).map(
          ([value, title, hint]) =>
            html`<label class="kc-grant-choice">
              <input
                type="radio"
                name="kc-grant-mode"
                value=${value}
                .checked=${g.mode === value}
                ?disabled=${grantBusy}
                @change=${() => {
                  g.mode = value;
                  drawConnectors();
                }}
              /><span><strong>${title}</strong><small>${hint}</small></span>
            </label>`,
        )}
      </fieldset>
      <label class="kc-field">
        <span>What it's for <small>(optional)</small></span>
        <input
          type="text"
          class="kc-grant-purpose"
          placeholder="So the team can file expenses"
          .value=${g.purpose}
          ?disabled=${grantBusy}
          @input=${(event: Event) => {
            g.purpose = (event.target as HTMLInputElement).value;
          }}
        />
      </label>
      <p id="kc-grant-impact">${grantImpact(g.mode, g.credential, label)}</p>
      ${grantError ? html`<p class="kc-form-error" role="alert">${grantError}</p>` : ""}
      <div class="kc-form-actions">
        <button class="btn" type="button" data-dialog-cancel ?disabled=${grantBusy} @click=${closeGrant}>Cancel</button
        ><button
          class="btn primary kc-grant-confirm"
          type="button"
          ?disabled=${grantBusy || !g.audienceScopeId}
          @click=${() => void performGrant()}
        >
          ${grantConfirmLabel(g.mode, grantBusy)}
        </button>
      </div>
    </article>
  </div>`;
}

async function performGrant(): Promise<void> {
  const g = granting;
  if (!g || grantBusy) return;
  const label =
    grantTargets(keychainContexts, g.credential.id, keychainGrants, personalScopeId()).find(
      (t) => t.scopeId === g.audienceScopeId,
    )?.name ?? g.audienceScopeId;
  grantBusy = true;
  grantError = "";
  drawConnectors();
  try {
    await api("/api/keychain/grants", {
      method: "POST",
      body: JSON.stringify(grantRequest(g.credential.id, g.audienceScopeId, g.mode, g.purpose)),
    });
    const opener = grantOpener;
    granting = null;
    grantBusy = false;
    grantOpener = null;
    await renderConnectors();
    connectorNotice = grantSuccessNotice(g.mode, g.credential.service, label);
    drawConnectors();
    restoreDialogFocus(opener, () => null);
  } catch (e) {
    if (!granting) return;
    grantError = errMessage(e, "Failed to give access.");
    grantBusy = false;
    drawConnectors();
  }
}

function closeConfirmation(): void {
  const opener = confirmationOpener;
  const key = opener?.dataset.confirmKey;
  confirmation = null;
  confirmationOpener = null;
  drawConnectors();
  restoreDialogFocus(opener, () =>
    key
      ? [...document.querySelectorAll<HTMLElement>("[data-confirm-key]")].find(
          (element) => element.dataset.confirmKey === key,
        )
      : null,
  );
}

export function clearConnectorNotice(): void {
  connectorNotice = "";
}

export function noteConnectorResult(provider: string, status: string): void {
  const name = CONNECTOR_LABELS[provider]?.name ?? provider;
  connectorNotice = status === "connected" ? `${name}: connected.` : `${name}: connection failed.`;
}

function loadingPlaceholder(label: string): TemplateResult {
  return html`<div class="kc-loading"><span class="spinner"></span>${label}</div>`;
}

function drawConnectors(): void {
  if (appState.currentView !== "keychain") return;
  const accountsLoading = connectorsLoading && !connectorsEverLoaded;
  const keysLoadingFresh = keysLoading && !keysEverLoaded;
  const loading = accountsLoading || keysLoadingFresh;
  const entries = Object.entries(connectorProviders);
  const connectorCards = entries.map(([id, p]) => {
    const meta = CONNECTOR_LABELS[id] ?? { name: id, hosts: "" };
    const connected = Boolean(p.connected);
    const needsReconnect = Boolean(p.needsReconnect);
    const available = Boolean(p.available);
    const hosts = new Set(
      (p.hosts ?? [])
        .map((entry) => (typeof entry === "string" ? entry : entry.host))
        .filter((host): host is string => Boolean(host)),
    );
    const credentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
    const credentialsById = new Map(
      credentials.map((credential) => [credential.credentialId, { id: credential.credentialId, kind: "connector" }]),
    );
    const grants = keychainGrants.filter((grant) => isActiveGrant(grant, credentialsById.get(grant.credentialId)));
    const first = credentials.find((credential) => credential.connected && !credential.needsReconnect);
    const grantable: KeychainCredential | null = first
      ? { id: first.credentialId, service: meta.name, kind: "connector" }
      : null;
    const grantableBlocked = grantable
      ? grantBlockedReason(grantable, grantTargets(keychainContexts, grantable.id, keychainGrants, personalScopeId()))
      : "no account";
    let connectionState: TemplateResult | string = html`<span class="kc-state neutral">Not connected</span>`;
    if (needsReconnect) connectionState = html`<span class="kc-state warning">Reconnect needed</span>`;
    else if (connected) connectionState = "";
    return html`
      <article class="kc-resource kc-account">
        <div class="kc-resource-main">
          ${connectorLogo(id)}
          <div class="kc-resource-copy">
            <div class="kc-resource-title-row">
              <h3>${meta.name}</h3>
              ${connectionState}
            </div>
            ${meta.hosts ? html`<div class="kc-resource-meta">${meta.hosts}</div>` : ""}
          </div>
          <div class="kc-resource-actions">
            ${available ? html`<button class="btn" type="button" @click=${() => void startConnector(id)}>${connected || needsReconnect ? "Reconnect" : "Connect account"}</button>` : ""}
            ${
              connected && grantable && !grantableBlocked
                ? html`<button
                    class="kc-text-action"
                    type="button"
                    data-confirm-key=${`grant:${grantable.id}`}
                    ?disabled=${keychainOperations.mutationInFlight}
                    @click=${(event: Event) => startGrant(grantable, event.currentTarget as HTMLElement)}
                  >
                    Give access…
                  </button>`
                : ""
            }
            ${connected || needsReconnect ? html`<button class="kc-text-action danger" type="button" data-confirm-key=${`disconnect:${id}`} ?disabled=${keychainOperations.mutationInFlight} @click=${() => void revokeConnector(id)}>Disconnect</button>` : ""}
          </div>
        </div>
        ${needsReconnect && p.refreshError ? html`<div class="kc-inline-warning" role="status">Refresh failed: ${p.refreshError}</div>` : ""}
        ${
          grants.length
            ? html`<div class="kc-access-block">
                ${grants.map(
                  (grant) =>
                    html` <div class="kc-access-row">
                      <div>
                        <span class="kc-access-label">Access</span>
                        <bdi><strong>${scopeName(grant.audienceScopeId)}</strong></bdi>
                        <span
                          >· ${accessModeLabel(grant.mode)} ·
                          ${grant.purpose}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ""}</span
                        >
                      </div>
                      <button
                        class="kc-text-action"
                        type="button"
                        data-confirm-key=${`revoke:${grant.id}`}
                        ?disabled=${keychainOperations.mutationInFlight}
                        @click=${() => void revokeGrant(grant)}
                      >
                        Revoke
                      </button>
                    </div>`,
                )}
              </div>`
            : ""
        }
      </article>
    `;
  });
  let accountsContent: TemplateResult | TemplateResult[] = [browserCard(), ...connectorCards];
  if (accountsLoading) accountsContent = loadingPlaceholder("Loading accounts\u2026");
  else if (!connectorCards.length)
    accountsContent = [
      browserCard(),
      html`<div class="kc-empty">
        ${icon(Link, 20)}
        <div>
          <strong>No accounts available</strong
          ><span>Your workspace has not configured any account providers yet.</span>
        </div>
      </div>`,
    ];
  let credentialsContent: TemplateResult | TemplateResult[] = keychainCredentials.map(credentialCard);
  if (keysLoadingFresh) credentialsContent = loadingPlaceholder("Loading credentials\u2026");
  else if (!keychainCredentials.length)
    credentialsContent = html`<div class="kc-empty">
      ${icon(KeyRound, 20)}
      <div><strong>No stored credentials</strong><span>Add one without pasting a secret into chat.</span></div>
      <button
        class="btn"
        type="button"
        @click=${() => {
          addingCredential = { service: "", envKey: "", purpose: "" };
          secureDropUrl = null;
          drawConnectors();
        }}
      >
        Add credential
      </button>
    </div>`;
  if (!appState.mainEl) return;
  const section = (
    id: string,
    heading: string,
    count: number,
    content: TemplateResult | TemplateResult[],
    sectionLoading: boolean,
  ) =>
    html`<section class="kc-section" aria-labelledby=${id}>
      <div class="kc-section-head">
        <div class="kc-section-title">
          <h2 id=${id}>${heading}</h2>
          <span>${sectionLoading ? "…" : count}</span>
        </div>
      </div>
      <div class="kc-resource-list">${content}</div>
    </section>`;
  const rows: TemplateResult[] = [];
  const notice = [connectorNotice, loadNotice].filter(Boolean).join(" ");
  if (notice || loading)
    rows.push(html`<div class="status" role="status">${loading ? "Loading your keychain…" : notice}</div>`);
  if (addingCredential) rows.push(addCredentialCard());
  rows.push(
    section("kc-accounts-title", "Linked accounts", entries.length + 1, accountsContent, accountsLoading),
    section(
      "kc-credentials-title",
      "Stored credentials",
      keychainCredentials.length,
      credentialsContent,
      keysLoadingFresh,
    ),
  );
  const host = document.createElement("div");
  host.className = scopedSession.active ? "pane keychain-page scoped-view" : "pane keychain-page";
  render(
    html`
      ${scopedViewTopbar("keychain", () => drawConnectors())}
      <div class="kc-page-content" ?inert=${Boolean(confirmation)}>
        ${listPageTpl({
          title: "Keychain",
          action: {
            label: "Add credential",
            onClick: () => {
              addingCredential = { service: "", envKey: "", purpose: "" };
              secureDropUrl = null;
              drawConnectors();
            },
          },
          rows,
          empty: "Nothing in your keychain yet.",
        })}
      </div>
      ${confirmation ? confirmationCard() : ""}${granting ? grantCard() : ""}
    `,
    host,
  );
  replacePanePreservingFocus(host);
  if (confirmation) focusDialogCancel(host);
}

export async function renderConnectors(): Promise<void> {
  if (appState.currentView !== "keychain") return;
  const seq = appState.viewRenderSeq;
  const load = keychainOperations.beginLoad();
  connectorsLoading = true;
  keysLoading = true;
  drawConnectors();
  const fresh = () =>
    seq === appState.viewRenderSeq && keychainOperations.isCurrentLoad(load) && appState.currentView === "keychain";
  const notices: string[] = [];
  loadNotice = "";
  const applyNotices = () => {
    loadNotice = notices.join(" ");
  };

  const connDone = api<{ providers?: Record<string, ConnectorProvider> }>("/api/connectors").then(
    (value) => {
      if (!fresh()) return;
      connectorProviders = Object.fromEntries(
        Object.entries(value.providers ?? {}).filter(([, p]) => p.available || p.connected || p.needsReconnect),
      );
      connectorsEverLoaded = true;
      connectorsLoading = false;
      applyNotices();
      drawConnectors();
    },
    (reason) => {
      if (!fresh()) return;
      notices.push(errMessage(reason, "Failed to load connectors."));
      connectorsLoading = false;
      applyNotices();
      drawConnectors();
    },
  );
  const keysDone = api<{
    credentials?: KeychainCredential[];
    connectorCredentials?: KeychainConnectorCredential[];
    grants?: KeychainGrant[];
    asks?: KeychainAsk[];
    scopeNames?: Record<string, string>;
    browserProviders?: BrowserProvider[];
    activeBrowser?: string;
  }>("/api/keychain/overview").then(
    (value) => {
      if (!fresh()) return;
      keychainCredentials = (value.credentials ?? []).slice().sort((a, b) => a.service.localeCompare(b.service));
      keychainConnectorCredentials = value.connectorCredentials ?? [];
      keychainGrants = value.grants ?? [];
      keychainAsks = value.asks ?? [];
      keychainScopeNames = value.scopeNames ?? {};
      browserProviders = value.browserProviders ?? [];
      activeBrowser = value.activeBrowser ?? null;
      if (browserTab === null) browserTab = initialBrowserTab(browserProviders, activeBrowser);
      keysEverLoaded = true;
      keysLoading = false;
      applyNotices();
      drawConnectors();
    },
    (reason) => {
      if (!fresh()) return;
      notices.push(errMessage(reason, "Failed to load stored keys."));
      keysLoading = false;
      applyNotices();
      drawConnectors();
    },
  );
  const contextsDone = api<{ contexts?: CoreContext[] }>("/api/contexts").then(
    (value) => {
      if (!fresh()) return;
      keychainContexts = (value.contexts ?? [])
        .filter((context) => context.kind !== "personal" && context.scopeId)
        .map((context) => ({
          scopeId: context.scopeId,
          name: context.name || context.scopeId,
          kind: context.kind as "channel" | "group",
        }));
      drawConnectors();
    },
    () => {
      if (fresh()) keychainContexts = [];
    },
  );
  await Promise.all([connDone, keysDone, contextsDone]);
}

async function deleteCredential(credential: KeychainCredential): Promise<void> {
  const active = keychainGrants.filter(
    (grant) => grant.credentialId === credential.id && isActiveGrant(grant, credential),
  );
  const impact = active.length
    ? ` It will immediately revoke ${active.length} active grant${active.length === 1 ? "" : "s"}: ${active.map((grant) => scopeName(grant.audienceScopeId)).join(", ")}.`
    : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `Delete ${credential.service}?`,
    body: `${impact} Automations using it may stop working. The credential cannot be recovered.`.trim(),
    action: "Delete credential",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performDeleteCredential(credential, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

function beginKeychainMutation() {
  const operation = keychainOperations.beginMutation();
  if (operation) return operation;
  confirmation = null;
  confirmationOpener = null;
  connectorNotice = "Another keychain change is still in progress.";
  drawConnectors();
  return null;
}

async function performDeleteCredential(credential: KeychainCredential, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api(`/api/keychain/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "Could not delete the key.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function revokeGrant(grant: KeychainGrant): Promise<void> {
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `Revoke access for ${scopeName(grant.audienceScopeId)}?`,
    body: `This ${grant.mode === "standing" ? "standing" : "one-time"} access ends immediately. Automations using it may stop working.`,
    action: "Revoke access",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeGrant(grant.id, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeGrant(id: string, stateEpoch: number): Promise<void> {
  try {
    await api(`/api/keychain/grants/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = "Access revoked ✓";
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "Could not revoke access.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function createDrop(): Promise<void> {
  if (keychainOperations.dropInFlight) return;
  if (!addingCredential?.service.trim() || !addingCredential.purpose.trim()) {
    connectorNotice = "Service and purpose are required.";
    return drawConnectors();
  }
  const submittedDraft = { ...addingCredential };
  const stateEpoch = keychainOperations.beginDrop();
  if (stateEpoch === null) return;
  drawConnectors();
  try {
    const result = await api<{ url?: string }>("/api/keychain/drops", {
      method: "POST",
      body: JSON.stringify(submittedDraft),
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (!result.url) throw new Error("No one-time page URL was returned.");
    secureDropUrl = result.url;
    connectorNotice = "Your one-time page is ready.";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = errMessage(e, "Could not create the one-time page.");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      keychainOperations.finishDrop(stateEpoch);
      drawConnectors();
    }
  }
}

async function startConnector(provider: string): Promise<void> {
  const stateEpoch = keychainOperations.captureEpoch();
  connectorNotice = "";
  try {
    const r = await api<{ authorizeUrl?: string }>(`/api/connectors/${encodeURIComponent(provider)}/start`, {
      method: "POST",
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (r.authorizeUrl) {
      location.href = r.authorizeUrl;
      return;
    }
    connectorNotice = "No authorization URL was returned.";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = errMessage(e, "Could not start the connector.");
  }
  drawConnectors();
}

async function revokeConnector(provider: string): Promise<void> {
  const hosts = new Set(
    (connectorProviders[provider]?.hosts ?? [])
      .map((entry) => (typeof entry === "string" ? entry : entry.host))
      .filter((host): host is string => Boolean(host)),
  );
  const providerCredentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
  const credentialIds = new Set(providerCredentials.map((credential) => credential.credentialId));
  const credentialsById = new Map(
    providerCredentials.map((credential) => [
      credential.credentialId,
      { id: credential.credentialId, kind: "connector" },
    ]),
  );
  const active = keychainGrants.filter(
    (grant) => credentialIds.has(grant.credentialId) && isActiveGrant(grant, credentialsById.get(grant.credentialId)),
  );
  const impact = active.length
    ? ` It will also stop ${active.length} active credential grant${active.length === 1 ? "" : "s"} for this account.`
    : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `Disconnect ${CONNECTOR_LABELS[provider]?.name ?? provider}?`,
    body: `${impact} Automations using this account may stop working.`.trim(),
    action: "Disconnect account",
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeConnector(provider, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeConnector(provider: string, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api("/api/connectors/revoke", { method: "POST", body: JSON.stringify({ provider }) });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = errMessage(e, "Could not disconnect.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}
