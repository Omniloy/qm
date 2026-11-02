import { html, nothing } from "lit";
import { badge, card, renderer } from "./shared.ts";

type Services = Record<string, any>;
type Tab = "apps" | "sandboxes" | "files";
type SortKey = "size" | "lastUsed" | "created";

const POLL_INTERVAL_MS = 5_000;
const POLL_ATTEMPTS = 360;
const LOW_FREE_RATIO = 0.1;
const DAY_MS = 86_400_000;

const memory = {
  q: "",
  user: "",
  scope: "",
  status: "",
  sort: "size" as SortKey,
  tab: "apps" as Tab,
  expanded: new Set<string>(),
  polling: false,
  measuring: false,
  current: null as DiskView | null,
};

const ERROR_TEXT: Record<string, string> = {
  version_live: "That copy is live and cannot be deleted.",
  container_running: "The container is running. Stop it before removing it.",
  docker_unavailable: "Docker is not available on this deployment.",
  not_found: "It no longer exists. Refresh the page.",
};

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, n);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

const sum = (values: Array<number | null | undefined>) => values.reduce<number>((t, v) => t + (Number(v) || 0), 0);

const scopeKindOf = (id: string) => (id.includes(":") ? id.slice(0, id.indexOf(":")) : "");

const STATUS_TONE: Record<string, string> = { running: "ok", archived: "muted" };

function idleSummary(auto: any): string {
  if (auto.days != null)
    return `Apps nobody has opened for ${auto.days} days are stopped. They start again on the next visit.`;
  if (auto.envTtlMs) return `Not set here. The server default stops apps idle for ${fmtDuration(auto.envTtlMs)}.`;
  return "Off. Apps keep running until someone stops them.";
}

function sandboxLastUsed(r: any, relTime: (ts: number) => string): string {
  if (r.running) return "Now";
  return r.lastUsedAt ? relTime(r.lastUsedAt) : "Unknown";
}

function sandboxState(r: any) {
  if (!r.container) return "no container";
  return badge(r.state || (r.running ? "running" : "stopped"), r.running ? "ok" : "warn");
}

const fmtDate = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleDateString() : "n/a");

function fmtDuration(ms: number): string {
  if (ms >= DAY_MS) return `${Math.round(ms / DAY_MS)} d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

export function contactHref(app: any, appName: string): string {
  const size = fmtBytes(app.totalBytes);
  const copies = app.versions?.length ?? 0;
  const subject = `Tu app "${appName}" ocupa ${size} / Your app "${appName}" uses ${size}`;
  const body = [
    "Hola,",
    "",
    `Tu app "${appName}" (${app.url}) ocupa ${size} en el servidor, contando ${copies === 1 ? "1 copia guardada" : `${copies} copias guardadas`}.`,
    "Si ya no la necesitas, ¿puedes borrarla o borrar sus copias antiguas? Así liberamos espacio para todos.",
    "",
    "Gracias.",
    "",
    "---",
    "",
    "Hi,",
    "",
    `Your app "${appName}" (${app.url}) uses ${size} on the server, counting ${copies === 1 ? "1 saved copy" : `${copies} saved copies`}.`,
    "If you no longer need it, could you delete it or its old copies? That frees space for everyone.",
    "",
    "Thanks.",
  ].join("\n");
  return `mailto:${encodeURIComponent(app.ownerEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export class DiskView {
  root: HTMLElement;
  data: any;
  services: Services;
  paint: (template: unknown) => void;
  notice = "";
  policyNotice = "";
  scopeLabels: Map<string, { label: string; kind: string }>;
  constructor(root: HTMLElement, data: any, services: Services) {
    this.root = root;
    this.data = data;
    this.services = services;
    this.paint = renderer(root);
    this.scopeLabels = new Map((data.scopes || []).map((s: any) => [s.id, { label: s.label || s.id, kind: s.kind }]));
    memory.measuring = !!data.measuring;
    memory.current = this;
    this.renderShell();
    this.draw();
  }

  get report(): any {
    return this.data.report;
  }

  scopeLabel(id: string | null | undefined): string {
    if (!id) return "";
    return this.scopeLabels.get(id)?.label || id;
  }

  scopeKind(id: string | null | undefined): string {
    if (!id) return "";
    return this.scopeLabels.get(id)?.kind || scopeKindOf(id);
  }

  appName(app: any): string {
    return app.displayName || app.name || app.id;
  }

  renderShell() {
    const report = this.report;
    const fs = report?.filesystem;
    const docker = report?.docker;
    this.services.defaultShell({
      stats: report
        ? [
            [fs ? `${fmtBytes(fs.usedBytes)} / ${fmtBytes(fs.totalBytes)}` : "n/a", "Filesystem used"],
            [fs ? fmtBytes(fs.availableBytes) : "n/a", "Available"],
            [docker?.available ? fmtBytes(docker.totalBytes) : "n/a", "Docker"],
            [report.postgres ? fmtBytes(report.postgres.totalBytes) : "n/a", "Postgres"],
          ]
        : [],
      search: {
        value: memory.q,
        placeholder: "app, owner or scope",
        onInput: (value: string) => {
          memory.q = value;
          this.draw();
        },
      },
    });
  }

  async mutate(method: string, path: string, body?: unknown): Promise<boolean> {
    const r = await this.services.api(method, path, body);
    if (!r.ok) {
      const code = r.data?.error;
      this.notice = (code && ERROR_TEXT[code]) || r.data?.message || code || `Request failed (${r.status}).`;
      this.draw();
      return false;
    }
    this.notice = "";
    await this.services.refresh();
    return true;
  }

  async measure() {
    if (memory.polling || memory.measuring) return;
    memory.polling = true;
    const before = this.report?.measuredAt ?? 0;
    this.draw();
    const wait = this.services.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    try {
      const r = await this.services.api("POST", "/api/disk/measure");
      if (!r.ok) {
        this.notice = r.data?.message || r.data?.error || `Could not start a measurement (${r.status}).`;
        return;
      }
      memory.measuring = true;
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        await wait(POLL_INTERVAL_MS);
        if ((await this.services.refresh()) === false) break;
        if (!memory.measuring || (memory.current?.report?.measuredAt ?? 0) > before) break;
      }
    } finally {
      memory.polling = false;
      memory.current?.draw();
    }
  }

  stopApp(app: any) {
    return this.mutate("POST", `/api/disk/apps/${encodeURIComponent(app.id)}/stop`);
  }

  deleteApp(app: any) {
    const ok = globalThis.confirm(
      `Delete the app "${this.appName(app)}" (${fmtBytes(app.totalBytes)}) with its stored data, source history and all its copies? This cannot be undone.`,
    );
    if (!ok) return;
    return this.mutate("DELETE", `/api/disk/apps/${encodeURIComponent(app.id)}`);
  }

  deleteVersion(app: any, v: any) {
    const ok = globalThis.confirm(
      `Delete copy v${v.version} of "${this.appName(app)}" (${fmtBytes(v.sizeBytes)})? This cannot be undone.`,
    );
    if (!ok) return;
    return this.mutate("DELETE", `/api/disk/apps/${encodeURIComponent(app.id)}/versions/${v.version}`);
  }

  removeContainer(row: any) {
    const ok = globalThis.confirm(
      `Remove the stopped container ${row.container}? The home volume is kept, so no files are lost.`,
    );
    if (!ok) return;
    return this.mutate("DELETE", `/api/disk/sandbox-containers/${encodeURIComponent(row.container)}`);
  }

  async saveIdleStop(days: number | "") {
    if (days !== "" && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
      this.policyNotice = "Enter a whole number of days from 1 to 365.";
      this.draw();
      return;
    }
    const path = `/api/scopes/${encodeURIComponent(this.data.orgScopeId)}/app-idle-stop`;
    const r = await this.services.api("PUT", path, { days });
    if (!r.ok) {
      this.policyNotice = r.data?.message || r.data?.error || `Could not save (${r.status}).`;
      this.draw();
      return;
    }
    this.policyNotice = "";
    await this.services.refresh();
  }

  summary() {
    const s = this.services;
    const report = this.report;
    const busy = memory.polling || memory.measuring;
    const button = html`<button type="button" class="disk-measure" ?disabled=${busy} @click=${() => this.measure()}>
      ${busy ? "Measuring…" : "Measure now"}
    </button>`;
    if (!report) {
      return html`<div class="disk-summary">
        <p class="subline">Not measured yet. Measuring walks every folder and can take a few minutes.</p>
        ${button}
      </div>`;
    }
    const fs = report.filesystem;
    const freeRatio = fs && fs.totalBytes > 0 ? fs.availableBytes / fs.totalBytes : null;
    return html`<div class="disk-summary">
      <p class="subline">
        Measured ${s.relTime(report.measuredAt)}${fs ? html` · ${fs.path}` : nothing}
        ${
          freeRatio == null
            ? nothing
            : badge(
                `${fmtBytes(fs.availableBytes)} free (${Math.round(freeRatio * 100)}%)`,
                freeRatio < LOW_FREE_RATIO ? "err" : "ok",
              )
        }
      </p>
      ${
        report.docker?.available
          ? nothing
          : html`<p class="subline disk-docker-note">Docker not available: ${report.docker?.reason || "unknown"}</p>`
      }
      ${button}
    </div>`;
  }

  components() {
    const report = this.report;
    if (!report) return nothing;
    const total = report.filesystem?.totalBytes || 0;
    const rows: any[] = [...(report.components || [])];
    if (report.orphanSnapshotBytes != null) {
      rows.push({
        id: "orphans",
        label: "Unreferenced app copies (cleaned hourly)",
        bytes: report.orphanSnapshotBytes,
      });
    }
    rows.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    const bar = (bytes: number | null) =>
      total > 0 && bytes != null
        ? html`<span class="disk-bar" title=${`${((bytes / total) * 100).toFixed(1)}% of the disk`}
            ><span style=${`width:${Math.min(100, (bytes / total) * 100).toFixed(2)}%`}></span
          ></span>`
        : nothing;
    const tables = report.postgres?.tables || [];
    return card(
      "Components",
      "What is using the disk, largest first. The bar shows each part's share of the whole filesystem.",
      html`<div class="tablewrap">
        <table class="disk-components">
          <thead>
            <tr>
              <th>Component</th>
              <th>Size</th>
              <th>Share</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (c) =>
                html`<tr data-component=${c.id}>
                  <td>
                    ${
                      c.id === "postgres" && tables.length
                        ? html`<details>
                            <summary>${c.label}</summary>
                            <ul class="disk-tables">
                              ${tables.map((t: any) => html`<li><span class="mono">${t.name}</span> ${fmtBytes(t.bytes)}</li>`)}
                            </ul>
                          </details>`
                        : c.label
                    }
                  </td>
                  <td class="num">
                    ${fmtBytes(c.bytes)}${c.count != null ? html` <span class="subline">(${c.count})</span>` : nothing}
                  </td>
                  <td>${bar(c.bytes)}</td>
                  <td class="subline">${c.note || ""}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`,
    );
  }

  policies() {
    const d = this.data;
    const auto = d.autoStop || {};
    const control = auto.managedScaleToZero
      ? html`<p class="subline">Idle apps are stopped by the platform (managed scale to zero).</p>`
      : html`<div class="disk-policy-row">
            <label
              >Stop apps not opened for
              <input
                type="number"
                min="1"
                max="365"
                step="1"
                class="disk-idle-days"
                .value=${auto.days == null ? "" : String(auto.days)}
              />
              days</label
            >
            <button
              type="button"
              class="disk-idle-save"
              @click=${(e: Event) => {
                const field = (e.target as HTMLElement)
                  .closest(".disk-policy-row")
                  ?.querySelector<HTMLInputElement>(".disk-idle-days");
                const raw = field?.value.trim() ?? "";
                void this.saveIdleStop(raw === "" ? "" : Number(raw));
              }}
            >
              Save
            </button>
            <button
              type="button"
              class="disk-idle-off"
              ?disabled=${auto.days == null}
              @click=${() => this.saveIdleStop("")}
            >
              Off
            </button>
          </div>
          <p class="subline">${idleSummary(auto)}</p>`;
    return card(
      "Policies",
      null,
      html`<p>
          Copies kept per app: <strong>${d.retention?.maxVersions ?? 3}</strong> (older copies are deleted
          automatically).
        </p>
        ${control} ${this.policyNotice ? html`<p class="flag-err">${this.policyNotice}</p>` : nothing}
        <p class="subline">Apps are never deleted automatically.</p>`,
    );
  }

  users(): Array<[string, string]> {
    const users = new Map<string, string>();
    for (const app of this.data.apps || []) {
      if (app.createdBy && !users.has(app.createdBy))
        users.set(app.createdBy, app.ownerName || app.ownerEmail || app.createdBy);
    }
    const personal = [
      ...(this.report?.sandboxes || []).map((s: any) => s.scopeId),
      ...(this.report?.files || []).map((f: any) => f.scopeId),
    ].filter((id: any) => typeof id === "string" && scopeKindOf(id) === "personal");
    for (const id of personal) {
      const principal = id.slice("personal:".length);
      if (!users.has(principal)) users.set(principal, this.scopeLabel(id));
    }
    return [...users].sort((a, b) => a[1].localeCompare(b[1]));
  }

  filters() {
    const scopes = (this.data.scopes || []).filter((s: any) => s.kind !== "personal");
    const select = (
      cls: string,
      label: string,
      value: string,
      options: Array<[string, string]>,
      set: (v: string) => void,
    ) =>
      html`<label class="disk-filter"
        >${label}
        <select
          class=${cls}
          @change=${(e: Event) => {
            set((e.target as HTMLSelectElement).value);
            this.draw();
          }}
        >
          ${options.map(([v, text]) => html`<option value=${v} ?selected=${v === value}>${text}</option>`)}
        </select></label
      >`;
    return html`<div class="disk-filters">
      ${select("disk-user", "User", memory.user, [["", "Everyone"], ...this.users()], (v) => (memory.user = v))}
      ${select(
        "disk-scope",
        "Project or scope",
        memory.scope,
        [["", "All"], ...scopes.map((s: any): [string, string] => [s.id, `${s.label || s.id} (${s.kind})`])],
        (v) => (memory.scope = v),
      )}
      ${select(
        "disk-status",
        "Status",
        memory.status,
        [
          ["", "Any"],
          ["running", "Running"],
          ["stopped", "Stopped"],
          ["archived", "Archived"],
        ],
        (v) => (memory.status = v),
      )}
      ${select(
        "disk-sort",
        "Sort",
        memory.sort,
        [
          ["size", "Size"],
          ["lastUsed", "Least recently used"],
          ["created", "Created"],
        ],
        (v) => (memory.sort = v as SortKey),
      )}
    </div>`;
  }

  matchesText(parts: unknown[]): boolean {
    const q = memory.q.trim().toLowerCase();
    return !q || parts.filter(Boolean).join(" ").toLowerCase().includes(q);
  }

  sorted<T>(rows: T[], size: (r: T) => number, lastUsed: (r: T) => number | null, created: (r: T) => number | null) {
    if (memory.sort === "lastUsed")
      return rows.slice().sort((a, b) => (lastUsed(a) ?? -1) - (lastUsed(b) ?? -1) || size(b) - size(a));
    const key = memory.sort === "created" ? created : size;
    return rows.slice().sort((a, b) => (key(b) ?? -1) - (key(a) ?? -1) || size(b) - size(a));
  }

  visibleApps(): any[] {
    const apps = (this.data.apps || []).filter(
      (a: any) =>
        (!memory.user || a.createdBy === memory.user) &&
        (!memory.scope || a.ownerScopeId === memory.scope || a.createdInScope === memory.scope) &&
        (!memory.status || a.status === memory.status) &&
        this.matchesText([
          this.appName(a),
          a.name,
          a.ownerName,
          a.ownerEmail,
          a.createdBy,
          this.scopeLabel(a.ownerScopeId),
        ]),
    );
    return this.sorted(
      apps,
      (a) => Number(a.totalBytes) || 0,
      (a) => a.lastUsedAt,
      (a) => a.createdAt,
    );
  }

  visibleSandboxes(): any[] {
    const rows = (this.report?.sandboxes || []).filter(
      (r: any) =>
        (!memory.user || r.scopeId === `personal:${memory.user}`) &&
        (!memory.scope || r.scopeId === memory.scope) &&
        (!memory.status || (memory.status === "running" ? r.running : memory.status === "stopped" && !r.running)) &&
        this.matchesText([this.scopeLabel(r.scopeId), r.scopeId, r.volume, r.container]),
    );
    return this.sorted(
      rows,
      (r) => sum([r.containerBytes, r.volumeBytes]),
      (r) => r.lastUsedAt,
      () => null,
    );
  }

  visibleFiles(): any[] {
    return (this.report?.files || [])
      .filter(
        (r: any) =>
          (!memory.user || r.scopeId === `personal:${memory.user}`) &&
          (!memory.scope || r.scopeId === memory.scope) &&
          this.matchesText([this.scopeLabel(r.scopeId), r.scopeId]),
      )
      .sort((a: any, b: any) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0));
  }

  owner(app: any) {
    const name = app.ownerName || app.createdBy;
    if (!app.ownerEmail) return html`<div>${name}</div>`;
    return html`<div>${name}</div>
      ${name === app.ownerEmail ? nothing : html`<div class="subline mono">${app.ownerEmail}</div>`}
      <div class="disk-owner-actions">
        <button
          type="button"
          class="rowbtn disk-copy"
          @click=${() => void globalThis.navigator?.clipboard?.writeText(app.ownerEmail)}
        >
          Copy
        </button>
        <a class="link disk-contact" href=${contactHref(app, this.appName(app))}>Contact</a>
      </div>`;
  }

  statusBadge(status: string) {
    return badge(status, STATUS_TONE[status] ?? "warn");
  }

  versionRows(app: any) {
    const versions = (app.versions || []).slice().sort((a: any, b: any) => b.version - a.version);
    return html`<tr class="disk-versions-row">
      <td colspan="9">
        <table class="disk-versions">
          <tbody>
            ${versions.map(
              (v: any) =>
                html`<tr data-version=${v.version}>
                  <td class="mono">v${v.version}</td>
                  <td class="num">${fmtBytes(v.sizeBytes)}</td>
                  <td>${fmtDate(v.createdAt)}</td>
                  <td>${v.live ? badge("Live", "ok") : nothing}</td>
                  <td>
                    ${
                      v.live
                        ? nothing
                        : html`<button
                            type="button"
                            class="rowbtn danger disk-version-delete"
                            @click=${() => this.deleteVersion(app, v)}
                          >
                            Delete
                          </button>`
                    }
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </td>
    </tr>`;
  }

  appsTable() {
    const s = this.services;
    const apps = this.visibleApps();
    if (!apps.length)
      return html`<p class="empty">${this.data.apps?.length ? "No apps match." : "No published apps."}</p>`;
    return html`<div class="tablewrap">
      <table class="disk-apps">
        <thead>
          <tr>
            <th>App</th>
            <th>Owner</th>
            <th>Scope</th>
            <th>Status</th>
            <th>Copies</th>
            <th>Size</th>
            <th>Last used</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${apps.map((app: any) => {
            const open = memory.expanded.has(app.id);
            return html`<tr data-app=${app.id}>
                <td>
                  <a class="link" href=${app.url} target="_blank" rel="noopener">${this.appName(app)}</a>
                  ${app.alwaysOn ? html`<div class="subline">Always on</div>` : nothing}
                </td>
                <td>${this.owner(app)}</td>
                <td>${this.scopeLabel(app.ownerScopeId)}</td>
                <td>${this.statusBadge(app.status)}</td>
                <td class="num">${app.versions?.length ?? 0}</td>
                <td class="num">
                  ${fmtBytes(app.totalBytes)}
                  <div class="subline">
                    copies
                    ${fmtBytes(app.snapshotBytes)}${app.gitBytes != null ? ` · git ${fmtBytes(app.gitBytes)}` : ""}${
                      app.dataVolumeBytes != null ? ` · data ${fmtBytes(app.dataVolumeBytes)}` : ""
                    }
                  </div>
                </td>
                <td class="disk-last-used">
                  ${app.lastUsedAt ? `${s.relTime(app.lastUsedAt)} · ${app.lastUsedSource}` : "Never"}
                </td>
                <td>${fmtDate(app.createdAt)}</td>
                <td class="disk-actions">
                  ${
                    app.status === "running"
                      ? html`<button type="button" class="rowbtn disk-stop" @click=${() => this.stopApp(app)}>
                          Stop
                        </button>`
                      : nothing
                  }
                  <button
                    type="button"
                    class="rowbtn disk-copies"
                    aria-expanded=${open ? "true" : "false"}
                    @click=${() => {
                      if (open) memory.expanded.delete(app.id);
                      else memory.expanded.add(app.id);
                      this.draw();
                    }}
                  >
                    Copies ${open ? "▾" : "▸"}
                  </button>
                  <button type="button" class="rowbtn danger disk-delete-app" @click=${() => this.deleteApp(app)}>
                    Delete app
                  </button>
                </td>
              </tr>
              ${open ? this.versionRows(app) : nothing}`;
          })}
        </tbody>
      </table>
    </div>`;
  }

  sandboxesTable() {
    const s = this.services;
    if (!this.report) return html`<p class="empty">Measure the disk to see sandboxes.</p>`;
    const rows = this.visibleSandboxes();
    if (!rows.length)
      return html`<p class="empty">
        ${this.report.sandboxes?.length ? "No sandboxes match." : "No sandboxes found on this host."}
      </p>`;
    return html`<div class="tablewrap">
      <table class="disk-sandboxes">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Kind</th>
            <th>Home volume</th>
            <th>Container</th>
            <th>State</th>
            <th>Last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r: any) =>
              html`<tr data-sandbox=${r.container || r.volume || ""}>
                <td>${r.scopeId ? this.scopeLabel(r.scopeId) : html`<span class="mono">${r.volume}</span>`}</td>
                <td>${this.scopeKind(r.scopeId) || "unknown"}</td>
                <td class="num">${r.volume ? fmtBytes(r.volumeBytes) : "none"}</td>
                <td class="num">${r.container ? fmtBytes(r.containerBytes) : "none"}</td>
                <td>${sandboxState(r)}</td>
                <td>${sandboxLastUsed(r, s.relTime)}</td>
                <td>
                  ${
                    r.container && !r.running
                      ? html`<button
                          type="button"
                          class="rowbtn danger disk-remove-container"
                          title="The home volume is kept"
                          @click=${() => this.removeContainer(r)}
                        >
                          Remove container
                        </button>`
                      : nothing
                  }
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
  }

  filesTable() {
    if (!this.report) return html`<p class="empty">Measure the disk to see stored files.</p>`;
    const rows = this.visibleFiles();
    if (!rows.length)
      return html`<p class="empty">${this.report.files?.length ? "No files match." : "No stored files."}</p>`;
    return html`<div class="tablewrap">
      <table class="disk-files">
        <thead>
          <tr>
            <th>Scope</th>
            <th>Kind</th>
            <th>Files</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r: any) =>
              html`<tr>
                <td>${this.scopeLabel(r.scopeId)}</td>
                <td>${this.scopeKind(r.scopeId)}</td>
                <td class="num">${Number(r.count || 0).toLocaleString()}</td>
                <td class="num">${fmtBytes(r.bytes)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
  }

  usage() {
    const tabs: Array<[Tab, string, number]> = [
      ["apps", "Apps", this.data.apps?.length ?? 0],
      ["sandboxes", "Sandboxes", this.report?.sandboxes?.length ?? 0],
      ["files", "Files", this.report?.files?.length ?? 0],
    ];
    const content = {
      apps: () => this.appsTable(),
      sandboxes: () => this.sandboxesTable(),
      files: () => this.filesTable(),
    }[memory.tab]();
    return card(
      "Usage",
      "Find the largest and least used apps and sandboxes. Contact owners before deleting their work.",
      html`${this.filters()}${this.notice ? html`<p class="flag-err disk-notice">${this.notice}</p>` : nothing}${content}`,
      html`<div class="disk-tabs" role="group" aria-label="Usage view">
        ${tabs.map(
          ([id, label, count]) =>
            html`<button
              type="button"
              data-tab=${id}
              aria-pressed=${memory.tab === id ? "true" : "false"}
              @click=${() => {
                memory.tab = id;
                this.draw();
              }}
            >
              ${label} ${count}
            </button>`,
        )}
      </div>`,
    );
  }

  draw() {
    this.paint(html`${card("Disk", null, this.summary())}${this.components()}${this.policies()}${this.usage()}`);
  }
}

export function disk(root: HTMLElement, data: any, services: Services) {
  return new DiskView(root, data, services);
}
