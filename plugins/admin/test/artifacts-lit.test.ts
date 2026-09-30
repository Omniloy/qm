import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const source = buildSync({
  entryPoints: [new URL("../ui/artifacts.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "artifacts",
  platform: "browser",
}).outputFiles[0].text;
const packsSource = buildSync({
  entryPoints: [new URL("../ui/artifacts-skills.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "skillUI",
  platform: "browser",
}).outputFiles[0].text;
function fixture() {
  const dom = new JSDOM('<div id="shellbar"></div><main></main>', {
    runScripts: "outside-only",
    url: "http://localhost/admin/files",
    pretendToBeVisual: true,
  });
  dom.window.eval(source + ";window.artifacts = artifacts;");
  dom.window.eval(packsSource + ";window.skillUI = skillUI;");
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const root = dom.window.document.querySelector("main")!;
  const c: Record<string, any> = {
    scope: "personal:alice",
    orgId: "acme",
    view: "files",
    index: false,
    own: false,
    apiBase: "",
    scopeKind: (s: string) => s.split(":")[0],
    shortName: (s: string) => s,
    dirLabel: (s: string) => s,
    plural: (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`,
    relTime: () => "just now",
    fmtTime: () => "Today",
    fmtHistoryTime: () => "Today",
    fmtBytes: (n: number) => `${n} B`,
    fileKind: () => "file",
    fileName: (s: string) => s,
    pageShell: (value: any) => {
      c.shell = value;
    },
    memoryDraft: () => c.draft ?? null,
    setMemoryDraft: (draft: string | null) => {
      c.draft = draft;
    },
    api: async () => ({ ok: true, data: {} }),
    go: () => {},
    reload: () => {},
    invalidate: () => {},
    stateToUrl: (s: any) => "/admin/" + s.view + "?scope=" + s.scope,
    shortId: (s: string) => s,
    titleCase: (s: string) => s,
    openScopeRow: () => {},
    fileSha256: async () => "hash",
    uploadErrorMessage: (s: string) => s,
    firstLine: (s: string) => s,
    cronName: (s: any) => s.title || s.id,
    shortSchedule: () => "Daily",
    fmtSchedule: () => "Every day",
    destinationSummary: () => "None",
    destinationDetails: () => "",
    setCronEditing: () => {},
    scopeRows: () => [],
    packRepoLabel: (s: string) => s,
    buildScopeMultiSelect: (_choices: any, selected: Set<string>, onChange: () => void) => {
      c.selectedScopes = selected;
      c.changeScopes = onChange;
      return dom.window.document.createElement("div");
    },
  };
  return { dom, root, c, ui: (dom.window as any).artifacts, skills: (dom.window as any).skillUI };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("memory drafts preserve newer edits through an in-flight save", async () => {
  const { dom, root, c, ui } = fixture();
  let complete: (value: any) => void = () => {};
  const calls: any[] = [];
  c.api = (...args: any[]) => {
    calls.push(args);
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  ui.memory(root, { content: "saved" }, c);
  const input = root.querySelector("textarea")!;
  input.value = "submitted";
  input.dispatchEvent(new dom.window.Event("input"));
  root.querySelector("button")!.click();
  input.value = "newer draft";
  input.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(calls[0][1], "/api/memory?scope=personal%3Aalice");
  assert.equal(calls[0][2].content, "submitted");
  assert.equal(c.draft, "newer draft");
  assert.equal(root.querySelector("textarea"), input);
  assert.equal(root.querySelector("#st-memory")!.textContent, "Unsaved changes");
  dom.window.close();
});

test("files search renders from query data and preserves keyboard opening", () => {
  const { dom, root, c, ui } = fixture();
  let opened = "";
  c.downloadFile = (row: any) => {
    opened = row.id;
  };
  ui.files(
    root,
    {
      files: [
        { id: "a", name: "alpha.txt", createdAt: 1 },
        { id: "b", name: "beta.txt", createdAt: 2 },
      ],
    },
    c,
  );
  c.shell.search.onInput("alpha");
  assert.equal(root.querySelectorAll(".dense-row").length, 1);
  root.querySelector(".dense-row")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(opened, "a");
  c.shell.search.onInput("missing");
  assert.match(root.textContent!, /No files match/);
  dom.window.close();
});

test("scope indexes hide full artifact lists until searching", () => {
  const { dom, root, c, ui } = fixture();
  c.index = true;
  c.deploymentHref = () => "https://example.com/app";
  ui.deployments(root, { deployments: [{ id: "app", name: "App", ownerScopeId: "personal:alice" }] }, c);
  assert.equal(root.querySelectorAll(".dense-list").length, 2);
  c.shell.search.onInput("App");
  const link = root.querySelector<HTMLAnchorElement>('.dense-row[target="_blank"]')!;
  assert.equal(link.href, "https://example.com/app");
  assert.equal(link.rel, "noopener");
  dom.window.close();
});

test("cron destination draft derives placeholders, disabled fields and API payload", async () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true, data: { sessions: [] } };
  };
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit destination")!.click();
  const select = root.querySelector("select")!;
  select.value = "principal";
  select.dispatchEvent(new dom.window.Event("change"));
  const inputs = root.querySelectorAll<HTMLInputElement>("input");
  assert.equal(inputs[0].placeholder, "principal id");
  assert.equal(inputs[2].disabled, false);
  inputs[0].value = "alice";
  inputs[0].dispatchEvent(new dom.window.Event("input"));
  inputs[2].value = "bob";
  inputs[2].dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.click();
  await tick();
  const put = calls.find((args) => args[0] === "PUT");
  assert.equal(
    JSON.stringify(put[2]),
    JSON.stringify({ destination: { type: "principal", target: "alice", onBehalfOf: "bob" } }),
  );
  dom.window.close();
});

test("stale async cron renders cannot replace a different page", async () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  let complete: (value: any) => void = () => {};
  c.api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  root.replaceChildren(dom.window.document.createTextNode("New page"));
  complete({ ok: true, data: { sessions: [] } });
  await tick();
  assert.equal(root.textContent, "New page");
  dom.window.close();
});

test("pack registration draft is collected from state with advanced fields", async () => {
  const { dom, root, c, skills } = fixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true };
  };
  skills.packs(root, [], c);
  const fields = root.querySelectorAll<HTMLInputElement>("input");
  for (const [i, value] of ["https://example.com/skills", "main", "private/*, drafts/*", "deploy-token"].entries()) {
    fields[i].value = value;
    fields[i].dispatchEvent(new dom.window.Event("input"));
  }
  assert.match(root.querySelector(".linkish")!.textContent!, /Advanced •/);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!.click();
  await tick();
  assert.equal(calls[0][2].ref, "main");
  assert.equal(JSON.stringify(calls[0][2].config.exclude), '["private/*","drafts/*"]');
  dom.window.close();
});

test("pack selection follows target scopes and supports partial imports", async () => {
  const { dom, root, c, skills } = fixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return args[0] === "GET"
      ? {
          ok: true,
          data: {
            candidates: [
              { upstreamName: "a", eligible: true, importedScopes: ["org:acme"] },
              { upstreamName: "b", eligible: true, importedScopes: [] },
            ],
          },
        }
      : { ok: true, data: { imported: [] } };
  };
  await skills.browsePack({ id: "pack", url: "example" }, root, c);
  assert.equal(root.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, true);
  c.selectedScopes.add("personal:alice");
  c.changeScopes();
  assert.equal(root.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, false);
  const b = root.querySelector<HTMLInputElement>('[data-name="b"]')!;
  b.checked = false;
  b.dispatchEvent(new dom.window.Event("change"));
  [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Import selected")!.click();
  await tick();
  const post = calls.find((args) => args[0] === "POST");
  assert.equal(JSON.stringify(post[2].selected), '["a"]');
  assert.equal(JSON.stringify(post[2].scopeIds), '["org:acme","personal:alice"]');
  dom.window.close();
});

test("cancelled cron destination edits restore the saved destination on reopen", () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  ui.crons(
    root,
    {
      crons: [
        { id: "job", title: "Daily", ownerScopeId: c.scope, destination: { type: "principal", target: "alice" } },
      ],
    },
    c,
  );
  const click = (text: string) =>
    [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === text)!.click();
  click("Edit destination");
  assert.equal(root.querySelector("select")!.value, "principal");
  const target = root.querySelector<HTMLInputElement>('input[name="cron-target"]')!;
  target.value = "bob";
  target.dispatchEvent(new dom.window.Event("input"));
  click("Cancel");
  click("Edit destination");
  assert.equal(root.querySelector<HTMLInputElement>('input[name="cron-target"]')!.value, "alice");
  dom.window.close();
});

test("cron destination saves preserve edits made while the request is pending", async () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  let complete: (value: any) => void = () => {};
  let reloads = 0;
  c.reload = () => {
    reloads++;
  };
  c.api = async (method: string) =>
    method === "PUT"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : { ok: true, data: { sessions: [] } };
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit destination")!.click();
  const target = root.querySelector<HTMLInputElement>('input[name="cron-target"]')!;
  target.value = "submitted";
  target.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.click();
  target.value = "newer";
  target.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(root.querySelector<HTMLInputElement>('input[name="cron-target"]')!.value, "newer");
  assert.equal(reloads, 0);
  assert.equal(
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.disabled,
    false,
  );
  dom.window.close();
});

test("skill removal network failures keep the current view and report an error", async () => {
  const { dom, c, skills } = fixture();
  let reloads = 0;
  let message = "";
  dom.window.confirm = () => true;
  dom.window.alert = (value) => {
    message = String(value);
  };
  c.reload = () => {
    reloads++;
  };
  c.api = async () => {
    throw new Error("offline");
  };
  await skills.removeSkill({ id: "skill", ownerScopeId: c.scope }, c);
  assert.equal(reloads, 0);
  assert.equal(message, "Could not remove skill.");
  dom.window.close();
});

test("pack registration preserves newer edits after its request completes", async () => {
  const { dom, root, c, skills } = fixture();
  let complete: (value: any) => void = () => {};
  let reloads = 0;
  c.reload = () => {
    reloads++;
  };
  c.api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  skills.packs(root, [], c);
  const input = root.querySelector<HTMLInputElement>("input")!;
  input.value = "https://example.com/submitted";
  input.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!.click();
  input.value = "https://example.com/newer";
  input.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(root.querySelector<HTMLInputElement>("input")!.value, "https://example.com/newer");
  assert.equal(reloads, 0);
  assert.match(root.querySelector(".status")!.textContent!, /newer changes/);
  dom.window.close();
});

test("the org skills page offers the skill sharing policy and saves both audiences", async () => {
  const { dom, root, c, skills } = fixture();
  const calls: any[] = [];
  c.api = async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, JSON.parse(JSON.stringify(body ?? null))]);
    return method === "GET"
      ? { ok: true, data: { skillSharing: { contexts: "everyone", org: "admins" } } }
      : { ok: true, data: {} };
  };
  await skills.mountSharing(root, c);
  assert.deepEqual(calls[0], ["GET", "/api/scopes/org%3Aacme?view=skills", null]);
  const card = root.querySelector("#card-skill-sharing")!;
  const save = card.querySelector<HTMLButtonElement>(".foot button")!;
  assert.equal(card.querySelector<HTMLInputElement>('[name="skill-sharing-org"][value="admins"]')!.checked, true);
  assert.equal(save.disabled, true);
  card.querySelector<HTMLInputElement>('[name="skill-sharing-org"][value="everyone"]')!.click();
  assert.equal(card.querySelector("#st-skill-sharing")!.textContent, "Unsaved changes");
  save.click();
  await tick();
  assert.deepEqual(calls[1], [
    "PUT",
    "/api/scopes/org%3Aacme/skill-sharing",
    { contexts: "everyone", org: "everyone" },
  ]);
  assert.equal(card.querySelector("#st-skill-sharing")!.textContent, "Saved");
  assert.equal(save.disabled, true);
  dom.window.close();
});

test("the org skills index mounts the sharing card alongside skill packs", async () => {
  const { dom, root, c, ui } = fixture();
  c.index = true;
  c.view = "skills";
  c.api = async (_method: string, path: string) =>
    path.includes("view=skills")
      ? { ok: true, data: { skillSharing: { contexts: "admins", org: "admins" } } }
      : { ok: true, data: { packs: [] } };
  ui.skills(root, { skills: [] }, c);
  await tick();
  await tick();
  const card = root.querySelector("#card-skill-sharing")!;
  assert.ok(card);
  assert.equal(card.querySelector<HTMLInputElement>('[name="skill-sharing-contexts"][value="admins"]')!.checked, true);
  dom.window.close();
});

test("a save that lands after the admin opened another skill does not repaint the old one", async () => {
  const { dom, root, c, skills } = fixture();
  c.statusBadge = (s: string) => s;
  c.scopeCell = (s: string) => ({ text: s });
  const first = {
    id: "k1",
    ownerScopeId: "org:acme",
    name: "first",
    body: "First body.",
    status: "published",
    version: 1,
  };
  const second = {
    id: "k2",
    ownerScopeId: "org:acme",
    name: "second",
    body: "Second body.",
    status: "published",
    version: 1,
  };
  let finishPut: (value: unknown) => void = () => {};
  c.api = (method: string, path: string) => {
    if (method === "PUT") return new Promise((resolve) => (finishPut = resolve));
    return Promise.resolve({ ok: true, data: path.includes("/k2") ? second : first });
  };
  await skills.skillDetail(root, first, [first], c);
  root.querySelector<HTMLButtonElement>(".skill-edit")!.click();
  [...root.querySelectorAll<HTMLButtonElement>(".skill-edit-form button")]
    .find((b) => b.textContent!.trim() === "Save")!
    .click();
  await skills.skillDetail(root, second, [second], c);
  finishPut({ ok: true, data: first });
  await tick();
  await tick();
  assert.match(root.querySelector(".skillbody")!.textContent!, /Second body\./);
  dom.window.close();
});

test("a skill can be edited in place from its admin detail; archived and source-managed ones stay read-only", async () => {
  const { dom, root, c, skills } = fixture();
  c.statusBadge = (s: string) => s;
  c.scopeCell = (s: string) => ({ text: s });
  const org = {
    id: "k1",
    ownerScopeId: "org:acme",
    name: "house-style",
    description: "old words",
    body: "Old body.",
    status: "published",
    version: 1,
  };
  const calls: any[] = [];
  let current: any = org;
  c.api = async (...args: any[]) => {
    calls.push(args);
    if (args[0] === "PUT") {
      current = { ...org, ...args[2], version: 2 };
      return { ok: true, data: current };
    }
    return { ok: true, data: current };
  };
  await skills.skillDetail(root, org, [org], c);
  root.querySelector<HTMLButtonElement>(".skill-edit")!.click();
  const description = root.querySelector<HTMLInputElement>("#skill-edit-description")!;
  const body = root.querySelector<HTMLTextAreaElement>("#skill-edit-body")!;
  assert.equal(body.value, "Old body.");
  description.value = "new words";
  description.dispatchEvent(new dom.window.Event("input"));
  body.value = "New body.";
  body.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll<HTMLButtonElement>(".skill-edit-form button")]
    .find((b) => b.textContent!.trim() === "Save")!
    .click();
  await tick();
  await tick();
  const put = calls.find((call) => call[0] === "PUT");
  assert.equal(put[1], "/api/skills/k1?scope=org%3Aacme");
  assert.equal(JSON.stringify(put[2]), JSON.stringify({ description: "new words", body: "New body." }));
  assert.equal(root.querySelector("#skill-edit-body"), null, "the form closes after a save");
  assert.match(root.querySelector(".skillbody")!.textContent!, /New body\./);

  current = { ...org, ownerScopeId: "personal:alice" };
  await skills.skillDetail(root, current, [current], c);
  assert.ok(root.querySelector(".skill-edit"), "the admin API edits a skill in any home");
  current = { ...org, status: "archived" };
  await skills.skillDetail(root, current, [current], c);
  assert.equal(root.querySelector(".skill-edit"), null, "an archived org skill is not editable");
  for (const managed of [
    { createdBy: "system:skills-seed" },
    { createdBy: "system:deployment-layer" },
    { createdBy: "pack:p1" },
    { createdBy: "admin", pack: { id: "p1", url: "https://github.com/acme/pack.git" } },
  ]) {
    current = { ...org, ...managed };
    await skills.skillDetail(root, current, [current], c);
    assert.equal(root.querySelector(".skill-edit"), null, `${managed.createdBy} skills are edited at their source`);
  }
  dom.window.close();
});

test("the org skills index lists duplicates and runs a cluster's merge actions through the admin API", async () => {
  const { dom, root, c, ui } = fixture();
  c.index = true;
  c.view = "skills";
  c.orgId = "acme";
  const calls: any[] = [];
  const report = {
    clusters: [
      {
        name: "slides",
        status: "auto",
        canonical: { id: "canon", scopeId: "personal:sergio" },
        retire: [{ id: "orgcopy", scopeId: "org:acme" }],
        purge: [],
        evidence: ["audit skill_promote canon→org 2026-09-12"],
        diff: null,
        actions: [{ method: "POST", path: "/v1/admin/skills/orgcopy/merge", body: { into: "canon" } }],
      },
    ],
    nameClashes: [{ name: "granola", rows: [{ id: "g1", scopeId: "personal:sergio" }] }],
    archivedLeftovers: [],
    ownerBackfill: { pending: 2, personalHomeMismatch: [] },
  };
  c.api = async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    if (path.startsWith("/api/skills/duplicates")) return { ok: true, data: report };
    return { ok: true, data: {} };
  };
  ui.skills(root, { skills: [] }, c);
  await tick();
  await tick();
  const merge = root.querySelector<HTMLButtonElement>(".skill-duplicate-merge")!;
  assert.equal(merge.textContent!.trim(), "Merge");
  assert.match(root.textContent!, /Same name, no shared history/);
  assert.ok(root.querySelector(".skill-backfill"));
  merge.click();
  await tick();
  const posted = calls.find((call) => call[0] === "POST");
  assert.equal(
    JSON.stringify(posted),
    JSON.stringify(["POST", "/api/skills/orgcopy/merge?scope=org%3Aacme", { into: "canon" }]),
  );
  dom.window.close();
});

test("a skill's admin detail shows its owner and shares, and transfers it through the admin owner route", async () => {
  const { dom, root, c, skills } = fixture();
  c.statusBadge = (s: string) => s;
  c.scopeCell = (s: string) => ({ text: s });
  const skill = {
    id: "k1",
    ownerScopeId: "personal:sergio",
    ownerId: "sergio",
    orgWide: true,
    sharedWith: [
      { scopeId: "org:acme", permission: "read" },
      { scopeId: "channel:C1", permission: "write" },
    ],
    name: "slides",
    body: "Body.",
    status: "published",
    version: 3,
  };
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true, data: skill };
  };
  await skills.skillDetail(root, skill, [skill], c);
  assert.match(root.textContent!, /Owner: personal:sergio/);
  assert.match(root.textContent!, /Everyone/);
  assert.match(root.textContent!, /channel:C1 \(edit\)/);
  root.querySelector<HTMLButtonElement>(".skill-transfer")!.click();
  const input = root.querySelector<HTMLInputElement>("#skill-owner-input")!;
  input.value = "noe@acme.com";
  input.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll<HTMLButtonElement>(".skill-ownership-form button")]
    .find((b) => b.textContent!.trim() === "Transfer")!
    .click();
  await tick();
  const post = calls.find((call) => call[0] === "POST");
  assert.equal(
    JSON.stringify(post),
    JSON.stringify(["POST", "/api/skills/k1/owner?scope=org%3Aacme", { ownerId: "noe@acme.com" }]),
  );
  dom.window.close();
});
