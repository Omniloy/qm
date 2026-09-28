import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { settingStatus } from "./setting-controls.ts";
import { context } from "./integrations-state.ts";

export type McpServer = {
  id: string;
  name: string;
  url: string;
  auth: "none" | "bearer" | "client-credentials";
  credentialScope?: "shared" | "per-user";
  credentialHost?: string;
  credentialAccountType?: "default" | "personal" | "company";
  hasBearerToken?: boolean;
  hasClientSecret?: boolean;
  clientId?: string;
  readOnly: boolean;
  enabled: boolean;
  updatedBy?: string;
};
type McpTool = { name: string; serverId: string };
const blank = () => ({
  id: "",
  name: "",
  url: "",
  auth: "none" as McpServer["auth"],
  bearerToken: "",
  clientId: "",
  clientSecret: "",
  credentialScope: "shared" as NonNullable<McpServer["credentialScope"]>,
  credentialHost: "",
  credentialAccountType: "default" as NonNullable<McpServer["credentialAccountType"]>,
  readOnly: false,
  enabled: true,
});
export type McpDraft = ReturnType<typeof blank>;

export class McpServersState {
  servers: McpServer[] = [];
  tools: McpTool[] = [];
  available = true;
  editor = false;
  editing = "";
  draft: McpDraft = blank();
  saving = false;
  message = "";
  tone = "";
  render = () => {};
  setStatus(message: string, tone: string) {
    this.message = message;
    this.tone = tone;
    this.render();
  }
  change<K extends keyof McpDraft>(field: K, value: McpDraft[K]) {
    this.draft = { ...this.draft, [field]: value };
    this.render();
  }
  open(server?: McpServer) {
    this.editing = server?.id ?? "";
    this.draft = server
      ? {
          ...blank(),
          id: server.id,
          name: server.name,
          url: server.url,
          auth: server.auth,
          clientId: server.clientId ?? "",
          credentialScope: server.credentialScope ?? "shared",
          credentialHost: server.credentialHost ?? "",
          credentialAccountType: server.credentialAccountType ?? "default",
          readOnly: server.readOnly,
          enabled: server.enabled,
        }
      : blank();
    this.editor = true;
    this.message = "";
    this.render();
  }
  close() {
    this.editor = false;
    this.editing = "";
    this.draft = blank();
    this.render();
  }
  async load() {
    const result = await context.api("GET", "/api/mcp-servers");
    if (!result.ok) {
      this.available = result.status !== 404;
      return this.setStatus(
        result.status === 403 ? "Only an org admin can manage MCP servers." : result.data?.message || "",
        result.status === 404 ? "" : "err",
      );
    }
    this.available = true;
    this.servers = result.data?.servers || [];
    this.tools = result.data?.tools || [];
    this.render();
  }
  body() {
    const d = this.draft;
    return {
      name: d.name.trim() || d.id,
      url: d.url.trim(),
      auth: d.auth,
      credentialScope: d.credentialScope,
      ...(d.credentialScope === "per-user"
        ? { credentialHost: d.credentialHost.trim(), credentialAccountType: d.credentialAccountType }
        : {}),
      ...(d.auth === "bearer" && d.bearerToken ? { bearerToken: d.bearerToken } : {}),
      ...(d.auth === "client-credentials"
        ? { clientId: d.clientId.trim(), ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}) }
        : {}),
      readOnly: d.readOnly,
      enabled: d.enabled,
    };
  }
  async save() {
    if (this.saving) return;
    const id = this.draft.id.trim();
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id))
      return this.setStatus("ID: 2-40 lowercase letters, digits, or hyphens, starting with a letter.", "err");
    if (!this.draft.url.trim()) return this.setStatus("Server URL is required.", "err");
    this.saving = true;
    this.setStatus("Connecting and listing tools…", "saving");
    try {
      const result = await context.api("PUT", "/api/mcp-servers/" + encodeURIComponent(id), this.body());
      if (!result.ok) return this.setStatus(result.data?.message || "Save failed.", "err");
      const count = result.data?.tools?.length;
      this.close();
      await this.load();
      this.setStatus(count === undefined ? "Saved" : `Saved · ${count} tool${count === 1 ? "" : "s"} found`, "ok");
    } catch {
      this.setStatus("Save failed. Please try again.", "err");
    } finally {
      this.saving = false;
      this.render();
    }
  }
  async remove(server: McpServer) {
    if (!confirm(`Remove the MCP server "${server.name}"? Agents lose its tools on their next turn.`)) return;
    const result = await context.api("DELETE", "/api/mcp-servers/" + encodeURIComponent(server.id));
    if (!result.ok) return this.setStatus(result.data?.message || "Delete failed.", "err");
    if (this.editing === server.id) this.close();
    await this.load();
    this.setStatus("Removed", "ok");
  }
}
export const mcp = new McpServersState();

const badge = (text: string, tone: string) => html`<span class=${"badge " + tone}>${text}</span>`;
const AUTH_LABELS = { none: "No auth", bearer: "Bearer token", "client-credentials": "OAuth client credentials" };

function rows() {
  if (!mcp.servers.length)
    return "No MCP servers registered. Add one to give every agent in the organization its tools.";
  return repeat(
    mcp.servers,
    (s) => s.id,
    (s) => {
      const tools = mcp.tools.filter((t) => t.serverId === s.id).length;
      const secretMissing =
        (s.auth === "bearer" && !s.hasBearerToken) || (s.auth === "client-credentials" && !s.hasClientSecret);
      return html`<div class=${classMap({ "credential-row": true, "is-editing": s.id === mcp.editing })}>
        <div class="credential-main">
          <div class="credential-title"><strong>${s.name}</strong><span class="credential-slug">${s.id}</span></div>
          <div class="hint">${s.url}${s.updatedBy ? " · by " + s.updatedBy : ""}</div>
          <div class="credential-badges">
            ${badge(s.enabled ? "Enabled" : "Disabled", s.enabled ? "ok" : "warn")}${badge(AUTH_LABELS[s.auth], "info")}${badge(s.credentialScope === "per-user" ? "Each person's account" : "Shared identity", "muted")}${badge(tools + " tool" + (tools === 1 ? "" : "s"), tools ? "ok" : "muted")}${s.readOnly ? badge("Read-only", "muted") : nothing}${secretMissing ? badge("Secret missing", "err") : nothing}
          </div>
        </div>
        <div class="credential-actions">
          <button type="button" @click=${() => mcp.open(s)}>Edit</button
          ><button type="button" class="rowbtn danger" aria-label=${"Remove " + s.name} @click=${() => mcp.remove(s)}>
            Remove
          </button>
        </div>
      </div>`;
    },
  );
}

function field(label: string, input: unknown, hint?: string) {
  return html`<label style="display: block; margin-bottom: 8px"
    >${label}${input}${hint ? html`<span class="field-hint">${hint}</span>` : nothing}</label
  >`;
}

function text(key: "id" | "name" | "url" | "clientId" | "credentialHost", placeholder: string, disabled = false) {
  return html`<input
    type="text"
    id=${"mcp-" + key}
    .value=${mcp.draft[key]}
    ?disabled=${disabled}
    autocomplete="off"
    spellcheck="false"
    placeholder=${placeholder}
    style="width: 100%"
    @input=${(e: Event) => mcp.change(key, (e.target as HTMLInputElement).value)}
  />`;
}

function secret(key: "bearerToken" | "clientSecret", isSet: boolean | undefined) {
  return html`<input
    type="password"
    id=${"mcp-" + key}
    .value=${mcp.draft[key]}
    autocomplete="off"
    placeholder=${isSet ? "•••• set (leave blank to keep)" : "(write-only)"}
    style="width: 100%"
    @input=${(e: Event) => mcp.change(key, (e.target as HTMLInputElement).value)}
  />`;
}

function select<K extends "auth" | "credentialScope" | "credentialAccountType">(
  key: K,
  options: [McpDraft[K], string][],
) {
  return html`<select
    id=${"mcp-" + key}
    style="width: 100%"
    @change=${(e: Event) => mcp.change(key, (e.target as HTMLSelectElement).value as McpDraft[K])}
  >
    ${options.map(([value, label]) => html`<option value=${value} ?selected=${mcp.draft[key] === value}>${label}</option>`)}
  </select>`;
}

function checkbox(key: "readOnly" | "enabled", label: string) {
  return html`<label style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 8px"
    ><input
      type="checkbox"
      id=${"mcp-" + key}
      style="width: auto"
      .checked=${mcp.draft[key]}
      @change=${(e: Event) => mcp.change(key, (e.target as HTMLInputElement).checked)}
    />${label}</label
  >`;
}

function editor() {
  const d = mcp.draft;
  const existing = mcp.servers.find((s) => s.id === mcp.editing);
  return html`<div class="body" id="mcp-editor" style="border-top: 1px solid var(--border, #2a2a2a); padding-top: 12px">
    <p class="hint">${mcp.editing ? "Editing " + (existing?.name || mcp.editing) : "Register an MCP server"}</p>
    ${field("ID", text("id", "e.g. linear", !!mcp.editing), "Prefixes the tool names agents see. Can't be changed later.")}
    ${field("Name", text("name", "Display name"))}
    ${field("Server URL", text("url", "https://example.com/mcp"), "Streamable HTTP endpoint. Saving checks that it answers tools/list.")}
    ${field(
      "Authentication",
      select("auth", [
        ["none", AUTH_LABELS.none],
        ["bearer", AUTH_LABELS.bearer],
        ["client-credentials", AUTH_LABELS["client-credentials"]],
      ]),
    )}
    ${d.auth === "bearer" ? field("Bearer token", secret("bearerToken", existing?.hasBearerToken)) : nothing}
    ${d.auth === "client-credentials" ? html`${field("Client ID", text("clientId", "OAuth client ID"))}${field("Client secret", secret("clientSecret", existing?.hasClientSecret))}` : nothing}
    ${field(
      "Whose identity calls tools",
      select("credentialScope", [
        ["shared", "Shared: every caller uses the credential above"],
        ["per-user", "Per person: each caller's own connected account"],
      ]),
      d.credentialScope === "per-user"
        ? "The credential above is only used to list tools. Each call uses the caller's token for the host below, from their connected accounts. Requires HTTPS."
        : undefined,
    )}
    ${
      d.credentialScope === "per-user"
        ? html`${field("Account host", text("credentialHost", "accounts.example.com"), "The connected-account host whose token is sent to this server.")}${field(
            "Account slot",
            select("credentialAccountType", [
              ["default", "Default"],
              ["personal", "Personal"],
              ["company", "Company"],
            ]),
          )}`
        : nothing
    }
    ${checkbox("readOnly", "Read-only: its tools only read data, so they stay available in read-only turns")}
    ${checkbox("enabled", "Enabled")}
  </div>`;
}

export function mcpCard() {
  return html`<section class=${classMap({ card: true, hidden: !mcp.available })} id="card-mcp-servers">
    <div class="head">
      <h2>MCP servers</h2>
      <p>
        Remote MCP servers whose tools every agent in the organization can call. Tokens and secrets are write-only and
        stay in the backend. Applies org-wide.
      </p>
    </div>
    <div class="body">
      <div id="mcp-list" class=${mcp.servers.length ? "" : "hint"}>${rows()}</div>
    </div>
    ${mcp.editor ? editor() : nothing}
    <div class="foot">
      <button type="button" id="mcp-add" class=${mcp.editor ? "hidden" : ""} @click=${() => mcp.open()}>
        + Add MCP server</button
      ><button
        class=${classMap({ primary: true, hidden: !mcp.editor })}
        id="mcp-save"
        ?disabled=${mcp.saving}
        @click=${() => mcp.save()}
      >
        ${mcp.editing ? "Save changes" : "Connect server"}</button
      ><button class=${mcp.editor ? "" : "hidden"} id="mcp-cancel" @click=${() => mcp.close()}>Cancel</button
      >${settingStatus(mcp, "st-mcp-servers")}
    </div>
  </section>`;
}
