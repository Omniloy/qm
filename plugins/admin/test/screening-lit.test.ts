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
};

const data = {
  groups: [
    {
      sourceKey: "skill:skill-browse",
      source: skillSource,
      sourceLabel: "Skill browse · v28 · built-in, managed by the org",
      open: 1,
      reports: [report],
      trusted: null,
    },
  ],
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

function mount(api: (...args: unknown[]) => Promise<{ ok: boolean; status?: number; data?: any }>) {
  const fx = litFixture();
  const opened: string[] = [];
  let reloads = 0;
  const shells: unknown[] = [];
  fx.ui.screening.screening(fx.root, data, {
    api,
    fmtTime: () => "today",
    defaultShell: (extras: unknown) => shells.push(extras),
    openAutoFlagger: (content: string) => opened.push(content),
    reload: () => reloads++,
  });
  return { ...fx, opened, shells, reloads: () => reloads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("reports render grouped by source with evidence, reason, note, and blocked content", () => {
  const { root } = mount(async () => ({ ok: true }));
  const text = root.textContent ?? "";
  assert.match(text, /Screening reports/);
  assert.match(text, /Admins are not notified automatically/);
  assert.match(text, /Skill browse · v28 · built-in, managed by the org/);
  assert.match(text, /Credential request/);
  assert.match(text, /"HttpOnly included"/);
  assert.match(text, /Needs review/);
  const detail = root.querySelector('[data-report="r1"]')!;
  assert.ok(detail, "a single source group opens its report details");
  assert.match(detail.textContent ?? "", /Describes collecting browser cookies/);
  assert.match(detail.textContent ?? "", /This is our own built-in skill/);
  assert.match(detail.querySelector("pre")!.textContent ?? "", /--- name: browse/);
  assert.match(text, /Trusted skill versions/);
  assert.match(text, /jira/);
});

test("report actions call the screening and trust endpoints", async () => {
  const calls: unknown[][] = [];
  const fx = mount(async (...args) => {
    calls.push(args);
    return { ok: true, data: {} };
  });
  const click = (selector: string) => (fx.root.querySelector(selector) as HTMLButtonElement).click();
  click('[data-report="r1"] [data-act="flagger"]');
  assert.deepEqual(fx.opened, [report.content]);
  click('[data-report="r1"] [data-act="correct"]');
  await settle();
  click('[data-report="r1"] [data-act="trust"]');
  await settle();
  click('[data-act="revoke"]');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["POST", "/api/screening-reports/r1/status", { status: "screen_correct" }],
    ["POST", "/api/skill-trusts", { skillId: "skill-browse", version: 28, contentHash: "abc123", reportId: "r1" }],
    ["DELETE", "/api/skill-trusts/skill-jira%403"],
  ]);
  assert.equal(fx.reloads(), 3);
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
  assert.equal(fx.reloads(), 0);
});
