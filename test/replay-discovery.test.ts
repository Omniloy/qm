import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
import { claudeReplayTranscript } from "../src/harness/claude-harness.ts";
import type { SessionEntry } from "../src/types.ts";

function ent(type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry {
  return { sessionId: "s", seq, parentSeq: null, type, payload, scopeLabel: "org:default-org", createdAt: seq };
}

test("a tool run through a discovery call_tool replays as that call_tool, never as the hidden real tool", () => {
  const history = [
    ent("user", { text: "list my chats" }, 1),
    ent(
      "tool_call",
      {
        tool: "microsoft-365_list-chats",
        mcpServer: "microsoft-365",
        args: { top: 5 },
        via: "microsoft-365_call_tool",
        callId: "c1",
      },
      2,
    ),
    ent("tool_result", { callId: "c1", result: "chat list" }, 3),
  ];
  const messages = reconstructMessagesFromHistory(history);
  const call = messages.find((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"));
  assert.deepEqual(call && call.role === "assistant" ? call.content[0] : undefined, {
    type: "toolCall",
    id: "c1",
    name: "microsoft-365_call_tool",
    arguments: { name: "list-chats", arguments: { top: 5 } },
  });
  const result = messages.find((m) => m.role === "toolResult");
  assert.equal(result && result.role === "toolResult" ? result.toolName : "", "microsoft-365_call_tool");
  const transcript = claudeReplayTranscript(messages);
  assert.match(transcript, /microsoft-365_call_tool/);
  assert.doesNotMatch(transcript, /microsoft-365_list-chats/);
});

test("a direct MCP tool call still replays under its own name", () => {
  const messages = reconstructMessagesFromHistory([
    ent("user", { text: "query the crm" }, 1),
    ent("tool_call", { tool: "crm_query", mcpServer: "crm", args: { q: "x" }, callId: "c2" }, 2),
    ent("tool_result", { callId: "c2", result: "rows" }, 3),
  ]);
  const call = messages.find((m) => m.role === "assistant");
  assert.equal(
    call && call.role === "assistant" && call.content[0]?.type === "toolCall" ? call.content[0].name : "",
    "crm_query",
  );
});
