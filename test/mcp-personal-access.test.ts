import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { envKey } from "../src/credentials/connector-token.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let threads = 0;

function turn(kind: "dm" | "channel", text: string): TurnRequest {
  const actor = { externalId: "U1" };
  return kind === "dm"
    ? { surface: "test", actor, conversation: { kind: "dm", threadRef: `dm:U1:${++threads}` }, text, liveActor: true }
    : {
        surface: "slack",
        actor,
        conversation: { kind: "channel", threadRef: "ch:C1", channelRef: "C1", audience: [actor] },
        text,
      };
}

test("per-person MCP tools reach only the connected person's own conversations, minus apps they turned off", async (t) => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "mcp-personal-")) }));
  const remote = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: rpc.id,
        result:
          rpc.method === "tools/call"
            ? { content: [{ type: "text", text: `called ${rpc.params.name}` }] }
            : {
                tools: [
                  { name: "send-draft-message", inputSchema: { type: "object" } },
                  { name: "list-chats", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
                ],
              },
      }),
    );
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  t.after(async () => {
    built.mcpToolService.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  });
  await built.mcpServers.put({
    id: "microsoft-365",
    name: "Microsoft 365",
    url: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`,
    auth: "none",
    credentialScope: "per-user",
    credentialHost: "graph.microsoft.com",
    readOnly: false,
    enabled: true,
    updatedAt: Date.now(),
    updatedBy: "internal:admin",
  });
  await built.mcpToolService.refresh();
  assert.deepEqual(
    built.mcpToolService.toolDefs().map((def) => [def.remoteName, def.perUser, def.approvalRequired]),
    [
      ["send-draft-message", true, true],
      ["list-chats", true, false],
    ],
    "writes of a per-person server need approval unless the server marks them read-only",
  );
  const tools = async (kind: "dm" | "channel") => (await built.app.turn(turn(kind, "!mcp_tools"))).reply;

  assert.equal(await tools("dm"), "mcp: none", "a person who hasn't connected is offered none of the tools");
  await built.connectorTokens.setConnectorToken("graph.microsoft.com", "U1", { accessToken: "u1-graph" });
  assert.equal(await tools("dm"), "mcp: microsoft-365_send-draft-message,microsoft-365_list-chats");
  assert.equal(await tools("channel"), "mcp: none", "a channel never gets the speaker's own account tools");
  await built.connectorAppPrefs.set("U1", "microsoft", { mail: false });
  assert.equal(await tools("dm"), "mcp: microsoft-365_list-chats");

  assert.equal(
    (await built.app.turn(turn("dm", "!mcp_call microsoft-365_list-chats"))).reply,
    "mcp: called list-chats",
  );
  await built.connectorAppPrefs.set("U1", "microsoft", { mail: true, "teams-chats": false });
  await assert.rejects(built.app.turn(turn("dm", "!mcp_call microsoft-365_list-chats")), /turned off/);
  const write = await built.app.turn(turn("dm", "!mcp_call microsoft-365_send-draft-message"));
  assert.equal(write.status, "pending_approval", "a write as the person waits for their approval in auto posture");

  const key = envKey("graph.microsoft.com");
  assert.equal((await built.app.turn(turn("dm", `!run test -z "$${key}" && echo absent`))).reply, "absent");
  const selected = `!execute ${JSON.stringify({ command: "true", credentials: ["connector_graph_microsoft_com_default"] })}`;
  await assert.rejects(built.app.turn(turn("dm", selected)), /not available/);
});
