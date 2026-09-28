import type { RowActionSpec } from "./drive-mount";

type ControlMode = "agent" | "human_control";

type ViewerKind = "iframe";

export interface LiveSession {
  provider: string;
  sessionId: string;
  threadRef: string;
  viewer: ViewerKind;
  liveViewUrl?: string;
  controlMode: ControlMode;
  expiresAt: number;
  handedOffAt?: number;
}

export function paneVisible(session: LiveSession | null, threadRef: string | null, nowMs: number): boolean {
  if (!session || !threadRef) return false;
  if (session.threadRef !== threadRef) return false;
  return session.expiresAt > nowMs;
}

export interface PaneStatus {
  label: string;
  human: boolean;
}

export function endedNote(reason: "ended" | "expired" | "lost"): string {
  if (reason === "expired") return "Session timed out. Your sign-ins were saved.";
  if (reason === "lost") return "That browser stopped. The agent will say if it opened another.";
  return "Browser closed. Your sign-ins were saved.";
}

export function paneStatus(session: LiveSession): PaneStatus {
  return session.controlMode === "human_control"
    ? { label: "You have control", human: true }
    : { label: "Agent working", human: false };
}

export function primaryAction(session: LiveSession): { id: string; label: string } {
  return session.controlMode === "human_control"
    ? { id: "release", label: "Give back to agent" }
    : { id: "take", label: "Take control" };
}

const MINUTE = 60_000;

export function timeLeft(session: LiveSession, nowMs: number): string | null {
  const ms = session.expiresAt - nowMs;
  if (ms <= 0) return "ending";
  const mins = Math.ceil(ms / MINUTE);
  return mins <= 5 ? `${mins} min left` : null;
}

export function paneActions(session: LiveSession): RowActionSpec[] {
  const human = session.controlMode === "human_control";
  return [
    { id: "minimize", label: "Minimize" },
    { id: "open", label: "Open in a new tab" },
    {
      id: "release",
      label: "Give back to agent",
      disabled: !human,
      ...(human ? {} : { reason: "The agent already has it" }),
    },
    { id: "end", label: "End session…", danger: true },
  ];
}

export function composerNote(session: LiveSession | null): string | null {
  if (!session || session.controlMode !== "human_control") return null;
  return "Agent paused — give control back to continue";
}
