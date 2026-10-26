import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  CONNECTOR_APPS,
  DEFAULT_DISABLED_CONNECTOR_APPS,
  connectorAppStates,
  connectorAppToolVisible,
  createConnectorAppPrefs,
  type ConnectorAppPrefsRecord,
} from "../src/connectors/connector-apps.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { personalMcpKey, type McpToolDescriptor, type McpToolService } from "../src/mcp/mcp-tool-service.ts";
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
  perUser: true,
  approvalRequired: false,
  credentialHost: "graph.microsoft.com",
  credentialAccountType: "default",
});

const sharedTool: McpToolDescriptor = {
  name: "crm_query",
  serverId: "crm",
  remoteName: "query",
  description: "query",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  perUser: false,
  approvalRequired: false,
};

test("Microsoft 365 declares the seven work apps; the heaviest start off for new people", () => {
  assert.deepEqual(
    connectorAppStates("microsoft", DEFAULT_DISABLED_CONNECTOR_APPS).map((app) => [app.id, app.enabled]),
    [
      ["mail", true],
      ["calendar", true],
      ["teams-chats", true],
      ["teams-channels", false],
      ["meeting-transcripts", false],
      ["onedrive", true],
      ["sharepoint", false],
    ],
  );
  assert.deepEqual(
    connectorAppStates("microsoft", {}).map((app) => app.id),
    MICROSOFT_APPS,
  );
  assert.deepEqual(connectorAppStates("google", {}), [], "providers without apps have no settings");
  assert.deepEqual(connectorAppStates("__proto__", {}), []);
});

test("app settings persist per person in the durable map, merge partial updates, and keep defaults for the rest", async () => {
  const map = createMemoryMap<ConnectorAppPrefsRecord>();
  const prefs = createConnectorAppPrefs(map, () => 42);
  assert.deepEqual(await prefs.disabled("ana@example.com"), DEFAULT_DISABLED_CONNECTOR_APPS);

  const states = await prefs.set("ana@example.com", "microsoft", { mail: false, sharepoint: true });
  assert.deepEqual(
    states.filter((app) => !app.enabled).map((app) => app.id),
    ["mail", "teams-channels", "meeting-transcripts"],
  );
  await prefs.set("ana@example.com", "microsoft", { mail: true, calendar: false });
  const expected = { microsoft: ["calendar", "teams-channels", "meeting-transcripts"] };
  assert.deepEqual(await prefs.disabled("ana@example.com"), expected);
  assert.deepEqual(await prefs.disabled("bo@example.com"), DEFAULT_DISABLED_CONNECTOR_APPS);

  assert.deepEqual(await createConnectorAppPrefs(map).disabled("ana@example.com"), expected);
  assert.equal((await map.get("ana@example.com"))?.updatedAt, 42);

  await assert.rejects(() => prefs.set("ana@example.com", "microsoft", { excel: false }), /unknown microsoft apps/);
  await assert.rejects(() => prefs.set("ana@example.com", "google", { mail: false }), /no app settings/);
  await assert.rejects(() => prefs.set("ana@example.com", "__proto__", {}), /no app settings/);
});

test("a turned-off app hides its tools; shared tools stay while any of their apps is on", () => {
  const off = (...ids: string[]) => ({ microsoft: ids });
  assert.equal(connectorAppToolVisible(graphTool("send-draft-message"), off()), true);
  assert.equal(connectorAppToolVisible(graphTool("send-draft-message"), off("mail")), false);
  assert.equal(connectorAppToolVisible(graphTool("list-chats"), off("mail")), true);
  assert.equal(connectorAppToolVisible(graphTool("download-bytes"), off("onedrive")), true);
  assert.equal(connectorAppToolVisible(graphTool("download-bytes"), off("onedrive", "sharepoint")), false);
  assert.equal(connectorAppToolVisible(graphTool("get-current-user"), off(...MICROSOFT_APPS)), false);
  assert.equal(
    connectorAppToolVisible(graphTool("graph-batch"), off(...MICROSOFT_APPS)),
    true,
    "a tool no app claims is left to the server's own allowlist, never silently dropped",
  );
  assert.equal(
    connectorAppToolVisible({ remoteName: "send-mail", credentialHost: "api.example.com" }, off("mail")),
    true,
    "servers of providers without apps are untouched",
  );
});

function toolContext(defs: McpToolDescriptor[], calls: string[], extra: Partial<ToolContextDeps>) {
  const mcp = {
    toolDefs: () => defs,
    call: async (name: string) => {
      calls.push(name);
      return "ok";
    },
  } as unknown as McpToolService;
  return createToolContext({
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
    ...extra,
  });
}

test("per-person MCP tools need personal access, a connected account, and an enabled app", async () => {
  const defs = [sharedTool, graphTool("send-draft-message"), graphTool("list-chats")];
  const calls: string[] = [];
  const names = (extra: Partial<ToolContextDeps>) =>
    toolContext(defs, calls, extra)
      .mcpToolDefs()
      .map((def) => def.name);
  const connected = new Set([personalMcpKey("graph.microsoft.com", "default")]);

  assert.deepEqual(names({}), ["crm_query"], "a shared conversation gets no per-person tools");
  assert.deepEqual(names({ personalMcpAccess: new Set() }), ["crm_query"], "an unconnected person gets none");
  assert.deepEqual(names({ personalMcpAccess: connected, disabledConnectorApps: { microsoft: ["mail"] } }), [
    "crm_query",
    "microsoft-365_list-chats",
  ]);

  const shared = toolContext(defs, calls, {});
  await assert.rejects(() => shared.callMcpTool("microsoft-365_list-chats", {}), /only offered in their DM/);
  const unconnected = toolContext(defs, calls, { personalMcpAccess: new Set() });
  await assert.rejects(() => unconnected.callMcpTool("microsoft-365_list-chats", {}), /connect that account/);
  const tc = toolContext(defs, calls, { personalMcpAccess: connected, disabledConnectorApps: { microsoft: ["mail"] } });
  assert.equal(await tc.callMcpTool("microsoft-365_list-chats", {}), "ok");
  await assert.rejects(() => tc.callMcpTool("microsoft-365_send-draft-message", {}), /turned off/);
  assert.equal(await shared.callMcpTool("crm_query", {}), "ok");
  assert.deepEqual(calls, ["microsoft-365_list-chats", "crm_query"]);

  let open = true;
  const speaker = toolContext(defs, calls, {
    personalMcpAccess: connected,
    authorizePersonalMcp: async () => {
      if (!open) throw new Error("Open speaker keychain access is no longer authorized");
    },
  });
  assert.equal(await speaker.callMcpTool("microsoft-365_list-chats", {}), "ok");
  open = false;
  await assert.rejects(() => speaker.callMcpTool("microsoft-365_list-chats", {}), /no longer authorized/);
  assert.equal(await speaker.callMcpTool("crm_query", {}), "ok", "shared tools don't re-check the speaker");
  calls.length = 0;

  const options = harnessToolOptions({} as never, { tools: tc } as unknown as HarnessTurnInput);
  assert.deepEqual(
    options.mcpTools?.().map((def) => def.name),
    ["crm_query", "microsoft-365_list-chats"],
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
