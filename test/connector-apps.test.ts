import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  CONNECTOR_APPS,
  connectorAppStates,
  connectorAppToolVisible,
  createConnectorAppPrefs,
  type ConnectorAppPrefsRecord,
} from "../src/connectors/connector-apps.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import type { McpToolDescriptor, McpToolService } from "../src/mcp/mcp-tool-service.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { harnessToolOptions } from "../src/harness/harness-shared.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

const MICROSOFT_APPS = [
  "mail",
  "calendar",
  "teams-chats",
  "teams-channels",
  "meeting-transcripts",
  "onedrive",
  "sharepoint",
];

const graphTool = (remoteName: string): McpToolDescriptor => ({
  name: `microsoft-365_${remoteName}`,
  serverId: "microsoft-365",
  remoteName,
  description: remoteName,
  inputSchema: { type: "object", properties: {} },
  readOnly: false,
  credentialHost: "graph.microsoft.com",
});

test("Microsoft 365 declares exactly the seven work apps, all on by default", () => {
  assert.deepEqual(
    connectorAppStates("microsoft", {}).map((app) => [app.id, app.enabled]),
    MICROSOFT_APPS.map((id) => [id, true]),
  );
  assert.deepEqual(connectorAppStates("google", {}), [], "providers without apps have no settings");
});

test("app settings persist per person in the durable map and merge partial updates", async () => {
  const map = createMemoryMap<ConnectorAppPrefsRecord>();
  const prefs = createConnectorAppPrefs(map, () => 42);
  assert.deepEqual(await prefs.disabled("ana@example.com"), {});

  const states = await prefs.set("ana@example.com", "microsoft", { mail: false, sharepoint: false });
  assert.deepEqual(
    states.filter((app) => !app.enabled).map((app) => app.id),
    ["mail", "sharepoint"],
  );
  await prefs.set("ana@example.com", "microsoft", { mail: true, calendar: false });
  assert.deepEqual(await prefs.disabled("ana@example.com"), { microsoft: ["calendar", "sharepoint"] });
  assert.deepEqual(await prefs.disabled("bo@example.com"), {}, "another person keeps the defaults");

  const reopened = createConnectorAppPrefs(map);
  assert.deepEqual(await reopened.disabled("ana@example.com"), { microsoft: ["calendar", "sharepoint"] });
  assert.equal((await map.get("ana@example.com"))?.updatedAt, 42);

  await assert.rejects(() => prefs.set("ana@example.com", "microsoft", { excel: false }), /unknown microsoft apps/);
  await assert.rejects(() => prefs.set("ana@example.com", "google", { mail: false }), /no app settings/);
});

test("a turned-off app hides its tools; shared tools stay while any of their apps is on", () => {
  const off = (...ids: string[]) => ({ microsoft: ids });
  assert.equal(connectorAppToolVisible(graphTool("send-mail"), {}), true);
  assert.equal(connectorAppToolVisible(graphTool("send-mail"), off("mail")), false);
  assert.equal(connectorAppToolVisible(graphTool("list-chats"), off("mail")), true);
  assert.equal(connectorAppToolVisible(graphTool("download-bytes"), off("onedrive")), true);
  assert.equal(connectorAppToolVisible(graphTool("download-bytes"), off("onedrive", "sharepoint")), false);
  assert.equal(connectorAppToolVisible(graphTool("get-current-user"), off(...MICROSOFT_APPS)), false);
  assert.equal(
    connectorAppToolVisible(graphTool("graph-batch"), {}),
    false,
    "a tool outside every app is never offered, whatever the sidecar lists",
  );
  assert.equal(
    connectorAppToolVisible({ remoteName: "send-mail", credentialHost: "api.example.com" }, off("mail")),
    true,
    "servers of providers without apps are untouched",
  );
  assert.equal(connectorAppToolVisible({ remoteName: "send-mail" }, off("mail")), true);
});

test("the turn's tool context offers and calls only the tools of the person's enabled apps", async () => {
  const defs = [graphTool("send-mail"), graphTool("list-chats"), graphTool("graph-batch")];
  const calls: string[] = [];
  const mcp = {
    toolDefs: () => defs,
    call: async (name: string) => {
      calls.push(name);
      return "ok";
    },
  } as unknown as McpToolService;
  const tc = createToolContext({
    sandbox: {} as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    layers: [],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    mcp,
    disabledConnectorApps: { microsoft: ["mail"] },
  });
  assert.deepEqual(
    tc.mcpToolDefs().map((def) => def.remoteName),
    ["list-chats"],
  );
  assert.equal(await tc.callMcpTool("microsoft-365_list-chats", {}), "ok");
  await assert.rejects(() => tc.callMcpTool("microsoft-365_send-mail", {}), /turned off/);
  assert.deepEqual(calls, ["microsoft-365_list-chats"]);

  const options = harnessToolOptions({ mcpTools: () => defs } as never, { tools: tc } as unknown as HarnessTurnInput);
  assert.deepEqual(
    options.mcpTools?.().map((def) => def.remoteName),
    ["list-chats"],
    "harness tool lists come from the turn's filtered context, not the global snapshot",
  );
});

test("the sidecar's ENABLED_TOOLS lists exactly the app tools and fits the per-server tool cap", () => {
  const union = [...new Set(Object.values(CONNECTOR_APPS).flatMap((apps) => apps.flatMap((app) => app.tools)))].sort();
  assert.ok(union.length <= 64, `MCP servers are capped at 64 tools, got ${union.length}`);
  const compose = readFileSync("deploy/dokploy/docker-compose.yml", "utf8");
  const regex = /ENABLED_TOOLS: "\^\(([^)]*)\)\$"/.exec(compose)?.[1];
  assert.ok(regex, "ms365-mcp sets ENABLED_TOOLS");
  assert.deepEqual(regex.split("|").sort(), union);
});

test("every skill an app names ships as a seed skill", () => {
  for (const apps of Object.values(CONNECTOR_APPS))
    for (const app of apps)
      for (const skill of app.skills) assert.ok(existsSync(`skills-seed/${skill}/SKILL.md`), `missing ${skill}`);
});
