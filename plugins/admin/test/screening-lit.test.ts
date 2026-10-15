import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

const skillSource = {
  kind: "skill",
  skillId: "skill-browse",
  name: "browse",
  version: 28,
  contentHash: "abc123",
  builtIn: true,
};

const report = {
  id: "r1",
  approvalId: "a1",
  sessionId: "s1",
  source: skillSource,
  sourceKey: "skill:skill-browse",
  step: "Reading the skill's instructions",
  category: "credential_request",
  categoryLabel: "Credential request",
  reason: "Describes collecting browser cookies.",
  evidence: "HttpOnly included",
  content: "--- name: browse\n`cookies` returns the site's cookies as JSON, HttpOnly included.",
  reporterId: "U-reporter",
  note: "This is our own built-in skill.",
  createdAt: 1_700_000_000_000,
  status: "open",
  trusted: false,
};

const data = {
  groups: [
    {
      sourceKey: "skill:skill-browse",
      source: skillSource,
      sourceLabel: "Skill browse · v28 · built-in, managed by the org",
      holds: 7,
      open: 1,
      reports: [report],
    },
  ],
  nextBefore: 1_699_000_000_000,
  trusts: [
    {
      id: "skill-jira@3",
      skillId: "skill-jira",
      name: "jira",
      version: 3,
      contentHash: "def",
      grantedBy: "U-admin",
      grantedAt: 1_700_000_000_000,
    },
  ],
};

type Api = (...args: unknown[]) => Promise<{ ok: boolean; status?: number; data?: any }>;

function mount(api: Api, opts: { confirm?: boolean; data?: unknown } = {}) {
  const fx = litFixture();
  const opened: string[] = [];
  let reloads = 0;
  const shells: unknown[] = [];
  const confirms: string[] = [];
  fx.ui.screening.screening(fx.root, opts.data ?? data, {
    api,
    fmtTime: () => "today",
    defaultShell: (extras: unknown) => shells.push(extras),
    openAutoFlagger: (content: string) => opened.push(content),
    reload: () => reloads++,
    confirm: (message: string) => {
      confirms.push(message);
      return opts.confirm ?? true;
    },
  });
  return { ...fx, opened, shells, confirms, reloads: () => reloads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const preview = {
  skillId: "skill-browse",
  name: "browse",
  version: 28,
  contentHash: "abc123",
  files: [
    { path: "SKILL.md", content: "--- name: browse\nThe whole skill body." },
    { path: "scripts/cookies.sh", content: "#!/bin/sh\ncurl --cookie-jar jar.txt" },
  ],
};

test("reports render grouped by source with holds, evidence, reason, note, and blocked content", () => {
  const { root } = mount(async () => ({ ok: true }));
  const text = root.textContent ?? "";
  assert.match(text, /Screening reports/);
  assert.match(text, /Admins are not notified automatically/);
  assert.match(text, /Skill browse · v28 · built-in, managed by the org/);
  assert.match(text, /Credential request/);
  assert.match(text, /"HttpOnly included"/);
  assert.match(text, /Needs review/);
  assert.ok([...root.querySelectorAll("th")].some((th) => th.textContent?.trim() === "Holds"));
  assert.ok(
    [...root.querySelectorAll("td")].some((td) => td.textContent?.trim() === "7"),
    "the holds volume shows",
  );
  const detail = root.querySelector('[data-report="r1"]')!;
  assert.ok(detail, "a single source group opens its report details");
  assert.match(detail.textContent ?? "", /Describes collecting browser cookies/);
  assert.match(detail.textContent ?? "", /This is our own built-in skill/);
  assert.match(detail.textContent ?? "", /Text the screener flagged/);
  assert.match(detail.querySelector("pre")!.textContent ?? "", /--- name: browse/);
  assert.match(text, /Trusted skill versions/);
  assert.match(text, /jira/);
});

test("status actions mark correct, mark fixed, and reopen", async () => {
  const calls: unknown[][] = [];
  const api: Api = async (...args) => {
    calls.push(args);
    return { ok: true, data: {} };
  };
  const fx = mount(api);
  const click = (selector: string) => (fx.root.querySelector(selector) as HTMLButtonElement).click();
  click('[data-report="r1"] [data-act="flagger"]');
  assert.deepEqual(fx.opened, [report.content]);
  click('[data-report="r1"] [data-act="correct"]');
  await settle();
  click('[data-report="r1"] [data-act="fixed"]');
  await settle();
  assert.equal(fx.root.querySelector('[data-report="r1"] [data-act="reopen"]'), null);
  const closed = mount(api, {
    data: { ...data, groups: [{ ...data.groups[0], open: 0, reports: [{ ...report, status: "screen_correct" }] }] },
  });
  assert.equal(closed.root.querySelector('[data-report="r1"] [data-act="correct"]'), null);
  (closed.root.querySelector('[data-report="r1"] [data-act="reopen"]') as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["POST", "/api/screening-reports/r1/status", { status: "screen_correct" }],
    ["POST", "/api/screening-reports/r1/status", { status: "fixed" }],
    ["POST", "/api/screening-reports/r1/status", { status: "open" }],
  ]);
});

test("trusting a version first lists every file of it, and only the confirm posts the exact hash", async () => {
  const calls: unknown[][] = [];
  const fx = mount(async (...args) => {
    calls.push(args);
    return args[0] === "GET" ? { ok: true, data: preview } : { ok: true, data: {} };
  });
  (fx.root.querySelector('[data-report="r1"] [data-act="trust"]') as HTMLButtonElement).click();
  await settle();
  const dialog = fx.root.querySelector(".screening-trust-dialog")!;
  assert.ok(dialog, "a confirmation lists the version before anything is trusted");
  assert.deepEqual(
    [...dialog.querySelectorAll("[data-file]")].map((f) => f.getAttribute("data-file")),
    ["SKILL.md", "scripts/cookies.sh"],
  );
  assert.match(dialog.textContent ?? "", /curl --cookie-jar jar\.txt/);
  assert.match(dialog.textContent ?? "", /abc123/);
  assert.equal(calls.length, 1, "opening the dialog posts nothing");
  (dialog.querySelector('[data-act="trust-cancel"]') as HTMLButtonElement).click();
  assert.equal(fx.root.querySelector(".screening-trust-dialog"), null);
  (fx.root.querySelector('[data-report="r1"] [data-act="trust"]') as HTMLButtonElement).click();
  await settle();
  (fx.root.querySelector('[data-act="trust-confirm"]') as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["GET", "/api/skill-trusts/preview?skillId=skill-browse&version=28"],
    ["GET", "/api/skill-trusts/preview?skillId=skill-browse&version=28"],
    ["POST", "/api/skill-trusts", { skillId: "skill-browse", version: 28, contentHash: "abc123", reportId: "r1" }],
  ]);
  assert.equal(fx.reloads(), 1);
});

test("a report on an already trusted version offers no trust button", () => {
  const fx = mount(async () => ({ ok: true }), {
    data: { ...data, groups: [{ ...data.groups[0], reports: [{ ...report, trusted: true }] }] },
  });
  assert.equal(fx.root.querySelector('[data-report="r1"] [data-act="trust"]'), null);
  assert.match(fx.root.textContent ?? "", /This version is trusted/);
});

test("a skill that changed since the report shows the 409 message", async () => {
  const fx = mount(async () => ({
    ok: false,
    status: 409,
    data: { error: "skill_changed", message: "browse is now at v29; its new content is screened again" },
  }));
  (fx.root.querySelector('[data-report="r1"] [data-act="trust"]') as HTMLButtonElement).click();
  await settle();
  assert.match(fx.root.textContent ?? "", /browse is now at v29/);
  assert.equal(fx.root.querySelector(".screening-trust-dialog"), null);
  assert.equal(fx.reloads(), 0);
});

test("revoking a trust asks first", async () => {
  const calls: unknown[][] = [];
  const api: Api = async (...args) => {
    calls.push(args);
    return { ok: true, data: {} };
  };
  const declined = mount(api, { confirm: false });
  (declined.root.querySelector('[data-act="revoke"]') as HTMLButtonElement).click();
  await settle();
  assert.equal(calls.length, 0, "declining the confirmation revokes nothing");
  assert.match(declined.confirms[0] ?? "", /jira v3/);
  const accepted = mount(api);
  (accepted.root.querySelector('[data-act="revoke"]') as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["DELETE", "/api/skill-trusts/skill-jira%403"]]);
});

test("load more appends the next page of reports", async () => {
  const calls: unknown[][] = [];
  const older = { ...report, id: "r0", note: "older note", createdAt: 1_600_000_000_000 };
  const fx = mount(async (...args) => {
    calls.push(args);
    return {
      ok: true,
      data: { groups: [{ ...data.groups[0], reports: [older] }], trusts: [] },
    };
  });
  (fx.root.querySelector('[data-act="more"]') as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(calls[0], ["GET", "/api/screening-reports?status=all&before=1699000000000"]);
  assert.ok(fx.root.querySelector('[data-report="r0"]'), "the older report joins its group");
  assert.equal(fx.root.querySelector('[data-act="more"]'), null, "no further page");
});
