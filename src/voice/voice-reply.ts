import { Type } from "typebox";
import type { HarnessVoiceCandidate, HarnessVoiceMessage, HarnessVoiceTool } from "../harness/harness.ts";
import { codexProviderModelId, voiceModelFor } from "../model/pi-models.ts";
import { loadPersonalModelAccess, piRoutingAuth, routePersonalModelAccess } from "../core/individual-auth-routing.ts";
import { userRuntimeConfigBody, type RuntimeDeps } from "../api/runtime-config.ts";
import { scopeId } from "../types.ts";

const VOICE_REPLY_PURPOSES = ["reply", "announce"] as const;
const VOICE_LANGUAGES = ["es", "en"] as const;
const VOICE_TOOL_NAMES = [
  "delegate_task",
  "check_tasks",
  "task_result",
  "approve_task",
  "reject_task",
  "stop_task",
  "open_task",
] as const;
const TASK_STATES = ["working", "awaiting_approval", "idle"] as const;

const VOICE_MAX_MESSAGES = 32;
const VOICE_MAX_CONTENT_CHARS = 4_000;
const VOICE_MAX_RUNNING_TASKS = 20;
export const VOICE_MAX_OUTPUT_TOKENS = 300;
const MAX_REF_CHARS = 512;
const MAX_TOOL_ARGS_CHARS = 8_000;

type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];
type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

interface VoiceTaskSummary {
  taskRef: string;
  title: string;
  state: (typeof TASK_STATES)[number];
}

export interface VoiceReplyRequest {
  purpose: (typeof VOICE_REPLY_PURPOSES)[number];
  language: VoiceLanguage;
  messages: HarnessVoiceMessage[];
  tools: boolean;
  runningTasks: VoiceTaskSummary[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const ref = (value: unknown): value is string => boundedText(value, MAX_REF_CHARS) && value.length > 0;

function parseToolCall(value: unknown): { id: string; name: VoiceToolName; args: Record<string, unknown> } | null {
  if (!isRecord(value) || !ref(value.id) || !oneOf(VOICE_TOOL_NAMES, value.name)) return null;
  const args = value.args ?? {};
  if (!isRecord(args) || JSON.stringify(args).length > MAX_TOOL_ARGS_CHARS) return null;
  return { id: value.id, name: value.name, args };
}

function parseMessage(value: unknown): HarnessVoiceMessage | null {
  if (!isRecord(value) || !boundedText(value.content, VOICE_MAX_CONTENT_CHARS)) return null;
  if (value.role === "user") return { role: "user", content: value.content };
  if (value.role === "tool") {
    if (!ref(value.toolCallId) || !oneOf(VOICE_TOOL_NAMES, value.name)) return null;
    if (value.isError !== undefined && typeof value.isError !== "boolean") return null;
    return {
      role: "tool",
      toolCallId: value.toolCallId,
      name: value.name,
      content: value.content,
      ...(value.isError ? { isError: true } : {}),
    };
  }
  if (value.role !== "assistant") return null;
  if (value.toolCalls === undefined) return { role: "assistant", content: value.content };
  if (!Array.isArray(value.toolCalls)) return null;
  const toolCalls = value.toolCalls.map(parseToolCall);
  if (toolCalls.some((call) => call === null)) return null;
  return {
    role: "assistant",
    content: value.content,
    toolCalls: toolCalls as NonNullable<(typeof toolCalls)[number]>[],
  };
}

function parseTask(value: unknown): VoiceTaskSummary | null {
  if (!isRecord(value) || !ref(value.taskRef) || !boundedText(value.title, MAX_REF_CHARS)) return null;
  return oneOf(TASK_STATES, value.state) ? { taskRef: value.taskRef, title: value.title, state: value.state } : null;
}

export function parseVoiceReplyRequest(body: unknown): VoiceReplyRequest | null {
  if (!isRecord(body)) return null;
  if (!oneOf(VOICE_REPLY_PURPOSES, body.purpose) || !oneOf(VOICE_LANGUAGES, body.language)) return null;
  if (body.tools !== undefined && typeof body.tools !== "boolean") return null;
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > VOICE_MAX_MESSAGES) return null;
  const messages = body.messages.map(parseMessage);
  if (messages.some((message) => message === null) || messages[0]?.role !== "user") return null;
  const context = body.context ?? {};
  if (!isRecord(context)) return null;
  const rawTasks = context.runningTasks ?? [];
  if (!Array.isArray(rawTasks) || rawTasks.length > VOICE_MAX_RUNNING_TASKS) return null;
  const runningTasks = rawTasks.map(parseTask);
  if (runningTasks.some((task) => task === null)) return null;
  return {
    purpose: body.purpose,
    language: body.language,
    messages: messages as HarnessVoiceMessage[],
    tools: body.tools === true && body.purpose === "reply",
    runningTasks: runningTasks as VoiceTaskSummary[],
  };
}

const TASK_REF = Type.Object({
  taskRef: Type.String({ description: "The taskRef of a task from the running task list." }),
});

export const VOICE_TOOLS: readonly HarnessVoiceTool[] = [
  {
    name: "delegate_task",
    description:
      "Start a new background task for the full agent. Use it for anything that needs real work: searching, writing, coding, reading mail or calendars, or acting in other systems.",
    parameters: Type.Object({
      instruction: Type.String({ description: "A complete, self-contained instruction for the agent." }),
      title: Type.String({ description: "A short title for the task, at most six words." }),
    }),
  },
  {
    name: "check_tasks",
    description: "List the user's current tasks and their state.",
    parameters: Type.Object({}),
  },
  { name: "task_result", description: "Read the latest result of a task.", parameters: TASK_REF },
  {
    name: "approve_task",
    description: "Approve the action a task is waiting on. The app reads it back and waits for the user's yes.",
    parameters: TASK_REF,
  },
  {
    name: "reject_task",
    description: "Reject the action a task is waiting on. The app reads it back and waits for the user's yes.",
    parameters: TASK_REF,
  },
  { name: "stop_task", description: "Stop a running task.", parameters: TASK_REF },
  { name: "open_task", description: "Open a task's conversation on screen.", parameters: TASK_REF },
];

const PROMPTS: Record<
  VoiceLanguage,
  {
    reply: string;
    tools: string;
    noTools: string;
    announce: string;
    tasks: string;
    noTasks: string;
    states: Record<VoiceTaskSummary["state"], string>;
  }
> = {
  es: {
    reply: [
      "Eres Omni, el asistente de voz de miniomni. Lo que escribes se convierte en audio y el usuario lo escucha.",
      "Responde siempre en español, con una o dos frases cortas y naturales, como en una conversación.",
      "No uses markdown, listas, emojis, enlaces ni bloques de código. Escribe los números y las siglas como se pronuncian.",
      "Si no entiendes lo que te piden, pide que lo repitan en pocas palabras.",
    ].join("\n"),
    tools: [
      "Para cualquier cosa que requiera trabajo real, como buscar, redactar, programar, leer el correo o actuar en otros sistemas, usa delegate_task con una instrucción completa y autosuficiente, y di en una frase que te pones con ello.",
      "Gestiona las tareas con check_tasks, task_result, approve_task, reject_task, stop_task y open_task. El taskRef sale siempre de la lista de tareas.",
      "No apruebes ni rechaces nada sin que el usuario lo haya pedido de forma explícita.",
    ].join("\n"),
    noTools: "Ahora no puedes iniciar ni gestionar tareas; responde solo con lo que sabes.",
    announce: [
      "Avisas en voz alta de que una tarea en segundo plano ha cambiado de estado.",
      "Escribe en español una o dos frases, como mucho 160 caracteres, sin markdown.",
      "Si terminó, empieza con «Listo:» y el título, y resume el resultado. Si espera aprobación, di que necesita la aprobación del usuario y para qué. Si falló, di que no se pudo terminar.",
    ].join("\n"),
    tasks: "Tareas del usuario:",
    noTasks: "El usuario no tiene tareas en curso.",
    states: { working: "en curso", awaiting_approval: "espera aprobación", idle: "terminada" },
  },
  en: {
    reply: [
      "You are Omni, the voice assistant of miniomni. What you write is turned into speech for the user to hear.",
      "Always answer in English, in one or two short, natural sentences, as in a conversation.",
      "Do not use markdown, lists, emojis, links or code blocks. Write numbers and acronyms the way they are spoken.",
      "If you do not understand the request, ask the user to repeat it in a few words.",
    ].join("\n"),
    tools: [
      "For anything that needs real work, such as searching, writing, coding, reading mail or acting in other systems, call delegate_task with a complete, self-contained instruction, and say in one sentence that you are on it.",
      "Manage tasks with check_tasks, task_result, approve_task, reject_task, stop_task and open_task. The taskRef always comes from the task list.",
      "Never approve or reject anything unless the user explicitly asked for it.",
    ].join("\n"),
    noTools: "You cannot start or manage tasks right now; answer only from what you know.",
    announce: [
      "You announce out loud that a background task changed state.",
      "Write one or two sentences in English, at most 160 characters, with no markdown.",
      "If it finished, start with “Done:” and the title, then summarise the result. If it awaits approval, say it needs the user's approval and what for. If it failed, say it could not be finished.",
    ].join("\n"),
    tasks: "The user's tasks:",
    noTasks: "The user has no running tasks.",
    states: { working: "running", awaiting_approval: "awaiting approval", idle: "finished" },
  },
};

export function voiceSystemPrompt(request: VoiceReplyRequest): string {
  const copy = PROMPTS[request.language];
  if (request.purpose === "announce") return copy.announce;
  const tasks = request.runningTasks.length
    ? [
        copy.tasks,
        ...request.runningTasks.map(
          (task) => `- ${JSON.stringify(task.title)} (${copy.states[task.state]}) taskRef=${task.taskRef}`,
        ),
      ].join("\n")
    : copy.noTasks;
  return [copy.reply, request.tools ? copy.tools : copy.noTools, tasks].join("\n\n");
}

export async function voiceCandidates(deps: RuntimeDeps, actorId: string): Promise<HarnessVoiceCandidate[]> {
  const { effective } = await userRuntimeConfigBody({ deps }, scopeId("personal", actorId), actorId);
  const voiceModel = voiceModelFor(effective.modelId);
  const wanted: HarnessVoiceCandidate[] = [
    ...(voiceModel && voiceModel !== effective.modelId ? [{ modelId: voiceModel, reasoning: "none" as const }] : []),
    { modelId: effective.modelId, reasoning: voiceModel === effective.modelId ? "none" : "lowest" },
  ];
  const store = deps.userModelCredentials;
  const account = store ? await deps.config?.getModelAccountDurable(actorId) : undefined;
  if (!store || !account || account === "company") return wanted;
  const access = await loadPersonalModelAccess(deps.config, store, actorId, account);
  const served: HarnessVoiceCandidate[] = [];
  for (const candidate of wanted) {
    const routing = routePersonalModelAccess(access, candidate.modelId, "pi");
    if (routing === "org") {
      served.push(candidate);
      continue;
    }
    const auth = await piRoutingAuth(routing, store, actorId);
    if (!auth?.model || codexProviderModelId(auth.model) !== codexProviderModelId(candidate.modelId)) continue;
    served.push({ modelId: auth.model, reasoning: candidate.reasoning, providerKeys: auth.providerKeys });
  }
  return served;
}
