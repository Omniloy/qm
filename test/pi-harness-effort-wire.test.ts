import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Type } from "typebox";
import { applyNoReasoning, createPiHarness } from "../src/harness/pi-harness.ts";
import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

// Exercise the real AgentSession and SDK serializer, not just the effort setter.
for (const [modelId, upper, allowed] of [
  ["gpt-5.4", "xhigh", ["none", "low", "medium", "high", "xhigh"]],
  ["gpt-5", "high", ["minimal", "low", "medium", "high"]],
] as const) {
  test(`Pi sends supported reasoning through HTTP for ${modelId}`, async (t) => {
    const bodies: Array<{
      reasoning?: { effort?: string };
      include?: string[];
      input: Array<Record<string, unknown>>;
    }> = [];
    let sendTool = false;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      bodies.push(body);
      if (body.reasoning && !(allowed as readonly string[]).includes(body.reasoning?.effort)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unsupported reasoning.effort", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (sendTool) {
        sendTool = false;
        const reasoning = {
          id: "rs_native",
          type: "reasoning",
          summary: [],
          ...(body.include?.includes("reasoning.encrypted_content")
            ? { encrypted_content: "encrypted-native-reasoning" }
            : {}),
        };
        const call = {
          id: "fc_native",
          type: "function_call",
          call_id: "call_native",
          name: "attach",
          arguments: JSON.stringify({ files: ["probe.txt"] }),
          status: "completed",
        };
        for (const event of [
          {
            type: "response.created",
            response: { id: "resp_tool", model: modelId, status: "in_progress", output: [] },
          },
          { type: "response.output_item.added", output_index: 0, item: reasoning },
          { type: "response.output_item.done", output_index: 0, item: reasoning },
          { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
          { type: "response.output_item.done", output_index: 1, item: call },
          {
            type: "response.completed",
            response: {
              id: "resp_tool",
              model: modelId,
              status: "completed",
              output: [reasoning, call],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
        return;
      }
      const message = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      };
      for (const event of [
        { type: "response.created", response: { id: "resp_test", model: modelId, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.completed",
          response: {
            id: "resp_test",
            model: modelId,
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
    const address = server.address();
    assert(address && typeof address !== "string");
    const originalMap = structuredClone(getRequiredModel(modelId).thinkingLevelMap);
    const harness = createPiHarness({
      defaultModelId: modelId,
      modelGateway: {
        url: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key",
        apiKeyHeader: "api-key",
        models: { [modelId]: modelId },
      },
    });
    t.after(() => harness.turns.close?.());
    // Repeat turns in the same conversation with different effort selections.
    for (const [effortLevel, expected] of [
      ["ultracode", upper],
      ["max", upper],
      ["medium", "medium"],
      ["low", "low"],
      ["high", "high"],
      ["minimal", modelId === "gpt-5" ? "minimal" : "low"],
      ["off", modelId === "gpt-5" ? "minimal" : "none"],
      ["xhigh", upper],
      ["auto", "medium"],
      ["default", undefined],
    ]) {
      await t.test(effortLevel!, async () => {
        let seq = 0;
        sendTool = effortLevel === "default";
        const result = await harness.turns.runTurn({
          session: { id: `effort-${modelId}` } as HarnessTurnInput["session"],
          input: "hello",
          systemPrompt: "Reply ok.",
          history: [],
          tools: {
            mcpToolDefs: () => [],
            attach: async () => ({ ok: true, files: [], staged: 0 }),
          } as unknown as HarnessTurnInput["tools"],
          scopeLabel: "personal:test",
          orgScopeId: "org:test",
          runtime: { effortLevel },
          emit: async (entry) => ({ ...entry, seq: seq++, createdAt: Date.now() }) as never,
          recordModelCall: () => {},
          cancel: AbortSignal.timeout(10_000),
        });
        assert.equal(result.reply, "ok");
        assert.equal(bodies.at(-1)?.reasoning?.effort, expected);
        if (effortLevel === "default") {
          assert.ok(bodies.at(-1)?.include?.includes("reasoning.encrypted_content"));
          assert.equal(
            bodies.at(-1)?.input.find((item) => item.type === "reasoning")?.encrypted_content,
            "encrypted-native-reasoning",
          );
          assert.ok(bodies.at(-1)?.input.some((item) => item.type === "function_call_output"));
        }
      });
    }
    assert.deepEqual(
      getRequiredModel(modelId).thinkingLevelMap,
      originalMap,
      "must not widen the model's supported efforts",
    );
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("voice replies turn reasoning off for Terra, run the fallback at its lowest effort, and stream tools", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(body);
    const call = {
      id: "fc_voice",
      type: "function_call",
      call_id: "call_voice",
      name: "delegate_task",
      arguments: JSON.stringify({ instruction: "book it", title: "Booking" }),
      status: "completed",
    };
    const message = {
      id: "msg_voice",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Vale.", annotations: [] }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "resp_voice", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Vale." },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.output_item.done", output_index: 1, item: call },
      {
        type: "response.completed",
        response: {
          id: "resp_voice",
          status: "completed",
          output: [message, call],
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 },
        },
      },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  const address = server.address();
  assert(address && typeof address !== "string");
  const harness = createPiHarness({
    modelGateway: {
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      apiKeyHeader: "api-key",
      models: { "gpt-6.1-terra": "gpt-6.1-terra", "gpt-6.1-sol": "gpt-6.1-sol" },
    },
  });
  const reply = (modelId: string, reasoning: "none" | "lowest") =>
    collect(
      harness.models.streamVoiceReply!({
        candidates: [{ modelId, reasoning }],
        systemPrompt: "Speak briefly.",
        messages: [
          { role: "user", content: "book a flight" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_prev|fc_prev", name: "check_tasks", args: {} }],
          },
          { role: "tool", toolCallId: "call_prev|fc_prev", name: "check_tasks", content: "no tasks" },
        ],
        tools: [
          { name: "delegate_task", description: "Delegate.", parameters: Type.Object({ instruction: Type.String() }) },
        ],
        maxTokens: 300,
        signal: AbortSignal.timeout(10_000),
      }),
    );
  const terra = await reply("gpt-6.1-terra", "none");
  assert.deepEqual(terra[0], { type: "start", modelId: "gpt-6.1-terra" });
  assert.deepEqual(terra[1], { type: "delta", text: "Vale." });
  assert.equal(terra[2]?.type, "tool_call");
  assert.deepEqual(terra[2]?.type === "tool_call" ? terra[2].args : undefined, {
    instruction: "book it",
    title: "Booking",
  });
  const end = terra.at(-1);
  assert.equal(end?.type, "end");
  assert.equal(end?.type === "end" ? end.outcome : undefined, "done");
  assert.equal(end?.type === "end" ? end.usage?.costUsd : undefined, 9.5);
  assert.deepEqual(bodies.at(-1)?.reasoning, { effort: "none" });
  assert.equal(bodies.at(-1)?.max_output_tokens, 300);
  const sent = bodies.at(-1) ?? {};
  assert.deepEqual(
    (sent.tools as Array<{ name: string }>).map((tool) => tool.name),
    ["delegate_task"],
  );
  assert.ok((sent.input as Array<{ type?: string }>).some((item) => item.type === "function_call_output"));
  await reply("gpt-6.1-sol", "lowest");
  assert.equal((bodies.at(-1)?.reasoning as { effort?: string } | undefined)?.effort, "low");
  const unservable = await collect(
    harness.models.streamVoiceReply!({
      candidates: [{ modelId: "claude-sonnet-5-5", reasoning: "none" }],
      systemPrompt: "",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      maxTokens: 300,
      signal: AbortSignal.timeout(10_000),
    }),
  );
  assert.deepEqual(unservable, [{ type: "unsupported" }]);
});

test("a voice model the endpoint rejects falls back to the user's default model before anything is spoken", async (t) => {
  const models: unknown[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    models.push(body.model);
    if (body.model === "gpt-6.1-terra") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model not served", type: "invalid_request_error" } }));
      return;
    }
    const message = {
      id: "msg_sol",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hola.", annotations: [] }],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "resp_sol", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hola." },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: "resp_sol",
          status: "completed",
          output: [message],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  const address = server.address();
  assert(address && typeof address !== "string");
  const harness = createPiHarness({
    modelGateway: {
      url: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      apiKeyHeader: "api-key",
      models: { "gpt-6.1-terra": "gpt-6.1-terra", "gpt-6.1-sol": "gpt-6.1-sol" },
    },
  });
  const events = await collect(
    harness.models.streamVoiceReply!({
      candidates: [
        { modelId: "gpt-6.1-terra", reasoning: "none" },
        { modelId: "gpt-6.1-sol", reasoning: "lowest" },
      ],
      systemPrompt: "Speak briefly.",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      maxTokens: 300,
      signal: AbortSignal.timeout(10_000),
    }),
  );
  assert.deepEqual(models, ["gpt-6.1-terra", "gpt-6.1-sol"]);
  assert.deepEqual(
    events.filter((event) => event.type === "start" || event.type === "delta").map((e) => e.type),
    ["start", "delta"],
  );
  const end = events.at(-1);
  assert.equal(end?.type === "end" ? end.outcome : undefined, "done");
  assert.equal(end?.type === "end" ? end.modelId : undefined, "gpt-6.1-sol");
});

test("voice replies on Sonnet 5.5 switch thinking to between_tools and survive the thinking-binding pass", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [event, data] of [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
      ],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hola." } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }],
    ] as const)
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  const address = server.address();
  assert(address && typeof address !== "string");
  setProviderBaseUrls({ anthropic: `http://127.0.0.1:${address.port}` });
  t.after(() => setProviderBaseUrls({}));
  const harness = createPiHarness({ apiKey: "sk-ant-test" });
  const events = await collect(
    harness.models.streamVoiceReply!({
      candidates: [{ modelId: "claude-sonnet-5-5", reasoning: "none" }],
      systemPrompt: "Speak briefly.",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      maxTokens: 300,
      signal: AbortSignal.timeout(10_000),
    }),
  );
  assert.deepEqual(
    events.filter((event) => event.type === "delta"),
    [{ type: "delta", text: "Hola." }],
  );
  assert.deepEqual(bodies.at(-1)?.thinking, { type: "between_tools" });
  assert.equal((bodies.at(-1)?.output_config as { effort?: unknown } | undefined)?.effort, undefined);
});

test("applyNoReasoning asks each API for no reasoning in its own dialect", () => {
  const codex = { reasoning: { effort: "medium", summary: "auto" }, model: "gpt-6.1-terra" };
  applyNoReasoning(codex, getRequiredModel("codex/gpt-6.1-terra"));
  assert.deepEqual(codex.reasoning, { effort: "none" });
  const anthropic: Record<string, unknown> = {
    thinking: { type: "adaptive" },
    output_config: { effort: "max", format: "x" },
  };
  applyNoReasoning(anthropic, getRequiredModel("claude-sonnet-5-5"));
  assert.deepEqual(anthropic, { thinking: { type: "between_tools" }, output_config: { format: "x" } });
  const responses = { reasoning: { effort: "none" } };
  applyNoReasoning(responses, getRequiredModel("gpt-6.1-terra"));
  assert.deepEqual(responses, { reasoning: { effort: "none" } });
});
