import { swallow } from "../../../chassis/src/errors.ts";
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
import { downloadVoiceModels, detectGpu, voiceModelFiles } from "./model-plan.ts";
import { missingModelFiles } from "./model-cache.ts";
import {
  DEFAULT_VAD_OPTIONS,
  VOICE_CHANNEL_NAME,
  type PlaybackWorkletIn,
  type PlaybackWorkletOut,
  type SpeechWorkerIn,
  type SpeechWorkerOut,
  type TtsWorkerIn,
  type TtsWorkerOut,
  type VoiceStageView,
} from "./protocol.ts";
import { currentVoiceSettings, onVoiceSettingsChange, storeVoiceMuted, storedVoiceMuted } from "./settings-store.ts";
import { isVoiceThread, runVoiceTool, taskSummaries, type TaskTail, type VoiceToolDeps } from "./tools.ts";
import { mountVoiceStage, type VoiceStage } from "./voice-stage.ts";
import { onFirstActivation } from "./activation.ts";
import { asrVariantFor } from "./asr/models.ts";
import { TTS_MODEL_FILES } from "./tts/models.ts";

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

function offView(status = ""): VoiceStageView {
  return {
    state: "off",
    language: currentVoiceSettings().language,
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

function toolDeps(user: string): VoiceToolDeps {
  return {
    user,
    sessions: sessionsNow,
    startTurn: (body) =>
      api<{ runId?: string; status?: string }>("/api/turn", { method: "POST", body: JSON.stringify(body) }),
    tail: taskTail,
    approvals: async (sessionId) => (await fetchSessionApprovals(sessionId))?.approvals ?? [],
    resolveApproval: (decision) => resolveApproval(decision),
    activeRun: async (threadRef) => (await activeRunForThread(threadRef)).runId,
    abortRun: abortRunById,
    open: openTask,
    delegated: () => {
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
  try {
    const gpu = await detectGpu();
    if (abort.signal.aborted) return;
    if (!gpu.webgpu) {
      if (takeover) stage.open();
      showIdle(copy().webgpu);
      starting = null;
      return;
    }
    const files = voiceModelFiles(gpu);
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
    const deps = toolDeps(user);
    const controller = createVoiceController({
      speech,
      tts,
      playback: nodePort(audio.playback),
      settings: currentVoiceSettings,
      reply: streamVoiceReply,
      runTool: (call) => runVoiceTool(call, deps),
      runningTasks: () => taskSummaries(sessionsState.list),
      chime: (kind) => playChime(audio.context, audio.output, kind),
      setMuted: (muted) => audio.setMuted(muted),
      onMutedChange: storeVoiceMuted,
      muted: storedVoiceMuted(),
      render: (view) => stage?.update(view),
      onFatal: (message) => stopVoice(message),
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
        onVoiceSettingsChange(() => controller.applySettings()),
      ],
    };
    starting = null;
    options?.onActiveChange(true);
    const settings = currentVoiceSettings();
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
        asrVariant: asrVariantFor(gpu),
        asrFiles: files.filter((file) => file.role === "asr"),
        language: settings.language,
        vad: { ...DEFAULT_VAD_OPTIONS },
      },
      [audio.framePort],
    );
    tts.post({
      type: "init",
      engine: settings.ttsEngine,
      files: TTS_MODEL_FILES,
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
    onTypeInstead: (text) => session?.controller.type(text),
    onClose: () => undefined,
  });
  showIdle();
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
