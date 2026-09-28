import { html, nothing } from "lit";
import { badge, mountTemplate } from "./shared.ts";
import { openProvider, provider as customProviders } from "./settings-providers.ts";
type Data = Record<string, any>;
const STATUSES = ["active", "legacy", "deprecated", "hidden"];
const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  legacy: "Legacy",
  deprecated: "Deprecated",
  hidden: "Hidden",
};
const BUILTIN = ["anthropic", "openai", "openrouter"];
const COLLAPSED = new Set(["openrouter"]);
const LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };
const ENDPOINTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
const label = (provider: string) => LABELS[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
const rank = (provider: string) => (BUILTIN.includes(provider) ? BUILTIN.indexOf(provider) : BUILTIN.length);
let context: Data = {};
const state = {
  entries: [] as Data[],
  classifications: {} as Record<string, string>,
  configured: [] as string[],
  defaults: [] as string[],
  discovery: {} as Record<string, { new: Data[]; missing: Data[] }>,
  search: {} as Record<string, string>,
  syncing: "",
  busy: false,
  message: "",
  tone: "",
};
let redraw = () => {};
function say(message: string, tone = "") {
  state.message = message;
  state.tone = tone;
  redraw();
}
const statusOf = (id: string) => state.classifications[id] || "active";
const pickerIds = () => (state.configured.length ? [...state.configured] : [...state.defaults]);
const providerOf = (id: string) => state.entries.find((model) => model.id === id)?.provider;
const scopePath = (suffix: string) => "/api/scopes/" + encodeURIComponent(context.orgScope()) + suffix;
export function configure(options: Data) {
  context = options;
}
export async function load() {
  const [providers, config] = await Promise.all([
    context.api("GET", "/api/model-providers"),
    context.api("GET", scopePath("")),
  ]);
  if (!providers.ok || !config.ok) return say("The model catalog could not be loaded.", "err");
  state.entries = (providers.data.models || []).filter((model: Data) => model?.id);
  const classifications = config.data.modelClassifications;
  state.classifications = classifications && typeof classifications === "object" ? classifications : {};
  state.configured = Array.isArray(config.data.webuiModels) ? config.data.webuiModels.filter(Boolean) : [];
  state.defaults = Array.isArray(config.data.webuiModelDefaults) ? config.data.webuiModelDefaults.filter(Boolean) : [];
  redraw();
}
async function write(path: string, body: Data, pending: string, done: string, failed: string) {
  if (state.busy) return;
  state.busy = true;
  say(pending, "saving");
  try {
    const response = await context.api("PUT", scopePath(path), body);
    await load();
    if (response.ok) say(done, "ok");
    else say(response.data?.message || failed, "err");
  } finally {
    state.busy = false;
    redraw();
  }
}
function savePicker(ids: string[], done: string) {
  return write("/webui-models", { ids }, "Saving picker…", done, "Could not update the picker.");
}
function toggle(id: string, include: boolean) {
  const base = pickerIds().filter((other) => other !== id);
  const next = include ? [...base, id] : base;
  return savePicker(next, include ? "Added to the picker." : "Removed from the picker.");
}
function reorder(id: string, direction: -1 | 1) {
  const base = pickerIds();
  const siblings = base.filter((other) => providerOf(other) === providerOf(id));
  const neighbor = siblings[siblings.indexOf(id) + direction];
  if (!neighbor) return;
  const next = [...base];
  const from = next.indexOf(id);
  const to = next.indexOf(neighbor);
  [next[from], next[to]] = [next[to]!, next[from]!];
  return savePicker(next, "Order saved.");
}
function classify(id: string, status: string) {
  return write(
    "/model-classifications",
    { modelId: id, status },
    "Saving classification…",
    "Classification saved.",
    "Could not set the classification.",
  );
}
async function discover(provider: string) {
  state.syncing = provider;
  say("Syncing " + label(provider) + "…", "saving");
  try {
    const response = await context.api("GET", "/api/model-providers/" + encodeURIComponent(provider) + "/models");
    if (!response.ok || !response.data) return say("Provider unreachable.", "err");
    const error = response.data.error;
    if (error) {
      if (error === "no_key") return say("No key configured for this provider.", "err");
      if (error === "unreachable") return say("Provider unreachable.", "err");
      return say("Provider returned " + String(error).replace("status_", "HTTP ") + ".", "err");
    }
    const result = {
      new: Array.isArray(response.data.new) ? response.data.new : [],
      missing: Array.isArray(response.data.missing) ? response.data.missing : [],
    };
    state.discovery[provider] = result;
    say(label(provider) + ": " + result.new.length + " new, " + result.missing.length + " missing.", "ok");
  } finally {
    state.syncing = "";
    redraw();
  }
}
function addToCatalog(model: Data) {
  openProvider(
    {
      id: model.provider + "-direct",
      name: label(model.provider),
      protocol: model.provider === "anthropic" ? "anthropic" : "openai",
      baseUrl: ENDPOINTS[model.provider] || "",
      models: [{ id: model.id, name: model.displayName || model.id }],
    },
    false,
  );
}
function editProvider(id: string) {
  const item = customProviders.rows.find((row) => row.id === id);
  if (item) openProvider(item);
}
function row(model: Data, missing: Set<string>, picked: Set<string>, move?: { up: boolean; down: boolean }) {
  const status = statusOf(model.id);
  const builtin = BUILTIN.includes(model.provider);
  return html`<tr class=${status === "hidden" || status === "deprecated" ? "retired" : ""}>
    <td>
      ${model.name || model.id}${missing.has(model.id) ? html`<span class="row-badges">${badge("missing from provider", "warn")}</span>` : nothing}
    </td>
    <td class="mono">${model.id}</td>
    <td>${label(model.provider)}</td>
    <td>${builtin ? "Built-in" : "Custom"}</td>
    <td>
      <span class="picker-cell"
        ><input
          type="checkbox"
          .checked=${picked.has(model.id)}
          ?disabled=${state.busy}
          @change=${(e: Event) => toggle(model.id, (e.target as HTMLInputElement).checked)}
        />${
          move && (move.up || move.down)
            ? html`<span class="catalog-reorder"
                ><button
                  type="button"
                  title="Move up"
                  ?disabled=${!move.up || state.busy}
                  @click=${() => reorder(model.id, -1)}
                >
                  ↑</button
                ><button
                  type="button"
                  title="Move down"
                  ?disabled=${!move.down || state.busy}
                  @click=${() => reorder(model.id, 1)}
                >
                  ↓
                </button></span
              >`
            : nothing
        }</span
      >
    </td>
    <td>
      <select
        .value=${status}
        ?disabled=${state.busy}
        @change=${(e: Event) => classify(model.id, (e.target as HTMLSelectElement).value)}
      >
        ${STATUSES.map((value) => html`<option value=${value} .selected=${value === status}>${STATUS_LABELS[value]}</option>`)}
      </select>
    </td>
    <td>
      ${builtin ? nothing : html`<button type="button" @click=${() => editProvider(model.provider)}>Edit provider</button>`}
    </td>
  </tr>`;
}
function group(provider: string, missing: Set<string>, picked: Set<string>, order: Map<string, number>) {
  const models = state.entries.filter((model) => model.provider === provider);
  const chosen = models.filter((model) => picked.has(model.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const rest = models.filter((model) => !picked.has(model.id));
  const collapsed = COLLAPSED.has(provider);
  const query = (state.search[provider] || "").trim().toLowerCase();
  const matches = query
    ? rest
        .filter((model) => model.id.toLowerCase().includes(query) || (model.name || "").toLowerCase().includes(query))
        .slice(0, 25)
    : [];
  return html`<tr class="catalog-group">
      <td colspan="7">
        ${label(provider)}<span class="muted"
          >${chosen.length + " in picker" + (collapsed ? " · " + rest.length + " more available" : "")}</span
        >
      </td>
    </tr>
    ${chosen.map((model, i) => row(model, missing, picked, { up: i > 0, down: i < chosen.length - 1 }))}
    ${
      collapsed
        ? html`<tr class="catalog-search">
              <td colspan="7">
                <input
                  type="search"
                  placeholder=${"Search " + rest.length + " more " + label(provider) + " models to add…"}
                  .value=${state.search[provider] || ""}
                  @input=${(e: Event) => {
                    state.search[provider] = (e.target as HTMLInputElement).value;
                    redraw();
                  }}
                />
              </td>
            </tr>
            ${matches.map((model) => row(model, missing, picked))}`
        : rest.map((model) => row(model, missing, picked))
    }`;
}
function template() {
  const known = new Set(state.entries.map((model) => model.id));
  const missing = new Set<string>();
  const fresh = new Map<string, Data>();
  for (const [provider, result] of Object.entries(state.discovery)) {
    for (const model of result.missing) if (model?.id) missing.add(model.id);
    for (const model of result.new)
      if (model?.id && !known.has(model.id) && !fresh.has(model.id)) fresh.set(model.id, { ...model, provider });
  }
  const base = pickerIds();
  const order = new Map(base.map((id, index) => [id, index]));
  const picked = new Set(base);
  const providers = [...new Set(state.entries.map((model) => model.provider as string))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  return html`<section class="card" id="card-model-catalog">
    <div class="head">
      <h2>Model catalog</h2>
      <p>
        Every model in the picker, with its lifecycle status. Sync a provider to see which models it has added or
        retired, add a newly shipped model to the catalog, and mark models legacy, deprecated, or hidden. Deprecated and
        hidden models drop out of the web UI and base-model pickers; legacy stays selectable.
      </p>
    </div>
    <div class="body">
      <div class="model-catalog-sync">
        <span class="muted">Sync from provider:</span>
        ${BUILTIN.map(
          (provider) =>
            html`<button
              type="button"
              data-discover=${provider}
              ?disabled=${state.syncing === provider}
              @click=${() => discover(provider)}
            >
              ${label(provider)}
            </button>`,
        )}
        <span class=${"status" + (state.tone ? " " + state.tone : "")} id="st-model-catalog">${state.message}</span>
      </div>
      <table class="table" id="model-catalog-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Id</th>
            <th>Provider</th>
            <th>Source</th>
            <th>In picker</th>
            <th>Classification</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="model-catalog-rows">
          ${providers.map((provider) => group(provider, missing, picked, order))}
          ${[...fresh.values()].map(
            (model) =>
              html`<tr>
                <td>${model.displayName || model.id}<span class="row-badges">${badge("new", "info")}</span></td>
                <td class="mono">${model.id}</td>
                <td>${label(model.provider)}</td>
                <td class="muted">Not in catalog</td>
                <td></td>
                <td></td>
                <td>
                  <button type="button" class="primary" @click=${() => addToCatalog(model)}>Add to catalog</button>
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
      <p class="muted" id="model-catalog-empty" ?hidden=${state.entries.length + fresh.size > 0}>
        No models in the catalog yet — add a provider key above.
      </p>
    </div>
  </section>`;
}
export function mount() {
  redraw = mountTemplate('template[data-settings-card="card-model-catalog"]', template);
}
