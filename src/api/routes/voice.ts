import { randomUUID } from "node:crypto";
import { scopeId } from "../../types.ts";
import { countTokens } from "../../util/tokens.ts";
import { errMessage, swallow } from "../../util/errors.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { sendJson } from "../http.ts";
import { audit, isObj, orgScope } from "./shared.ts";
import type { HarnessVoiceMessage, HarnessVoiceReplyEvent } from "../../harness/harness.ts";
import {
  actedThisTurn,
  announcesAction,
  parseVoiceReplyRequest,
  voiceCandidates,
  voiceNotice,
  voiceSystemPrompt,
  VOICE_FACT_MAX_CHARS,
  VOICE_MAX_FACTS,
  VOICE_MAX_OUTPUT_TOKENS,
  VOICE_READ_TOOL_NAMES,
  VOICE_WRITTEN_MAX_CHARS,
  voiceTools,
} from "../../voice/voice-reply.ts";
import {
  readConversation,
  recentConversations,
  voiceUsageThread,
  type VoiceToolResult,
} from "../../voice/voice-conversations.ts";
import { resolveVoiceOrgConfig } from "../../voice/voice-config.ts";
import { voiceMemory, type VoiceMemory } from "../../voice/voice-memory.ts";
import {
  appendVoiceTranscript,
  parseVoiceActivity,
  addVoiceActivity,
  type VoiceActivity,
  type VoiceTranscriptEntry,
  type VoiceTranscriptNote,
} from "../../voice/voice-transcript.ts";
import type { ApiCtx, Route } from "./route.ts";

const VOICE_MAX_SERVER_HOPS = 4;
const ACTS_ON_READ = new Set(["delegate_task", "send_task_message"]);
const VOICE_MAX_TRANSCRIPT_NOTES = 3;

type VoiceEnd = Extract<HarnessVoiceReplyEvent, { type: "end" }>;
type VoiceCall = Extract<HarnessVoiceReplyEvent, { type: "tool_call" }>;

function voicePrincipal(ctx: ApiCtx, asserted: unknown): string | null {
  if (ctx.capability) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "voice requires a person, not an agent capability" });
    return null;
  }
  const principalId = ctx.actor?.p ?? (typeof asserted === "string" ? asserted.trim() : "");
  if (principalId) return principalId;
  sendJson(ctx.res, 403, { error: "forbidden", message: "voice needs a principalId" });
  return null;
}

async function voiceEnabled(ctx: ApiCtx, principalId: string): Promise<boolean> {
  return (await ctx.deps.featureFlags?.enabled("voice_assistant", scopeId("personal", principalId))) === true;
}

async function access(ctx: ApiCtx): Promise<void> {
  const principalId = voicePrincipal(ctx, ctx.url.searchParams.get("principalId"));
  if (!principalId) return;
  if (!(await voiceEnabled(ctx, principalId))) return sendJson(ctx.res, 200, { enabled: false });
  const stored = await ctx.deps.config?.getVoiceConfigDurable(orgScope(ctx.deps));
  sendJson(ctx.res, 200, { enabled: true, config: resolveVoiceOrgConfig(stored) });
}

async function transcript(ctx: ApiCtx): Promise<void> {
  const principalId = voicePrincipal(ctx, ctx.url.searchParams.get("principalId"));
  if (!principalId) return;
  if (!(await voiceEnabled(ctx, principalId))) return sendJson(ctx.res, 403, { error: "feature_disabled" });
  const entries = (await ctx.deps.voiceTranscripts?.get(principalId))?.entries ?? [];
  sendJson(ctx.res, 200, { entries });
}

function parseTranscriptNotes(value: unknown): VoiceTranscriptNote[] | null {
  if (!Array.isArray(value) || !value.length || value.length > VOICE_MAX_TRANSCRIPT_NOTES) return null;
  const notes = value.map((note): VoiceTranscriptNote | null => {
    if (!isObj(note) || typeof note.text !== "string") return null;
    const role = note.role === "user" || note.role === "assistant" ? note.role : null;
    const text = note.text.trim();
    const activity = note.activity === undefined ? undefined : parseVoiceActivity(note.activity);
    if (!role || activity === null || text.length > VOICE_WRITTEN_MAX_CHARS) return null;
    if (activity && role !== "assistant") return null;
    if (!text && !activity) return null;
    return { role, text, ...(activity ? { activity } : {}) };
  });
  return notes.every((note): note is VoiceTranscriptNote => note !== null) ? notes : null;
}

async function appendTranscript(ctx: ApiCtx): Promise<void> {
  const principalId = voicePrincipal(ctx, isObj(ctx.body) ? ctx.body.principalId : undefined);
  if (!principalId) return;
  if (!(await voiceEnabled(ctx, principalId))) return sendJson(ctx.res, 403, { error: "feature_disabled" });
  const notes = parseTranscriptNotes(isObj(ctx.body) ? ctx.body.entries : undefined);
  if (!notes) return sendJson(ctx.res, 400, { error: "invalid_request" });
  const store = ctx.deps.voiceTranscripts;
  if (!store) return sendJson(ctx.res, 200, { entries: [] });
  const entries: VoiceTranscriptEntry[] = [];
  for (const note of notes) entries.push(await appendVoiceTranscript(store, principalId, note));
  sendJson(ctx.res, 200, { entries });
}

async function updateActivity(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = voicePrincipal(ctx, body.principalId);
  if (!principalId) return;
  if (!(await voiceEnabled(ctx, principalId))) return sendJson(ctx.res, 403, { error: "feature_disabled" });
  const entryId = typeof body.entryId === "string" ? body.entryId : "";
  const activity = parseVoiceActivity(body.activity);
  if (!entryId || !activity) return sendJson(ctx.res, 400, { error: "invalid_request" });
  const store = ctx.deps.voiceTranscripts;
  const entry = store ? await addVoiceActivity(store, principalId, entryId, activity) : null;
  if (!entry) return sendJson(ctx.res, 404, { error: "not_found" });
  sendJson(ctx.res, 200, { entry });
}

function unsaid(spoken: string, messages: readonly HarnessVoiceMessage[]): string {
  const said = spoken.trim();
  if (messages.at(-1)?.role !== "tool") return said;
  const before =
    [...messages]
      .reverse()
      .find((message) => message.role === "assistant")
      ?.content.trim() ?? "";
  return before && said.startsWith(before) ? said.slice(before.length).trim() : said;
}

async function admitHop(ctx: ApiCtx, principalId: string): Promise<"rate_limited" | "over_budget" | null> {
  const rate = await ctx.deps.rateLimiter?.check(`voice:${principalId}`);
  if (rate && !rate.allowed) return "rate_limited";
  if (ctx.deps.budget && !(await ctx.deps.budget.check(principalId)).allowed) return "over_budget";
  return null;
}

async function recordTranscript(ctx: ApiCtx, principalId: string, note: VoiceTranscriptNote): Promise<string | null> {
  const store = ctx.deps.voiceTranscripts;
  if (!store) return null;
  try {
    return (await appendVoiceTranscript(store, principalId, note)).id;
  } catch (err) {
    swallow("voice: record transcript", err);
    return null;
  }
}

async function attachActivity(
  ctx: ApiCtx,
  principalId: string,
  entryId: string,
  activity: VoiceActivity,
): Promise<boolean> {
  const store = ctx.deps.voiceTranscripts;
  if (!store) return false;
  try {
    return (await addVoiceActivity(store, principalId, entryId, [activity])) !== null;
  } catch (err) {
    swallow("voice: record activity", err);
    return false;
  }
}

interface ServerToolState {
  compacted: boolean;
  read: boolean;
}

const isReadTool = (name: string): name is (typeof VOICE_READ_TOOL_NAMES)[number] =>
  (VOICE_READ_TOOL_NAMES as readonly string[]).includes(name);

async function runReadTool(ctx: ApiCtx, principalId: string, call: VoiceCall): Promise<VoiceToolResult> {
  try {
    return call.name === "recent_conversations"
      ? await recentConversations(ctx.app, principalId, call.args)
      : await readConversation(ctx.app, principalId, call.args);
  } catch (err) {
    swallow(`voice: ${call.name}`, err);
    return { content: JSON.stringify({ ok: false, error: "read_failed" }), isError: true };
  }
}

function parseFacts(args: Record<string, unknown>): string[] | null {
  const facts = args.facts;
  if (!Array.isArray(facts) || !facts.length || facts.length > VOICE_MAX_FACTS) return null;
  const clean = facts.map((fact) => (typeof fact === "string" ? fact.trim() : ""));
  return clean.every((fact) => fact && fact.length <= VOICE_FACT_MAX_CHARS) ? clean : null;
}

async function runMemoryTool(
  ctx: ApiCtx,
  principalId: string,
  memory: VoiceMemory,
  call: VoiceCall,
  state: ServerToolState,
): Promise<VoiceToolResult> {
  const { deps } = ctx;
  try {
    if (call.name === "remember") {
      if (state.read)
        return { content: "remember is unavailable after reading conversations in this turn", isError: true };
      const facts = parseFacts(call.args);
      if (!facts)
        return {
          content: `facts must be 1-${VOICE_MAX_FACTS} non-empty strings of at most ${VOICE_FACT_MAX_CHARS} characters`,
          isError: true,
        };
      const added = await memory.memory.capture(memory.write, facts, Date.now(), principalId, {
        mode: "explicit",
        actorId: principalId,
      });
      audit(deps, { principalId, action: "memory.voice.capture", resource: "memory", scopeLabel: memory.write });
      return { content: `saved ${added}`, ...(added > 0 ? { activity: { kind: "memory_saved" } } : {}) };
    }
    if (state.compacted) return { content: "already compacted in this turn" };
    if (deps.budget && !(await deps.budget.check(principalId)).allowed)
      return { content: "over budget", isError: true };
    state.compacted = true;
    const notebook = await memory.memory.read(memory.write);
    void deps.budget?.record(principalId, estimateCostUsd(countTokens(notebook)));
    await deps.memoryMaintain!(memory.write);
    audit(deps, { principalId, action: "memory.voice.compact", resource: "memory", scopeLabel: memory.write });
    return { content: "compacted", activity: { kind: "memory_compacted" } };
  } catch (err) {
    swallow(`voice: ${call.name}`, err);
    return { content: errMessage(err), isError: true };
  }
}

async function reply(ctx: ApiCtx): Promise<void> {
  const { deps, res, req } = ctx;
  const principalId = voicePrincipal(ctx, isObj(ctx.body) ? ctx.body.principalId : undefined);
  if (!principalId) return;
  if (!(await voiceEnabled(ctx, principalId))) return sendJson(res, 403, { error: "feature_disabled" });
  const request = parseVoiceReplyRequest(ctx.body);
  if (!request) return sendJson(res, 400, { error: "invalid_request" });
  const stream = deps.streamVoiceReply;
  if (!stream) return sendJson(res, 409, { error: "voice_model_unsupported" });
  const refused = await admitHop(ctx, principalId);
  if (refused) return sendJson(res, 429, { error: refused });
  const [candidates, memory] = await Promise.all([
    voiceCandidates(deps, principalId),
    voiceMemory(deps, principalId, request.purpose !== "announce").catch((err: unknown) => {
      swallow("voice: memory", err);
      return null;
    }),
  ]);
  const writesMemory = request.purpose === "reply" && !!memory?.capture;
  const tools = voiceTools(request, { capture: writesMemory, compact: writesMemory && !!memory?.compact });
  const offered = new Set(tools.map((tool) => tool.name));
  const systemPrompt = voiceSystemPrompt(request, memory?.recalled ?? "");
  const scope = scopeId("personal", principalId);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  res.on("close", abort);
  req.on("error", () => res.destroy());

  const openHop = async (messages: readonly HarnessVoiceMessage[]) => {
    const events = stream({
      candidates,
      systemPrompt,
      messages,
      tools,
      maxTokens: VOICE_MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const first = await events.next();
    if (first.done || first.value.type !== "start") {
      await events.return?.();
      return null;
    }
    const inputTokens = countTokens(systemPrompt) + countTokens(JSON.stringify(messages));
    void deps.budget?.record(principalId, estimateCostUsd(inputTokens));
    return { events, modelId: first.value.modelId, inputTokens, entryCount: messages.length };
  };

  let hop = await openHop(request.messages);
  if (!hop) {
    res.off("close", abort);
    return sendJson(res, 409, { error: "voice_model_unsupported" });
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (frame: unknown): void => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const lastMessage = request.messages.at(-1);
  const userRecorded =
    request.purpose === "reply" && lastMessage?.role === "user"
      ? recordTranscript(ctx, principalId, { role: "user", text: lastMessage.content })
      : undefined;
  let entryId = request.entry;
  let unattached: VoiceActivity[] = [];
  const written = async (markdown: string): Promise<void> => {
    const activity = unattached;
    const id = await recordTranscript(ctx, principalId, {
      role: "assistant",
      text: markdown,
      ...(activity.length ? { activity } : {}),
    });
    if (id) {
      entryId = id;
      unattached = [];
    }
    send({ type: "written", id: id ?? randomUUID(), markdown });
  };
  const noteActivity = async (activity: VoiceActivity): Promise<void> => {
    send({ type: "activity", activity });
    if (!entryId || !(await attachActivity(ctx, principalId, entryId, activity))) unattached.push(activity);
  };

  let messages: readonly HarnessVoiceMessage[] = request.messages;
  let end: VoiceEnd | undefined;
  let spoken = "";
  let wrote = false;
  let writtenThrough = 0;
  let acted = false;
  let actedInTurn = actedThisTurn(request);
  let checkedPromise = false;
  let question = "";
  const usage = { input: 0, output: 0 };
  const toolState: ServerToolState = { compacted: false, read: false };
  const opened = new Set<string>();
  let serverHops = 0;
  let lastHop = false;
  try {
    while (hop) {
      let text = "";
      const calls: VoiceCall[] = [];
      end = undefined;
      try {
        for (let next = await hop.events.next(); !next.done; next = await hop.events.next()) {
          const event = next.value;
          if (event.type === "delta") {
            const joined =
              !text && spoken && !/\s$/.test(spoken) && !/^\s/.test(event.text) ? ` ${event.text}` : event.text;
            text += joined;
            send({ type: "delta", text: joined });
          } else if (event.type === "text_end") send({ type: "text_end" });
          else if (event.type === "tool_call") calls.push(event);
          else if (event.type === "end") end = event;
        }
      } catch (err) {
        swallow("voice: reply stream", err);
      } finally {
        await hop.events.return?.();
      }
      deps.modelGateway?.recordCall({
        at: Date.now(),
        scopeLabel: scope,
        model: end?.modelId ?? hop.modelId,
        inputTokens: hop.inputTokens,
        entryCount: hop.entryCount,
      });
      await recordVoiceUsage(ctx, principalId, end);
      usage.input += end?.usage?.input ?? 0;
      usage.output += end?.usage?.output ?? 0;
      spoken += text;
      if (end?.outcome !== "done") break;
      const results: HarnessVoiceMessage[] = [];
      let serverRan = false;
      let hopForwarded = false;
      let hopWritten = "";
      const hopOpened: string[] = [];
      for (const call of calls) {
        const result = (content: string, isError?: true): void => {
          results.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content,
            ...(isError ? { isError } : {}),
          });
        };
        if (!offered.has(call.name)) {
          result("this tool is not available here", true);
          continue;
        }
        if (call.name === "write_message") {
          const markdown = typeof call.args.markdown === "string" ? call.args.markdown.trim() : "";
          if (!markdown || markdown.length > VOICE_WRITTEN_MAX_CHARS) {
            result(`markdown must be 1-${VOICE_WRITTEN_MAX_CHARS} characters`, true);
            continue;
          }
          await written(markdown);
          wrote = true;
          writtenThrough = spoken.length;
          hopWritten += `${markdown}\n`;
          result("shown");
          continue;
        }
        actedInTurn = true;
        if (call.name === "remember" || call.name === "compact_memory") {
          serverRan = true;
          const outcome = await runMemoryTool(ctx, principalId, memory!, call, toolState);
          result(outcome.content, outcome.isError);
          if (outcome.activity) await noteActivity(outcome.activity);
        } else if (isReadTool(call.name)) {
          serverRan = true;
          toolState.read = true;
          const outcome = await runReadTool(ctx, principalId, call);
          result(outcome.content, outcome.isError);
          if (call.name === "read_conversation") hopOpened.push(...(outcome.conversations ?? []));
        } else if (toolState.read && ACTS_ON_READ.has(call.name)) {
          serverRan = true;
          result(JSON.stringify({ ok: false, error: "ask_user_first" }), true);
        } else {
          send({ type: "tool_call", id: call.id, name: call.name, args: call.args });
          hopForwarded = true;
          if (call.name !== "ask_user") acted = true;
          else if (typeof call.args.question === "string") question = call.args.question.trim();
        }
      }
      const promiseUnkept =
        !serverRan && !actedInTurn && !checkedPromise && tools.length > 0 && announcesAction(`${text}\n${hopWritten}`);
      if (promiseUnkept) checkedPromise = true;
      if (lastHop || hopForwarded || (!serverRan && !promiseUnkept)) break;
      if (serverRan) serverHops++;
      lastHop = serverHops >= VOICE_MAX_SERVER_HOPS;
      if (controller.signal.aborted || (await admitHop(ctx, principalId))) break;
      for (const id of hopOpened) opened.add(id);
      messages = [
        ...messages,
        {
          role: "assistant",
          content: text.trim(),
          ...(calls.length ? { toolCalls: calls.map(({ id, name, args }) => ({ id, name, args })) } : {}),
        },
        ...results,
        ...(promiseUnkept ? [voiceNotice(request.language, "promiseCheck")] : []),
        ...(lastHop ? [voiceNotice(request.language, "answerNow")] : []),
      ];
      hop = await openHop(messages);
      if (!hop) end = undefined;
    }
    const read = conversationsRead(opened);
    if (read) await noteActivity(read);
    const fallback = wrote ? spoken.slice(writtenThrough).trim() : unsaid(spoken, request.messages) || question;
    if (end?.outcome === "done" && request.purpose !== "announce" && !acted && fallback) await written(fallback);
    if (unattached.length) await written("");
    if (!end || end.outcome === "error") send({ type: "error", reason: "upstream_error" });
    else if (end.outcome === "aborted") send({ type: "error", reason: "aborted" });
    else send({ type: "done", model: end.modelId, ...(end.usage ? { usage } : {}) });
    await userRecorded;
    res.end();
  } finally {
    res.off("close", abort);
  }
}

function conversationsRead(ids: ReadonlySet<string>): VoiceActivity | null {
  if (!ids.size) return null;
  const [only] = ids;
  return { kind: "conversations_read", count: ids.size, ...(ids.size === 1 && only ? { taskRef: only } : {}) };
}

async function recordVoiceUsage(ctx: ApiCtx, principalId: string, end: VoiceEnd | undefined): Promise<void> {
  const sessions = ctx.deps.sessions;
  if (!sessions || !end?.usage) return;
  const scope = scopeId("personal", principalId);
  try {
    const session = await sessions.getOrCreateByThread(voiceUsageThread(principalId), "dm", scope, undefined, "web");
    await sessions.recordLlmRequest(session.id, {
      turnSeq: null,
      step: 0,
      model: end.modelId,
      scopeLabel: scope,
      truncated: false,
      ttftMs: end.ttftMs,
      durationMs: end.durationMs,
      usage: end.usage,
    });
  } catch (err) {
    swallow("voice: record usage", err);
  }
}

export const voiceRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/voice/access", auth: "source", handle: access },
  { method: "GET", path: "/v1/voice/transcript", auth: "source", handle: transcript },
  { method: "POST", path: "/v1/voice/transcript", auth: "source", handle: appendTranscript },
  { method: "POST", path: "/v1/voice/transcript/activity", auth: "source", handle: updateActivity },
  { method: "POST", path: "/v1/voice/reply", auth: "source", handle: reply },
];
