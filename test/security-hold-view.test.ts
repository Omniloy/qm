import { test } from "node:test";
import assert from "node:assert/strict";
import {
  securityHoldSourceKey,
  securityHoldStep,
  securityHoldView,
  type SecurityHold,
} from "../src/security/security-hold.ts";

test("each source kind gets a title, a step, and a grouping key", () => {
  const web = { kind: "web", host: "docs.example.com", tool: "fetch_page" } as const;
  const file = { kind: "file", path: "shared/plan.md" } as const;
  const tool = { kind: "tool", tool: "linear_search", server: "linear" } as const;
  assert.equal(securityHoldStep(web), "Fetching content from docs.example.com");
  assert.equal(securityHoldStep(file), "Reading shared/plan.md");
  assert.equal(
    securityHoldStep(tool, { id: "c9", title: "Weekly digest" }),
    "Using the linear_search tool · scheduled task Weekly digest",
  );
  const view = (source: SecurityHold["source"]) =>
    securityHoldView({ source, step: securityHoldStep(source), category: "data_exfiltration" });
  assert.equal(view(web).title, "Paused: content from docs.example.com");
  assert.equal(view(file).title, "Paused: content of shared/plan.md");
  assert.equal(view(tool).title, "Paused: output of the linear_search tool");
  assert.match(view(web).explanation, /send data somewhere it shouldn't go/);
  assert.equal(view(web).facts.length, 2, "no reason fact without a screener reason");
  assert.equal(securityHoldSourceKey(web), "web:docs.example.com");
  assert.equal(securityHoldSourceKey(tool), "tool:linear:linear_search");
});

test("a skill's source line says who owns it and whether it is built in", () => {
  const owned = securityHoldView({
    source: {
      kind: "skill",
      skillId: "s1",
      name: "jira",
      version: 3,
      contentHash: "h",
      builtIn: false,
      owner: "Enrique Alcazar",
    },
    step: "Reading the skill's instructions",
    category: "credential_request",
    reason: "Asks for a Jira API token.",
  });
  assert.deepEqual(owned.facts, [
    { label: "Source", value: "Skill jira · v3 · owned by Enrique Alcazar" },
    { label: "Step", value: "Reading the skill's instructions" },
    { label: "Screener's reason", value: "Asks for a Jira API token." },
  ]);
  assert.equal(owned.subject, "jira");
  assert.doesNotMatch(owned.allowEffect, /built-in/);
  assert.match(owned.keepEffect, /without the jira instructions/);
});
