import { Type } from "typebox";
import type { HarnessVoiceCandidate, HarnessVoiceMessage, HarnessVoiceTool } from "../harness/harness.ts";
import { codexProviderModelId, codexSubscriptionModelId, resolveModel, voiceModelFor } from "../model/pi-models.ts";
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
  "set_language",
  "set_voice",
] as const;
const TASK_STATES = ["working", "awaiting_approval", "idle"] as const;
const VOICE_GENDERS = ["female", "male"] as const;

const VOICE_MAX_MESSAGES = 32;
const VOICE_MAX_CONTENT_CHARS = 4_000;
const VOICE_MAX_RUNNING_TASKS = 20;
export const VOICE_MAX_OUTPUT_TOKENS = 300;
const MAX_REF_CHARS = 512;
const MAX_TOOL_ARGS_CHARS = 8_000;
const MAX_VOICES = 32;
const MAX_VOICE_LABEL_CHARS = 60;
const VOICE_ID = /^[A-Za-z0-9_.-]{1,32}$/;

type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];
type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

interface VoiceTaskSummary {
  taskRef: string;
  title: string;
  state: (typeof TASK_STATES)[number];
}

interface VoiceOption {
  id: string;
  label: string;
  gender: (typeof VOICE_GENDERS)[number];
}

export interface VoiceReplyRequest {
  purpose: (typeof VOICE_REPLY_PURPOSES)[number];
  language: VoiceLanguage;
  messages: HarnessVoiceMessage[];
  tools: boolean;
  runningTasks: VoiceTaskSummary[];
  voices: VoiceOption[];
  voice: string | null;
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

function parseVoiceOption(value: unknown): VoiceOption | null {
  if (!isRecord(value) || typeof value.id !== "string" || !VOICE_ID.test(value.id)) return null;
  if (!boundedText(value.label, MAX_VOICE_LABEL_CHARS) || !value.label.trim()) return null;
  return oneOf(VOICE_GENDERS, value.gender) ? { id: value.id, label: value.label, gender: value.gender } : null;
}

function parseVoices(context: Record<string, unknown>): { voices: VoiceOption[]; voice: string | null } | null {
  const raw = context.voices ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_VOICES) return null;
  const voices = raw.map(parseVoiceOption);
  if (voices.some((voice) => voice === null)) return null;
  const options = voices as VoiceOption[];
  if (new Set(options.map((voice) => voice.id)).size !== options.length) return null;
  if (context.voice === undefined) return { voices: options, voice: null };
  if (!options.some((voice) => voice.id === context.voice)) return null;
  return { voices: options, voice: context.voice as string };
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
  const voices = parseVoices(context);
  if (!voices) return null;
  return {
    purpose: body.purpose,
    language: body.language,
    messages: messages as HarnessVoiceMessage[],
    tools: body.tools === true && body.purpose === "reply",
    runningTasks: runningTasks as VoiceTaskSummary[],
    ...voices,
  };
}

const TASK_REF = Type.Object({
  taskRef: Type.String({ description: "The taskRef of a task from the running task list." }),
});

const BASE_TOOLS: readonly HarnessVoiceTool[] = [
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
  {
    name: "set_language",
    description: "Switch the language you listen and speak in. The app confirms out loud in the new language.",
    parameters: Type.Object({ language: Type.Union(VOICE_LANGUAGES.map((language) => Type.Literal(language))) }),
  },
];

function setVoiceTool(voices: readonly VoiceOption[]): HarnessVoiceTool {
  return {
    name: "set_voice",
    description:
      "Change the voice you speak with. Pass exactly one of: voice (an id from the voice list), gender, or next to move to the next voice. The app confirms out loud in the new voice.",
    parameters: Type.Object({
      voice: Type.Optional(Type.Union(voices.map((voice) => Type.Literal(voice.id)))),
      gender: Type.Optional(Type.Union(VOICE_GENDERS.map((gender) => Type.Literal(gender)))),
      next: Type.Optional(Type.Literal(true)),
    }),
  };
}

export function voiceTools(request: VoiceReplyRequest): readonly HarnessVoiceTool[] {
  if (!request.tools) return [];
  return request.voices.length ? [...BASE_TOOLS, setVoiceTool(request.voices)] : BASE_TOOLS;
}

const PROMPTS: Record<
  VoiceLanguage,
  {
    reply: string;
    tools: string;
    noTools: string;
    announce: string;
    tasks: string;
    noTasks: string;
    voices: (current: string) => string;
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
      "Gestiona las tareas con task_result, approve_task, reject_task, stop_task y open_task. El taskRef sale siempre de la lista de tareas.",
      "La lista de tareas de abajo está al día: responde con ella a las preguntas sobre su estado. Usa check_tasks solo si necesitas algo que no está en la lista, y task_result para leer un resultado completo.",
      "Si el usuario pide hablar en otro idioma, usa set_language. Si pide otra voz, usa set_voice con voice, gender o next. Al llamar a set_language o set_voice no escribas nada: la app lo confirma.",
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
    voices: (current) => `Voces (actual: ${current}):`,
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
      "Manage tasks with task_result, approve_task, reject_task, stop_task and open_task. The taskRef always comes from the task list.",
      "The task list below is current: answer questions about task status from it. Call check_tasks only when you need something the list does not have, and task_result to read a full result.",
      "If the user asks to speak another language, call set_language. If they ask for another voice, call set_voice with voice, gender or next. When you call set_language or set_voice, write nothing: the app confirms it.",
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
    voices: (current) => `Voices (current: ${current}):`,
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
  const sections = [copy.reply, request.tools ? copy.tools : copy.noTools, tasks];
  if (request.tools && request.voices.length) {
    const current = request.voices.find((voice) => voice.id === request.voice)?.id ?? "-";
    sections.push(
      `${copy.voices(current)} ${request.voices.map((voice) => `${voice.id}=${JSON.stringify(voice.label)}`).join(", ")}`,
    );
  }
  return sections.join("\n\n");
}

function withSubscriptionTwin(candidate: HarnessVoiceCandidate): HarnessVoiceCandidate[] {
  if (resolveModel(candidate.modelId)?.provider !== "openai") return [candidate];
  return [candidate, { ...candidate, modelId: codexSubscriptionModelId(candidate.modelId) }];
}

export async function voiceCandidates(deps: RuntimeDeps, actorId: string): Promise<HarnessVoiceCandidate[]> {
  const { effective } = await userRuntimeConfigBody({ deps }, scopeId("personal", actorId), actorId);
  const voiceModel = voiceModelFor(effective.modelId);
  const preferred: HarnessVoiceCandidate[] = [
    ...(voiceModel && voiceModel !== effective.modelId ? [{ modelId: voiceModel, reasoning: "none" as const }] : []),
    { modelId: effective.modelId, reasoning: voiceModel === effective.modelId ? "none" : "lowest" },
  ];
  const wanted = preferred.flatMap(withSubscriptionTwin);
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
    if (served.some((pick) => pick.modelId === auth.model)) continue;
    served.push({ modelId: auth.model, reasoning: candidate.reasoning, providerKeys: auth.providerKeys });
  }
  return served;
}
