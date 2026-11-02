import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const NOW = Date.UTC(2026, 10, 2, 12);

const app = (id: string, over: Record<string, any> = {}) => ({
  id,
  name: id,
  url: `https://${id}.apps.example`,
  ownerScopeId: "personal:alice",
  createdBy: "alice",
  ownerName: "Alice",
  ownerEmail: "alice@example.com",
  status: "running",
  alwaysOn: false,
  currentVersion: 3,
  versions: [
    { version: 1, createdAt: NOW - 3 * 86_400_000, sizeBytes: 150 * MB, live: false },
    { version: 2, createdAt: NOW - 2 * 86_400_000, sizeBytes: 150 * MB, live: false },
    { version: 3, createdAt: NOW - 86_400_000, sizeBytes: 150 * MB, live: true },
  ],
  snapshotBytes: 450 * MB,
  gitBytes: 10 * MB,
  dataVolumeBytes: null,
  totalBytes: 460 * MB,
  lastUsedAt: NOW - 86_400_000,
  lastUsedSource: "request",
  createdAt: NOW - 3 * 86_400_000,
  ...over,
});

const REPORT = {
  measuredAt: NOW - 60_000,
  durationMs: 1200,
  filesystem: { path: "/opt/qm/data", totalBytes: 100 * GB, usedBytes: 95 * GB, availableBytes: 5 * GB },
  components: [
    { id: "deployments", label: "App copies", bytes: 14 * GB, count: 242, path: "/opt/qm/data/deployments" },
    { id: "postgres", label: "Postgres", bytes: 18 * GB },
    { id: "docstore", label: "Docstore files", bytes: 3 * GB },
    { id: "images", label: "Docker images", bytes: null },
  ],
  postgres: {
    totalBytes: 18 * GB,
    tables: [
      { name: "session_llm_requests", bytes: 9 * GB },
      { name: "session_tape", bytes: 3 * GB },
    ],
  },
  docker: { available: false, reason: "docker is not configured for this deployment" },
  apps: {},
  sandboxes: [
    {
      scopeId: "personal:alice",
      container: "qm-sbx-alice",
      volume: "qm-home-alice",
      containerBytes: 2 * GB,
      volumeBytes: 5 * GB,
      state: "exited",
      running: false,
      lastUsedAt: NOW - 5 * 86_400_000,
    },
    {
      scopeId: "channel:C1",
      container: "qm-sbx-c1",
      volume: "qm-home-c1",
      containerBytes: GB,
      volumeBytes: GB,
      state: "running",
      running: true,
      lastUsedAt: NOW,
    },
  ],
  files: [
    { scopeId: "personal:alice", bytes: 2 * GB, count: 40 },
    { scopeId: "group:P1", bytes: GB, count: 3 },
  ],
  orphanSnapshotBytes: 6 * GB,
};

const DATA = {
  report: REPORT,
  measuring: false,
  orgScopeId: "org:acme",
  retention: { maxVersions: 3 },
  autoStop: { days: null, envTtlMs: 7 * 86_400_000, managedScaleToZero: false },
  scopes: [
    { id: "personal:alice", label: "Alice", kind: "personal" },
    { id: "personal:bob", label: "Bob", kind: "personal" },
    { id: "channel:C1", label: "#general", kind: "channel" },
    { id: "group:P1", label: "Launch project", kind: "project" },
  ],
  apps: [
    app("small", { totalBytes: 10 * MB, lastUsedAt: NOW - 1000, createdAt: NOW - 1000 }),
    app("big", {
      createdBy: "bob",
      ownerName: "Bob",
      ownerEmail: "bob@example.com",
      ownerScopeId: "group:P1",
      createdInScope: "group:P1",
      totalBytes: 2 * GB,
      lastUsedAt: null,
      lastUsedSource: "deploy",
      status: "stopped",
    }),
  ],
};

function render(data: any = DATA) {
  const f = litFixture();
  const calls: any = { shell: null, api: [] as any[], refreshes: 0 };
  const responses: Array<{ ok: boolean; status: number; data: any }> = [];
  const confirms: string[] = [];
  (f.window as any).confirm = (message: string) => {
    confirms.push(message);
    return true;
  };
  const services = {
    defaultShell: (opts: any) => {
      calls.shell = opts;
    },
    plural: (n: number, one: string) => `${n} ${one}`,
    relTime: (ts: number) => `rel(${ts})`,
    api: (method: string, path: string, body?: unknown) => {
      calls.api.push(JSON.parse(JSON.stringify([method, path, body ?? null])));
      return Promise.resolve(responses.shift() ?? { ok: true, status: 200, data: {} });
    },
    refresh: () => {
      calls.refreshes += 1;
      return Promise.resolve(true);
    },
    wait: () => Promise.resolve(),
  };
  const view = f.ui.disk.disk(f.root, data, services);
  const appRows = () =>
    [...f.root.querySelectorAll<HTMLElement>(".disk-apps tbody tr[data-app]")].map((r) => r.dataset.app);
  const select = (cls: string, value: string) => {
    const el = f.root.querySelector<HTMLSelectElement>(`select.${cls}`)!;
    el.value = value;
    el.dispatchEvent(new f.window.Event("change"));
  };
  const tab = (id: string) => f.root.querySelector<HTMLElement>(`.disk-tabs button[data-tab="${id}"]`)!.click();
  return { f, calls, view, appRows, select, tab, responses, confirms, services };
}

function reset(r: ReturnType<typeof render>) {
  r.f.window.close();
}

test("disk view: stats, free-space badge and the docker note render from the report", () => {
  const r = render();
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls.shell.stats)), [
    ["95.0 GB / 100 GB", "Filesystem used"],
    ["5.0 GB", "Available"],
    ["n/a", "Docker"],
    ["18.0 GB", "Postgres"],
  ]);
  const summary = r.f.root.querySelector(".disk-summary")!;
  assert.match(summary.textContent!, new RegExp(`Measured rel\\(${REPORT.measuredAt}\\)`));
  const free = summary.querySelector(".badge")!;
  assert.match(free.textContent!, /5.0 GB free \(5%\)/);
  assert.ok(free.classList.contains("err"), "under 10% free is red");
  assert.match(
    r.f.root.querySelector(".disk-docker-note")!.textContent!,
    /Docker not available: docker is not configured/,
  );
  assert.equal(r.f.root.querySelector<HTMLButtonElement>(".disk-measure")!.textContent!.trim(), "Measure now");
  reset(r);
});

test("disk view: a null report says it was not measured and still offers the button", () => {
  const r = render({ ...DATA, report: null });
  assert.equal(r.calls.shell.stats.length, 0);
  assert.match(r.f.root.textContent!, /Not measured yet/);
  assert.ok(r.f.root.querySelector(".disk-measure"));
  assert.equal(r.f.root.querySelector(".disk-components"), null);
  assert.equal(r.appRows().length, 2, "apps are listed from the live store without a report");
  reset(r);
});

test("disk view: components are sorted by size with unknown sizes last, and Postgres lists its tables", () => {
  const r = render();
  const ids = [...r.f.root.querySelectorAll<HTMLElement>(".disk-components tbody tr")].map(
    (row) => row.dataset.component,
  );
  assert.deepEqual(ids, ["postgres", "deployments", "orphans", "docstore", "images"]);
  const orphan = r.f.root.querySelector('.disk-components tr[data-component="orphans"]')!;
  assert.match(orphan.textContent!, /Unreferenced app copies \(cleaned hourly\)/);
  const tables = r.f.root.querySelector('.disk-components tr[data-component="postgres"] .disk-tables')!;
  assert.match(tables.textContent!, /session_llm_requests\s+9.0 GB/);
  assert.equal(
    r.f.root.querySelector<HTMLElement>('tr[data-component="postgres"] .disk-bar > span')!.style.width,
    "18%",
  );
  reset(r);
});

test("disk view: least recently used puts the stalest app first even when it is smaller", () => {
  const r = render({
    ...DATA,
    apps: [
      app("fresh-big", { totalBytes: 2 * GB, lastUsedAt: NOW - 1000 }),
      app("stale-small", { totalBytes: 10 * MB, lastUsedAt: NOW - 30 * 86_400_000 }),
    ],
  });
  assert.deepEqual(r.appRows(), ["fresh-big", "stale-small"]);
  r.select("disk-sort", "lastUsed");
  assert.deepEqual(r.appRows(), ["stale-small", "fresh-big"]);
  r.select("disk-sort", "size");
  reset(r);
});

test("disk view: user, project and status filters narrow the apps; sort by size and last used", () => {
  const r = render();
  assert.deepEqual(r.appRows(), ["big", "small"], "largest first by default");
  r.select("disk-sort", "lastUsed");
  assert.deepEqual(r.appRows(), ["big", "small"], "least recently used first, never-used apps before them");
  r.select("disk-sort", "size");
  r.select("disk-user", "alice");
  assert.deepEqual(r.appRows(), ["small"]);
  r.select("disk-user", "");
  r.select("disk-scope", "group:P1");
  assert.deepEqual(r.appRows(), ["big"]);
  r.select("disk-scope", "");
  r.select("disk-status", "running");
  assert.deepEqual(r.appRows(), ["small"]);
  r.select("disk-status", "");
  r.calls.shell.search.onInput("bob@");
  assert.deepEqual(r.appRows(), ["big"]);
  r.calls.shell.search.onInput("launch project");
  assert.deepEqual(r.appRows(), ["big"], "search covers the scope label");
  const users = [...r.f.root.querySelectorAll("select.disk-user option")].map((o) => o.textContent);
  assert.deepEqual(users, ["Everyone", "Alice", "Bob"]);
  const scopes = [...r.f.root.querySelectorAll("select.disk-scope option")].map((o) => o.textContent);
  assert.deepEqual(scopes, ["All", "#general (channel)", "Launch project (project)"]);
  assert.equal(r.calls.api.length, 0, "filtering and sorting are client-side");
  reset(r);
});

test("disk view: filters, tab and expanded copies survive a refresh because they live in module memory", () => {
  const r = render();
  r.select("disk-user", "bob");
  r.f.root.querySelector<HTMLElement>('tr[data-app="big"] .disk-copies')!.click();
  r.f.root.textContent = "";
  r.f.ui.disk.disk(r.f.root, DATA, r.services);
  assert.deepEqual(r.appRows(), ["big"]);
  assert.equal(r.f.root.querySelector<HTMLSelectElement>("select.disk-user")!.value, "bob");
  assert.ok(r.f.root.querySelector(".disk-versions"));
  reset(r);
});

test("disk view: the copies expander offers Delete only for non-live copies", async () => {
  const r = render();
  const row = r.f.root.querySelector('tr[data-app="small"]')!;
  assert.match(row.textContent!, /rel\(\d+\) · request/);
  assert.match(r.f.root.querySelector('tr[data-app="big"]')!.textContent!, /Never/);
  row.querySelector<HTMLElement>(".disk-copies")!.click();
  const versions = [...r.f.root.querySelectorAll<HTMLElement>(".disk-versions tr")];
  assert.deepEqual(
    versions.map((v) => [v.dataset.version, !!v.querySelector(".disk-version-delete"), !!v.querySelector(".badge")]),
    [
      ["3", false, true],
      ["2", true, false],
      ["1", true, false],
    ],
  );
  versions[1]!.querySelector<HTMLElement>(".disk-version-delete")!.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.calls.api, [["DELETE", "/api/disk/apps/small/versions/2", null]]);
  assert.match(r.confirms[0]!, /Delete copy v2 of "small" \(150 MB\)/);
  assert.equal(r.calls.refreshes, 1);
  r.f.root.querySelector<HTMLElement>('tr[data-app="small"] .disk-copies')!.click();
  assert.equal(r.f.root.querySelector(".disk-versions"), null);
  reset(r);
});

test("disk view: a refused mutation shows the reason inline and does not refresh", async () => {
  const r = render();
  r.responses.push({ ok: false, status: 409, data: { error: "version_live" } });
  r.f.root.querySelector<HTMLElement>('tr[data-app="small"] .disk-delete-app')!.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.calls.api[0], ["DELETE", "/api/disk/apps/small", null]);
  assert.match(r.confirms[0]!, /Delete the app "small" \(10.0 MB\)/);
  assert.match(r.f.root.querySelector(".disk-notice")!.textContent!, /live and cannot be deleted/);
  assert.equal(r.calls.refreshes, 0);
  reset(r);
});

test("disk view: stop is offered only for running apps", async () => {
  const r = render();
  assert.equal(r.f.root.querySelector('tr[data-app="big"] .disk-stop'), null);
  r.f.root.querySelector<HTMLElement>('tr[data-app="small"] .disk-stop')!.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.calls.api, [["POST", "/api/disk/apps/small/stop", null]]);
  reset(r);
});

test("disk view: contact builds a bilingual mailto to the owner and never sends anything", () => {
  const r = render();
  const link = r.f.root.querySelector<HTMLAnchorElement>('tr[data-app="big"] .disk-contact')!;
  const href = link.getAttribute("href")!;
  assert.ok(href.startsWith("mailto:bob%40example.com?subject="), href);
  const body = decodeURIComponent(href.split("&body=")[1]!);
  assert.ok(body.indexOf("Hola") < body.indexOf("Hi,"), "Spanish first, then English");
  assert.match(body, /Tu app "big" \(https:\/\/big\.apps\.example\) ocupa 2.0 GB/);
  assert.match(body, /Your app "big" \(https:\/\/big\.apps\.example\) uses 2.0 GB/);
  assert.match(r.f.root.querySelector('tr[data-app="big"]')!.textContent!, /bob@example\.com/);
  assert.equal(r.calls.api.length, 0);
  reset(r);
});

test("disk view: sandboxes offer Remove container only when stopped, and files list per scope", async () => {
  const r = render();
  r.tab("sandboxes");
  const rows = [...r.f.root.querySelectorAll<HTMLElement>(".disk-sandboxes tbody tr")];
  assert.deepEqual(
    rows.map((row) => [row.dataset.sandbox, !!row.querySelector(".disk-remove-container")]),
    [
      ["qm-sbx-alice", true],
      ["qm-sbx-c1", false],
    ],
  );
  assert.match(rows[0]!.textContent!, /Alice[\s\S]*personal[\s\S]*5.0 GB[\s\S]*2.0 GB/);
  rows[0]!.querySelector<HTMLElement>(".disk-remove-container")!.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.calls.api, [["DELETE", "/api/disk/sandbox-containers/qm-sbx-alice", null]]);
  assert.match(r.confirms[0]!, /home volume is kept/);
  r.select("disk-user", "alice");
  assert.equal(r.f.root.querySelectorAll(".disk-sandboxes tbody tr").length, 1);
  r.select("disk-user", "");
  r.select("disk-status", "running");
  assert.deepEqual(
    [...r.f.root.querySelectorAll<HTMLElement>(".disk-sandboxes tbody tr")].map((row) => row.dataset.sandbox),
    ["qm-sbx-c1"],
  );
  r.select("disk-status", "");
  r.tab("files");
  const files = [...r.f.root.querySelectorAll(".disk-files tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((c) => c.textContent!.trim()),
  );
  assert.deepEqual(files, [
    ["Alice", "personal", "40", "2.0 GB"],
    ["Launch project", "project", "3", "1.0 GB"],
  ]);
  r.select("disk-scope", "group:P1");
  assert.equal(r.f.root.querySelectorAll(".disk-files tbody tr").length, 1);
  reset(r);
});

test("disk view: the idle-stop policy saves days, turns off, and validates the range", async () => {
  const r = render();
  assert.match(r.f.root.textContent!, /Copies kept per app: 3/);
  assert.match(r.f.root.textContent!, /server default stops apps idle for 7 d/);
  assert.match(r.f.root.textContent!, /Apps are never deleted automatically/);
  const input = r.f.root.querySelector<HTMLInputElement>(".disk-idle-days")!;
  input.value = "0";
  r.f.root.querySelector<HTMLElement>(".disk-idle-save")!.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.calls.api.length, 0);
  assert.match(r.f.root.textContent!, /from 1 to 365/);
  r.f.root.querySelector<HTMLInputElement>(".disk-idle-days")!.value = "14";
  r.f.root.querySelector<HTMLElement>(".disk-idle-save")!.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.calls.api, [["PUT", "/api/scopes/org%3Aacme/app-idle-stop", { days: 14 }]]);
  r.f.window.close();
  const on = render({ ...DATA, autoStop: { days: 30, envTtlMs: null, managedScaleToZero: false } });
  assert.match(on.f.root.textContent!, /opened for 30 days are stopped/);
  on.f.root.querySelector<HTMLElement>(".disk-idle-off")!.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(on.calls.api, [["PUT", "/api/scopes/org%3Aacme/app-idle-stop", { days: "" }]]);
  on.f.window.close();
  const managed = render({ ...DATA, autoStop: { days: null, envTtlMs: null, managedScaleToZero: true } });
  assert.equal(managed.f.root.querySelector(".disk-idle-days"), null);
  assert.match(managed.f.root.textContent!, /stopped by the platform/);
  reset(managed);
});

test("disk view: Measure now posts, polls refresh until measuring ends, and disables meanwhile", async () => {
  const r = render();
  let polls = 0;
  r.services.refresh = () => {
    polls += 1;
    r.f.root.textContent = "";
    r.f.ui.disk.disk(r.f.root, { ...DATA, measuring: polls < 3 }, r.services);
    return Promise.resolve(true);
  };
  r.f.root.querySelector<HTMLElement>(".disk-measure")!.click();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.calls.api[0], ["POST", "/api/disk/measure", null]);
  assert.equal(polls, 3);
  const button = r.f.root.querySelector<HTMLButtonElement>(".disk-measure")!;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent!.trim(), "Measure now");
  const busy = render({ ...DATA, measuring: true });
  const disabled = busy.f.root.querySelector<HTMLButtonElement>(".disk-measure")!;
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.textContent!.trim(), "Measuring…");
  busy.f.window.close();
  reset(r);
});

test("disk view: Measure now keeps polling a long measurement and stops once a newer report lands", async () => {
  const r = render();
  let polls = 0;
  r.services.refresh = () => {
    polls += 1;
    const done = polls >= 40;
    r.f.root.textContent = "";
    r.f.ui.disk.disk(
      r.f.root,
      { ...DATA, measuring: true, report: done ? { ...REPORT, measuredAt: NOW } : REPORT },
      r.services,
    );
    return Promise.resolve(true);
  };
  r.f.root.querySelector<HTMLElement>(".disk-measure")!.click();
  for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 40, "it outlasts two minutes of polling and stops on the newer report");
  reset(r);
});

test("disk view: Measure now stops polling when the view is left", async () => {
  const r = render();
  let polls = 0;
  r.services.refresh = () => {
    polls += 1;
    return Promise.resolve(false);
  };
  r.f.root.querySelector<HTMLElement>(".disk-measure")!.click();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 1);
  r.f.window.close();
  const after = render();
  assert.equal(after.f.root.querySelector<HTMLButtonElement>(".disk-measure")!.disabled, false);
  reset(after);
});

test("disk view: with docker available the stat shows its total and there is no docker note", () => {
  const r = render({
    ...DATA,
    report: {
      ...REPORT,
      filesystem: { ...REPORT.filesystem, usedBytes: 50 * GB, availableBytes: 50 * GB },
      docker: { available: true, totalBytes: 40 * GB },
    },
  });
  assert.equal(r.calls.shell.stats[2][0], "40.0 GB");
  assert.equal(r.f.root.querySelector(".disk-docker-note"), null);
  assert.ok(r.f.root.querySelector(".disk-summary .badge")!.classList.contains("ok"));
  reset(r);
});
