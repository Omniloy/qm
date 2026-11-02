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
  type CoreSession,
} from "../core-bridge.ts";
import { mainConversation, onSessionState, onSessionStateResync } from "../conversations.ts";
import { appState } from "../shell-state.ts";
import { openSession, refreshSessions, sessionTitle, sessionsState } from "../sessions.ts";
import { createAnnouncer, type Announcement, type Announcer } from "./announcer.ts";
import { playChime } from "./audio/chimes.ts";
import { createAudioGraph, type AudioGraph } from "./audio/graph.ts";
import { createVoiceController, voiceCopy, type Port, type VoiceController } from "./controller.ts";
import { streamVoiceReply } from "./llm.ts";
import {
  detectGpu,
  downloadVoiceModels,
  effectiveVoiceSettings,
  fallBackFrom,
  gatedModelsAvailable,
  voiceModelFiles,
} from "./model-plan.ts";
import { missingModelFiles } from "./model-cache.ts";
import {
  DEFAULT_VAD_OPTIONS,
  VOICE_CHANNEL_NAME,
  modelFileKey,
  type AsrEngineId,
  type ModelFile,
  type PlaybackWorkletIn,
  type PlaybackWorkletOut,
  type SpeechWorkerIn,
  type SpeechWorkerOut,
  type TtsEngineId,
  type TtsWorkerIn,
  type TtsWorkerOut,
  type VoiceSettings,
  type VoiceStageView,
} from "./protocol.ts";
import {
  currentVoiceSettings,
  onVoiceSettingsChange,
  parseVoiceSettings,
  saveVoiceSettings,
  storeVoiceMuted,
  storedVoiceMuted,
} from "./settings-store.ts";
import { isVoiceThread, runVoiceTool, taskSummaries, type TaskTail, type VoiceToolDeps } from "./tools.ts";
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
let gatedModels = true;
let spaceDown = false;

function runtimeSettings(): VoiceSettings {
  return effectiveVoiceSettings(currentVoiceSettings(), gatedModels);
}

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
    announcement: "",
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

async function ensureVoiceFiles(chosen: VoiceSettings): Promise<void> {
  const settings = effectiveVoiceSettings(chosen, gatedModels);
  await downloadVoiceModels(ttsFilesFor(settings.ttsEngine, settings.voice), () => undefined).catch((error: unknown) =>
    swallow("voice: download voice", error),
  );
}

async function saveSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const pinned =
    patch.voice !== undefined && patch.ttsEngine === undefined
      ? { ttsEngine: runtimeSettings().ttsEngine, ...patch }
      : patch;
  if (session) await ensureVoiceFiles(parseVoiceSettings({ ...currentVoiceSettings(), ...pinned }));
  return saveVoiceSettings(pinned);
}

function changeVoiceSettings(patch: Partial<VoiceSettings>): void {
  void saveSettings(patch).catch((error: unknown) => swallow("voice: save settings", error));
}

function orbTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".qm-voice-orb-button") !== null;
}

function pttKey(e: KeyboardEvent): boolean {
  if (e.code !== "Space" || session === null || currentVoiceSettings().micMode !== "push") return false;
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return false;
  return orbTarget(e.target) || !handlesSpace(e.target);
}

function onPttKeydown(e: KeyboardEvent): void {
  if (!pttKey(e) || (e.repeat && !spaceDown)) return;
  e.preventDefault();
  if (e.repeat) return;
  spaceDown = true;
  if (currentVoiceSettings().pttStyle === "hold") session?.controller.pttDown();
  else session?.controller.pttToggle();
}

function onPttKeyup(e: KeyboardEvent): void {
  if (e.code !== "Space" || !spaceDown) return;
  spaceDown = false;
  e.preventDefault();
  if (currentVoiceSettings().pttStyle === "hold") session?.controller.pttUp();
}

function releasePtt(): void {
  spaceDown = false;
  session?.controller.pttUp();
}

function onVisibility(): void {
  if (document.visibilityState === "hidden") releasePtt();
}

function toolDeps(user: string, titles: Map<string, string>): VoiceToolDeps {
  return {
    user,
    settings: currentVoiceSettings,
    saveSettings,
    sessions: sessionsNow,
    startTurn: (body) =>
      api<{ runId?: string; status?: string }>("/api/turn", { method: "POST", body: JSON.stringify(body) }),
    tail: taskTail,
    approvals: async (sessionId) => (await fetchSessionApprovals(sessionId))?.approvals ?? [],
    resolveApproval: (decision) => resolveApproval(decision),
    activeRun: async (threadRef) => (await activeRunForThread(threadRef)).runId,
    abortRun: abortRunById,
    open: openTask,
    delegated: (threadRef, title) => {
      titles.set(threadRef, title);
      void refreshSessions({ silent: true }).catch((error: unknown) => swallow("voice: refresh sessions", error));
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
  const key = /^model_download_failed:(.+):\d+$/.exec(errMessage(error))?.[1];
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
  const copy = () => voiceCopy(currentVoiceSettings().language);
  let graph: AudioGraph | null = null;
  const workers: Worker[] = [];
  let files: readonly ModelFile[] = [];
  let settings = runtimeSettings();
  try {
    const [gpu, gated] = await Promise.all([detectGpu(), gatedModelsAvailable()]);
    if (abort.signal.aborted) return;
    gatedModels = gated;
    if (!gpu.webgpu) {
      if (takeover) stage.open();
      showIdle(copy().webgpu);
      starting = null;
      return;
    }
    settings = runtimeSettings();
    const { asrEngine } = settings;
    files = voiceModelFiles(gpu, settings);
    const quiet = !takeover && ((await missingModelFiles(files)).length > 0 || !(await microphoneGranted()));
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
    graph = await createAudioGraph();
    if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
    const audio = graph;
    const speechWorker = new Worker(new URL("./speech.worker.ts", import.meta.url), {
      type: "module",
      name: "qm-voice-speech",
    });
    const ttsWorker = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module", name: "qm-voice-tts" });
    workers.push(speechWorker, ttsWorker);
    const speech = workerPort<SpeechWorkerIn, SpeechWorkerOut>(speechWorker);
    const tts = workerPort<TtsWorkerIn, TtsWorkerOut>(ttsWorker);
    const titles = new Map<string, string>();
    const deps = toolDeps(user, titles);
    const controller = createVoiceController({
      speech,
      tts,
      playback: nodePort(audio.playback),
      settings: runtimeSettings,
      reply: streamVoiceReply,
      runTool: (call) => runVoiceTool(call, deps),
      runningTasks: () => taskSummaries(sessionsState.list, titles),
      chime: (kind) => playChime(audio.context, audio.output, kind),
      setMuted: (muted) => audio.setMuted(muted),
      onMutedChange: storeVoiceMuted,
      muted: storedVoiceMuted(),
      render: (view) => stage?.update(view),
      onFatal: (message, stage) => {
        if (stage && fallBackFrom(stage === "asr" ? settings.asrEngine : settings.ttsEngine)) restartVoice();
        else stopVoice(message);
      },
    });
    const announcer = createAnnouncer({
      scope: () => currentVoiceSettings().announceScope,
      language: () => currentVoiceSettings().language,
      isVoiceThread: (threadRef) => isVoiceThread(user, threadRef),
      foregroundThread,
      sessions: sessionsNow,
      tail: taskTail,
      pendingApproval: async (sessionId) => {
        const [pending] = (await fetchSessionApprovals(sessionId))?.approvals ?? [];
        return pending ? (pending.summary ?? pending.purpose ?? pending.command) : "";
      },
      summarize: streamVoiceReply,
      title: (threadRef) => titles.get(threadRef),
      deliver: (announcement) => {
        notifyHidden(announcement);
        controller.announce(announcement.text);
      },
    });
    session = {
      abort,
      controller,
      announcer,
      graph: audio,
      workers,
      release: [
        onSessionState((event) => announcer.handle(event)),
        onSessionStateResync(() => void announcer.resync().catch((e: unknown) => swallow("voice: resync", e))),
        onVoiceSettingsChange((next) => {
          const effective = effectiveVoiceSettings(next, gatedModels);
          if (effective.ttsEngine !== settings.ttsEngine || effective.asrEngine !== settings.asrEngine) {
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
    onTypeInstead: (text) => session?.controller.type(text),
    onLanguage: (language) => changeVoiceSettings({ language }),
    onVoice: (voice) => changeVoiceSettings({ voice, language: languageForVoice(runtimeSettings(), voice) }),
    onMicMode: (micMode) => changeVoiceSettings({ micMode }),
    onClose: () => undefined,
  });
  showIdle();
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
