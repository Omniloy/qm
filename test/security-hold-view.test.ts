import { test } from "node:test";
import assert from "node:assert/strict";
import {
  securityHoldGroupLabel,
  securityHoldSourceKey,
  securityHoldStep,
  securityHoldView,
  type SecurityHold,
} from "../src/security/security-hold.ts";

const skill = (extra: Partial<Extract<SecurityHold["source"], { kind: "skill" }>> = {}): SecurityHold["source"] => ({
  kind: "skill",
  skillId: "s1",
  name: "jira",
  version: 3,
  contentHash: "h",
  builtIn: false,
  ...extra,
});

test("each source kind gets a title, a derived step, and a grouping key", () => {
  const web = { kind: "web", host: "docs.example.com", tool: "fetch_page" } as const;
  const file = { kind: "file", path: "shared/plan.md" } as const;
  const tool = { kind: "tool", tool: "linear_search", server: "linear" } as const;
  assert.equal(securityHoldStep({ source: web }), "Fetching content from docs.example.com");
  assert.equal(securityHoldStep({ source: file }), "Reading shared/plan.md");
  assert.equal(
    securityHoldStep({ source: tool, scheduledTask: { id: "c9", title: "Weekly digest" } }),
    "Using the linear_search tool · scheduled task Weekly digest",
  );
  const view = (source: SecurityHold["source"]) => securityHoldView({ source, category: "data_exfiltration" });
  assert.equal(view(web).title, "Paused: content from docs.example.com");
  assert.equal(view(web).held, "content from docs.example.com");
  assert.equal(view(file).title, "Paused: content of shared/plan.md");
  assert.equal(view(tool).title, "Paused: output of the linear_search tool");
  assert.match(
    view(web).explanation,
    /before the assistant read it, because it appears to tell the assistant to send data/,
  );
  assert.deepEqual(view(web).facts[0], {
    label: "Source",
    value: "Requested URL host: docs.example.com (via fetch_page)",
  });
  assert.equal(view(web).facts.length, 2, "no reason fact without a screener reason");
  assert.equal(securityHoldSourceKey(web), "web:docs.example.com");
  assert.equal(securityHoldSourceKey(tool), "tool:linear:linear_search");
  assert.equal(securityHoldGroupLabel({ kind: "command", command: "ls" }), "Commands");
  assert.equal(securityHoldGroupLabel(file), "Files");
});

test("skill wording follows what was read and who manages the skill", () => {
  const instructions = securityHoldView({
    source: skill({ owner: "Enrique Alcazar" }),
    category: "credential_request",
  });
  assert.match(
    instructions.explanation,
    /the jira skill's instructions before the assistant read them, because they appear/,
  );
  assert.equal(instructions.facts[0]!.value, "Skill jira · v3 · owned by Enrique Alcazar");
  const asset = securityHoldView({ source: skill({ path: "references/api.md" }), category: "credential_request" });
  assert.match(asset.explanation, /content from the jira skill \(references\/api\.md\) before the assistant read it/);
  assert.equal(
    securityHoldStep({ source: skill({ path: "references/api.md" }) }),
    "Reading references/api.md from the skill",
  );
  assert.equal(
    securityHoldView({ source: skill({ packId: "acme-tools" }), category: "other" }).facts[0]!.value,
    "Skill jira · v3 · Skill pack acme-tools",
    "third-party packs are not called built-in",
  );
  const builtIn = securityHoldView({ source: skill({ builtIn: true }), category: "other" });
  assert.equal(builtIn.facts[0]!.value, "Skill jira · v3 · built-in");
  assert.doesNotMatch(JSON.stringify(builtIn), /usually safe/);
});

test("the choices say what actually happens to the content and the run", () => {
  const live = securityHoldView({ source: skill(), category: "other" });
  assert.equal(
    live.allowEffect,
    "The assistant gets this exact content once, as untrusted data, and carries on. It stays in this conversation's history.",
  );
  assert.match(live.keepEffect, /stays out of the conversation and the assistant stops here/);
  const scheduled = securityHoldView({
    source: { kind: "command", command: "jira-followup" },
    category: "other",
    scheduledTask: { id: "c1", title: "Features Jira" },
  });
  assert.equal(scheduled.title, "Paused: output of a command in Features Jira");
  assert.match(
    scheduled.allowEffect,
    /exact content once, as untrusted data, and this run of Features Jira carries on/,
  );
  assert.match(scheduled.allowEffect, /stays in that run's history/);
  assert.equal(
    scheduled.keepEffect,
    "This run of Features Jira stops without it and delivers nothing. The next scheduled run starts fresh.",
  );
});
