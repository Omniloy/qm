import test from "node:test";
import assert from "node:assert/strict";
import { filterConnectorSkills } from "../src/core/orchestrator.ts";
import type { SkillResolution } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

function skill(name: string): SkillResolution {
  return {
    skill: {
      id: name,
      scopeId: scopeId("org", "acme"),
      manifest: { name, description: name, requiredCapabilities: [], body: name },
      signature: "sig",
      status: "published",
      createdBy: "test",
      version: 1,
      grantedCapabilities: [],
      approvals: [],
      createdAt: 1,
      updatedAt: 1,
    },
    shadowed: [],
  };
}

test("provider skills are visible only for connectors configured by the admin", () => {
  const all = [
    skill("memory"),
    skill("google-workspace"),
    skill("dropbox"),
    skill("linear"),
    skill("x"),
    skill("slack-drafts"),
    skill("microsoft-365"),
    skill("microsoft-365-mail"),
    skill("microsoft-365-teams"),
  ];
  assert.deepEqual(
    filterConnectorSkills(all, []).map((entry) => entry.skill?.manifest.name),
    ["memory"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["google", "linear"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "google-workspace", "linear"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["microsoft"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "microsoft-365", "microsoft-365-mail", "microsoft-365-teams"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["slack"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "slack-drafts"],
  );
});

test("the credential-backed Composio skill needs no dedicated OAuth configuration", () => {
  assert.deepEqual(
    filterConnectorSkills([skill("composio"), skill("google-workspace")], []).map(
      (entry) => entry.skill?.manifest.name,
    ),
    ["composio"],
  );
});

test("a person's turned-off Microsoft 365 apps drop their skills; shared skills stay while any app is on", () => {
  const all = [
    skill("memory"),
    skill("microsoft-365"),
    skill("microsoft-365-mail"),
    skill("microsoft-365-teams"),
    skill("microsoft-365-files"),
  ];
  const names = (disabled: string[]) =>
    filterConnectorSkills(all, ["microsoft"], { microsoft: disabled }).map((entry) => entry.skill?.manifest.name);
  assert.deepEqual(names(["mail", "onedrive"]), [
    "memory",
    "microsoft-365",
    "microsoft-365-teams",
    "microsoft-365-files",
  ]);
  assert.deepEqual(names(["teams-chats"]), [
    "memory",
    "microsoft-365",
    "microsoft-365-mail",
    "microsoft-365-teams",
    "microsoft-365-files",
  ]);
  assert.deepEqual(
    names(["mail", "calendar", "teams-chats", "teams-channels", "meeting-transcripts", "onedrive", "sharepoint"]),
    ["memory"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, [], {}).map((entry) => entry.skill?.manifest.name),
    ["memory"],
    "an unconfigured provider hides every app skill regardless of settings",
  );
});
