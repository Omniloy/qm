import { errMessage, swallow } from "../../../chassis/src/errors.ts";
import {
  abortRunById,
  activeRunForThread,
  api,
  entriesToMessages,
  fetchSessionApprovals,
  fetchTranscript,
  mintSendKey,
  resolveApproval,
  signalRun,
  type CoreSession,
} from "../core-bridge.ts";
import { mainConversation, onSessionState, onSessionStateResync } from "../conversations.ts";
import { appState } from "../shell-state.ts";
import { openSession, refreshSessions, sessionTitle, sessionsState } from "../sessions.ts";
import { createAnnouncer, fallbackAnnouncement, type Announcement, type Announcer } from "./announcer.ts";
import { playChime } from "./audio/chimes.ts";
import { createAudioGraph, type AudioGraph } from "./audio/graph.ts";
import { createVoiceController, voiceCopy, type Port, type VoiceController } from "./controller.ts";
import { parseVoiceTranscript, streamVoiceReply } from "./llm.ts";
import {
  detectGpu,
  downloadVoiceModels,
  effectiveVoiceSettings,
  fallBackFrom,
  forgetVoiceAccess,
  voiceAccess,
  voiceModelFiles,
} from "./model-plan.ts";
import { missingModelFiles } from "./model-cache.ts";
import {
  DEFAULT_VAD_OPTIONS,
  DEFAULT_VOICE_ORG_CONFIG,
  VOICE_CHANNEL_NAME,
  VOICE_MAX_RUNNING_TASKS,
  modelFileKey,
  unavailableModelKey,
  type AsrEngineId,
  type ModelFile,
  type PlaybackWorkletIn,
  type PlaybackWorkletOut,
  type SpeechWorkerIn,
  type SpeechWorkerOut,
  type TtsEngineId,
  type TtsWorkerIn,
  type TtsWorkerOut,
  type VoiceAccess,
  type VoiceActivity,
  type VoicePreferences,
  type VoiceSettings,
  type VoiceStageView,
  type VoiceTaskSummary,
  type VoiceTranscriptEntry,
} from "./protocol.ts";
import {
  currentVoicePreferences,
  onVoiceSettingsChange,
  saveVoiceSettings,
  storeVoiceMuted,
  storedVoiceMuted,
} from "./settings-store.ts";
import {
  isVoiceThread,
  leadingApproval,
  runVoiceTool,
  taskSummaries,
  type TaskTail,
  type VoiceToolDeps,
} from "./tools.ts";
import { languageForVoice, pickerVoices } from "./voice-picker.ts";
import { handlesSpace, mountVoiceStage, type VoiceStage } from "./voice-stage.ts";
import { onFirstActivation } from "./activation.ts";
import { asrVariantFor } from "./asr/models.ts";
import { ttsEngineFiles, ttsFilesFor } from "./tts/models.ts";

export { deleteVoiceModels } from "./model-cache.ts";
export { downloadVoiceModels, voiceModelStatus } from "./model-plan.ts";

export interface VoiceMountOptions {
  autoStart: boolean;
  onActiveChange(active: boolean): void;
  openView(view: "chats" | "memory"): void;
}

interface Session {
  abort: AbortController;
  controller: VoiceController;
  announcer: Announcer;
  graph: AudioGraph;
  workers: Worker[];
  release: Array<() => void>;
}

type LockManager = {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<void>;
};

const WORKER_GRACE_MS = 1_000;

let host: HTMLElement | null = null;
let stage: VoiceStage | null = null;
let channel: BroadcastChannel | null = null;
let options: VoiceMountOptions | null = null;
let session: Session | null = null;
let starting: AbortController | null = null;
let stopSettings: (() => void) | null = null;
let releaseLock: (() => void) | null = null;
let idleView: VoiceStageView | null = null;
let access: VoiceAccess = { gatedModels: true, config: { ...DEFAULT_VOICE_ORG_CONFIG } };
let transcript: readonly VoiceTranscriptEntry[] = [];
let spaceDown = false;

function runtimeSettings(): VoiceSettings {
  return effectiveVoiceSettings(currentVoicePreferences(), access);
}

const NO_MICROPHONE: Port<SpeechWorkerIn, SpeechWorkerOut> = {
  post: () => undefined,
  listen: () => () => undefined,
};

function offView(status = ""): VoiceStageView {
  const settings = runtimeSettings();
  return {
    state: "off",
    language: settings.language,
    voice: settings.voice,
    voices: pickerVoices(settings),
    micMode: settings.micMode,
    pttStyle: settings.pttStyle,
    pttActive: false,
    muted: storedVoiceMuted(),
    status,
    captions: { user: null, agent: null },
    transcript,
    awaitingUser: false,
    announcement: "",
    work: null,
  };
}

function showIdle(status = ""): void {
  idleView = offView(status);
  stage?.update(idleView);
}

function workerPort<In, Out>(worker: Worker): Port<In, Out> {
  return {
    post: (message, transfer = []) => worker.postMessage(message, { transfer }),
    listen(handler) {
      const listener = (event: MessageEvent<Out>) => handler(event.data);
      worker.addEventListener("message", listener);
      return () => worker.removeEventListener("message", listener);
    },
  };
}

function nodePort(node: AudioWorkletNode): Port<PlaybackWorkletIn, PlaybackWorkletOut> {
  return {
    post: (message, transfer = []) => node.port.postMessage(message, transfer),
    listen(handler) {
      const listener = (event: MessageEvent<PlaybackWorkletOut>) => handler(event.data);
      node.port.addEventListener("message", listener);
      node.port.start();
      return () => node.port.removeEventListener("message", listener);
    },
  };
}

function locks(): LockManager | null {
  return (navigator as Navigator & { locks?: LockManager }).locks ?? null;
}

function acquireLeadership(takeover: boolean): Promise<(() => void) | null> {
  const manager = locks();
  if (!manager) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    void manager
      .request(VOICE_CHANNEL_NAME, takeover ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(null));
  });
}

async function microphoneGranted(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted";
  } catch {
    return false;
  }
}

function dropLeadership(): void {
  releaseLock?.();
  releaseLock = null;
}

async function sessionsNow(): Promise<CoreSession[]> {
  await refreshSessions({ silent: true }).catch((error: unknown) => swallow("voice: refresh sessions", error));
  return sessionsState.list;
}

async function taskTail(sessionId: string): Promise<TaskTail> {
  const page = await fetchTranscript(sessionId, { tailTurns: 1 });
  const messages = entriesToMessages(page.entries);
  const last = messages.findLast((message) => message.role === "assistant") as
    { content?: unknown; stopReason?: string } | undefined;
  const parts = Array.isArray(last?.content) ? (last.content as Array<{ type?: string; text?: string }>) : [];
  return {
    title: page.session ? sessionTitle(page.session) : null,
    reply: parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim(),
    failed: last?.stopReason === "error",
  };
}

function openTask(session: CoreSession): void {
  stage?.close();
  void openSession(session);
}

async function openTaskRef(taskRef: string): Promise<void> {
  const known = (list: readonly CoreSession[]) =>
    list.find((candidate) => candidate.threadRef === taskRef || candidate.id === taskRef);
  const found =
    known(sessionsState.list) ??
    known(await sessionsNow()) ??
    (await fetchTranscript(taskRef, { tailTurns: 1 }).then(
      (page) => page.session,
      () => undefined,
    ));
  if (found) openTask(found);
  else session?.controller.taskUnavailable();
}

function openActivity(activity: VoiceActivity): void {
  if (activity.taskRef) {
    void openTaskRef(activity.taskRef).catch((error: unknown) => swallow("voice: open task", error));
    return;
  }
  stage?.close();
  options?.openView(activity.kind === "conversations_read" ? "chats" : "memory");
}

function tasksChanged(): void {
  session?.controller.tasksChanged();
}

function refreshTranscript(): void {
  void api<{ entries?: unknown }>("/api/voice/transcript").then(
    (body) => {
      transcript = parseVoiceTranscript(body.entries);
      if (session) session.controller.setTranscript(transcript);
      else if (idleView) showIdle(idleView.status);
    },
    (error: unknown) => swallow("voice: transcript", error),
  );
}

async function ensureVoiceFiles(chosen: VoicePreferences): Promise<void> {
  const settings = effectiveVoiceSettings(chosen, access);
  await downloadVoiceModels(ttsFilesFor(settings.ttsEngine, settings.voice), () => undefined).catch((error: unknown) =>
    swallow("voice: download voice", error),
  );
}

async function saveSettings(patch: Partial<VoicePreferences>): Promise<VoiceSettings> {
  const saved = await saveVoiceSettings(patch, (next) => (session ? ensureVoiceFiles(next) : Promise.resolve()));
  return effectiveVoiceSettings(saved, access);
}

function changeVoiceSettings(patch: Partial<VoicePreferences>): void {
  void saveSettings(patch).catch((error: unknown) => swallow("voice: save settings", error));
}

function voiceButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".qm-voice-orb-button, .voice-toggle") !== null;
}

function pttKey(e: KeyboardEvent): boolean {
  if (e.code !== "Space" || session === null || runtimeSettings().micMode !== "push") return false;
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return false;
  return voiceButton(e.target) || !handlesSpace(e.target);
}

function onPttKeydown(e: KeyboardEvent): void {
  if (!pttKey(e) || (e.repeat && !spaceDown)) return;
  e.preventDefault();
  if (e.repeat) return;
  spaceDown = true;
  if (runtimeSettings().pttStyle === "hold") session?.controller.pttDown();
  else session?.controller.pttToggle();
}

function onPttKeyup(e: KeyboardEvent): void {
  if (e.code !== "Space" || !spaceDown) return;
  spaceDown = false;
  e.preventDefault();
  if (runtimeSettings().pttStyle === "hold") session?.controller.pttUp();
}

function releasePtt(): void {
  spaceDown = false;
  session?.controller.pttUp();
}

function onVisibility(): void {
  if (document.visibilityState === "hidden") releasePtt();
}

function startingTasks(user: string): ReadonlyMap<string, VoiceTaskSummary["state"]> {
  return new Map([...(session?.announcer.states() ?? [])].filter(([threadRef]) => isVoiceThread(user, threadRef)));
}

function toolDeps(user: string, titles: Map<string, string>): VoiceToolDeps {
  return {
    user,
    settings: runtimeSettings,
    saveSettings,
    sessions: sessionsNow,
    titles,
    startingTasks: () => startingTasks(user),
    startTurn: (body) =>
      api<{ runId?: string; status?: string; steered?: boolean }>("/api/turn", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    tail: taskTail,
    approvals: async (sessionId) => (await fetchSessionApprovals(sessionId))?.approvals ?? [],
    resolveApproval: (decision) => resolveApproval(decision),
    activeRun: async (threadRef) => (await activeRunForThread(threadRef)).runId,
    abortRun: abortRunById,
    steer: (runId, queuedRunId, threadRef, text) => signalRun(runId, "steer", text, { threadRef }, queuedRunId),
    open: openTask,
    delegated: (threadRef, title) => {
      titles.set(threadRef, title);
      void refreshSessions({ silent: true })
        .catch((error: unknown) => swallow("voice: refresh sessions", error))
        .finally(tasksChanged);
    },
    newId: mintSendKey,
  };
}

function notifyHidden(announcement: Announcement): void {
  if (document.visibilityState !== "hidden" || typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const note = new Notification(announcement.title || announcement.text, {
      body: announcement.text,
      tag: `qm-voice:${announcement.threadRef}`,
    });
    note.onclick = () => {
      window.focus();
      const target = sessionsState.list.find((s) => s.threadRef === announcement.threadRef);
      if (target) void openSession(target);
      note.close();
    };
  } catch (error) {
    swallow("voice: notification", error);
  }
}

function foregroundThread(): string | null {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return null;
  return appState.currentView === "chats" ? mainConversation().state.threadRef : null;
}

function teardown(current: Session): void {
  transcript = current.controller.transcript;
  current.abort.abort();
  current.controller.dispose();
  current.announcer.dispose();
  for (const release of current.release) release();
  for (const worker of current.workers) {
    worker.postMessage({ type: "dispose" });
    setTimeout(() => worker.terminate(), WORKER_GRACE_MS);
  }
  void current.graph.close();
}

function failedDownload(
  error: unknown,
  files: readonly ModelFile[],
  settings: VoiceSettings,
): AsrEngineId | TtsEngineId | null {
  const key = unavailableModelKey(errMessage(error));
  const file = files.find((candidate) => modelFileKey(candidate) === key);
  if (!file) return null;
  return file.role === "asr" ? settings.asrEngine : settings.ttsEngine;
}

function restartVoice(): void {
  stopVoice();
  void startVoice(true);
}

export function stopVoice(status = ""): void {
  starting?.abort();
  starting = null;
  const current = session;
  session = null;
  if (current) teardown(current);
  dropLeadership();
  showIdle(status);
  if (status) stage?.open();
  options?.onActiveChange(false);
}

export async function startVoice(takeover = true): Promise<void> {
  if (session || starting || !stage) return;
  const user = appState.me?.user;
  if (!user) return;
  const abort = new AbortController();
  starting = abort;
  const copy = () => voiceCopy(currentVoicePreferences().language);
  let graph: AudioGraph | null = null;
  const workers: Worker[] = [];
  let files: readonly ModelFile[] = [];
  let settings = runtimeSettings();
  try {
    forgetVoiceAccess();
    const [gpu, fetched] = await Promise.all([detectGpu(), voiceAccess()]);
    if (abort.signal.aborted) return;
    access = fetched;
    if (!gpu.webgpu) {
      if (takeover) stage.open();
      showIdle(copy().webgpu);
      starting = null;
      return;
    }
    settings = runtimeSettings();
    const { asrEngine } = settings;
    const microphone = settings.micMode !== "off";
    files = voiceModelFiles(gpu, settings);
    const quiet =
      !takeover && ((await missingModelFiles(files)).length > 0 || (microphone && !(await microphoneGranted())));
    if (abort.signal.aborted) return;
    if (quiet) {
      starting = null;
      return;
    }
    if (takeover) channel?.postMessage({ type: "takeover" });
    const release = await acquireLeadership(takeover);
    if (!release || abort.signal.aborted) {
      release?.();
      if (starting === abort) starting = null;
      return;
    }
    releaseLock = release;
    graph = await createAudioGraph(microphone, () => session?.controller.microphoneChanged());
    if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
    const audio = graph;
    const speechWorker = microphone
      ? new Worker(new URL("./speech.worker.ts", import.meta.url), { type: "module", name: "qm-voice-speech" })
      : null;
    const ttsWorker = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module", name: "qm-voice-tts" });
    if (speechWorker) workers.push(speechWorker);
    workers.push(ttsWorker);
    const speech = speechWorker ? workerPort<SpeechWorkerIn, SpeechWorkerOut>(speechWorker) : NO_MICROPHONE;
    const tts = workerPort<TtsWorkerIn, TtsWorkerOut>(ttsWorker);
    const titles = new Map<string, string>();
    const deps = toolDeps(user, titles);
    const controller = createVoiceController({
      speech,
      tts,
      playback: nodePort(audio.playback),
      settings: runtimeSettings,
      reply: streamVoiceReply,
      persist: (entries) =>
        api("/api/voice/transcript", { method: "POST", body: JSON.stringify({ entries }) }).then(
          () => undefined,
          (error: unknown) => swallow("voice: persist transcript", error),
        ),
      attachActivity: (entryId, activity) =>
        api("/api/voice/transcript/activity", { method: "POST", body: JSON.stringify({ entryId, activity }) }).then(
          () => undefined,
        ),
      runTool: (call) => runVoiceTool(call, deps),
      runningTasks: () => taskSummaries(sessionsState.list, titles, startingTasks(user)),
      backgroundTasks: () =>
        taskSummaries(sessionsState.list, titles, startingTasks(user), Number.POSITIVE_INFINITY)
          .filter(
            (task) =>
              task.state !== "idle" &&
              (isVoiceThread(user, task.taskRef) ||
                (runtimeSettings().announceScope === "all" && task.state === "held")),
          )
          .slice(0, VOICE_MAX_RUNNING_TASKS),
      chime: (kind) => playChime(audio.context, audio.output, kind),
      setMuted: (muted) => audio.setMuted(muted),
      microphone: () => audio.microphone(),
      reconnectMicrophone: () => audio.reconnectMicrophone(),
      onStalled: restartVoice,
      onMutedChange: storeVoiceMuted,
      muted: storedVoiceMuted(),
      transcript,
      render: (view) => stage?.update(view),
      onFatal: (message, stage) => {
        if (stage && fallBackFrom(stage === "asr" ? settings.asrEngine : settings.ttsEngine)) restartVoice();
        else stopVoice(message);
      },
    });
    const announcer = createAnnouncer({
      scope: () => runtimeSettings().announceScope,
      language: () => currentVoicePreferences().language,
      isVoiceThread: (threadRef) => isVoiceThread(user, threadRef),
      foregroundThread,
      sessions: sessionsNow,
      tail: taskTail,
      pendingApproval: async (sessionId) => leadingApproval((await fetchSessionApprovals(sessionId))?.approvals ?? []),
      summarize: streamVoiceReply,
      review: (update) => {
        notifyHidden({
          threadRef: update.taskRef,
          kind: update.kind,
          title: update.title,
          text: fallbackAnnouncement(update.kind, update.title, currentVoicePreferences().language),
          detail: update.detail,
        });
        return controller.review(update);
      },
      title: (threadRef) => titles.get(threadRef),
      deliver: (announcement) => {
        notifyHidden(announcement);
        controller.announce(announcement.text, announcement.written);
      },
    });
    session = {
      abort,
      controller,
      announcer,
      graph: audio,
      workers,
      release: [
        onSessionState((event) => {
          announcer.handle(event);
          queueMicrotask(tasksChanged);
        }),
        onSessionStateResync(
          () =>
            void announcer
              .resync()
              .catch((e: unknown) => swallow("voice: resync", e))
              .finally(tasksChanged),
        ),
        onVoiceSettingsChange((next) => {
          const effective = effectiveVoiceSettings(next, access);
          if (
            effective.ttsEngine !== settings.ttsEngine ||
            effective.asrEngine !== settings.asrEngine ||
            (effective.micMode === "off") !== !microphone
          ) {
            restartVoice();
            return;
          }
          controller.applySettings();
          void ensureVoiceFiles(next);
        }),
      ],
    };
    starting = null;
    options?.onActiveChange(true);
    controller.setStatus(copy().downloading(0));
    await downloadVoiceModels(
      files,
      (fraction) => controller.setStatus(copy().downloading(Math.floor(fraction * 100))),
      abort.signal,
    );
    if (session?.controller !== controller) return;
    if (audio.framePort)
      speech.post(
        {
          type: "init",
          framePort: audio.framePort,
          asrEngine,
          asrVariant: asrVariantFor(asrEngine, gpu),
          asrFiles: files.filter((file) => file.role === "asr"),
          language: runtimeSettings().language,
          vad: { ...DEFAULT_VAD_OPTIONS },
        },
        [audio.framePort],
      );
    tts.post({
      type: "init",
      engine: settings.ttsEngine,
      files: ttsEngineFiles(settings.ttsEngine),
      backend: "webgpu",
    });
    await announcer.start();
  } catch (error) {
    const aborted = abort.signal.aborted || (error as { name?: unknown } | null)?.name === "AbortError";
    if (!session) {
      for (const worker of workers) worker.terminate();
      if (graph) void graph.close();
      dropLeadership();
    }
    if (starting === abort) starting = null;
    if (aborted) return;
    swallow("voice: start", error);
    const engine = failedDownload(error, files, settings);
    if (engine && fallBackFrom(engine)) {
      restartVoice();
      return;
    }
    const message = error instanceof Error && error.message === "voice_storage_full" ? copy().storage : copy().fatal;
    stopVoice(message);
  }
}

export function voiceActive(): boolean {
  return session !== null || starting !== null;
}

export async function toggleVoice(): Promise<void> {
  if (voiceActive()) {
    stopVoice();
    return;
  }
  stage?.open();
  await startVoice(true);
}

export function openVoiceStage(): void {
  stage?.open();
}

export async function mountVoiceAssistant(mount: VoiceMountOptions): Promise<void> {
  options = mount;
  if (host) return;
  host = document.createElement("div");
  host.className = "voice-root";
  document.body.append(host);
  stage = mountVoiceStage(host, {
    onOrbPress: () => {
      if (session) session.controller.press();
      else void startVoice(true);
    },
    onToggleMute: () => {
      if (session) {
        session.controller.toggleMute();
        return;
      }
      storeVoiceMuted(!storedVoiceMuted());
      showIdle(idleView?.status ?? "");
    },
    onPttDown: () => {
      if (session) session.controller.pttDown();
      else void startVoice(true);
    },
    onPttUp: () => session?.controller.pttUp(),
    onOpenTask: (taskRef) => void openTaskRef(taskRef).catch((error: unknown) => swallow("voice: open task", error)),
    onOpenActivity: openActivity,
    onTypeInstead: (text) => session?.controller.type(text),
    onLanguage: (language) => changeVoiceSettings({ language }),
    onVoice: (voice) => changeVoiceSettings({ voice, language: languageForVoice(runtimeSettings(), voice) }),
    onMicMode: (micMode) => changeVoiceSettings({ micMode }),
    onOpen: refreshTranscript,
    onClose: () => undefined,
  });
  showIdle();
  void voiceAccess().then((fetched) => {
    access = fetched;
    if (!session && idleView) showIdle(idleView.status);
  });
  document.addEventListener("keydown", onPttKeydown);
  document.addEventListener("keyup", onPttKeyup);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", releasePtt);
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(VOICE_CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "takeover" && voiceActive()) stopVoice();
    };
  }
  stopSettings = onVoiceSettingsChange(() => {
    if (!session && idleView) showIdle(idleView.status);
  });
  if (mount.autoStart)
    onFirstActivation(() => {
      if (stage) void startVoice(false);
    });
}

export function unmountVoiceAssistant(): void {
  if (!host) return;
  stopVoice();
  document.removeEventListener("keydown", onPttKeydown);
  document.removeEventListener("keyup", onPttKeyup);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("blur", releasePtt);
  stopSettings?.();
  stopSettings = null;
  channel?.close();
  channel = null;
  stage?.destroy();
  stage = null;
  host.remove();
  host = null;
  options = null;
  idleView = null;
}
