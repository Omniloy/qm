import type { RowActionSpec } from "./drive-mount";

/**
 * DOM-free decisions for the browser pane.
 *
 * The pane says one of a few things and offers one of a few actions, and
 * getting that wrong is worse than it sounds: a pane that claims the agent is
 * working while a person holds the wheel invites two people to drive at once.
 * So the choosing lives here, with tests, and the template only renders.
 */

export type ControlMode = "agent" | "human_control";

export interface LiveSession {
  provider: string;
  sessionId: string;
  threadRef: string;
  liveViewUrl: string;
  controlMode: ControlMode;
  expiresAt: number;
  handedOffAt?: number;
}

/**
 * Whether this conversation should show a pane at all.
 *
 * A person has one browser, opened by one conversation. Every other
 * conversation shows nothing — not an empty state, nothing — because a browser
 * bolted to a chat that did not ask for it is noise.
 */
export function paneVisible(session: LiveSession | null, threadRef: string | null, nowMs: number): boolean {
  if (!session || !threadRef) return false;
  if (session.threadRef !== threadRef) return false;
  // An expired session is a pane pointing at a browser that is already gone.
  return session.expiresAt > nowMs;
}

export interface PaneStatus {
  label: string;
  /** True while a person holds the wheel — the accent state, and the loud one. */
  human: boolean;
}

/**
 * What to show once a browser is gone.
 *
 * Sessions end for three different reasons and only one of them is boring.
 * Vanishing silently makes a crash look like the pane broke — which is exactly
 * how it read the first time someone watched one die mid-task.
 */
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

/** The one inline action. Everything else lives in the overflow. */
export function primaryAction(session: LiveSession): { id: string; label: string } {
  return session.controlMode === "human_control"
    ? { id: "release", label: "Give back to agent" }
    : { id: "take", label: "Take control" };
}

const MINUTE = 60_000;

/**
 * How long is left, coarsely. The provider caps a session at 30 minutes, so
 * this is real information rather than decoration — but only near the end,
 * because a countdown running the whole time reads as a threat.
 */
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
    // Separated and destructive: ending a browser loses whatever half-finished
    // thing is on screen, and it is one row away from Minimize.
    { id: "end", label: "End session…", danger: true },
  ];
}

/**
 * What the composer says while a person is driving.
 *
 * Silence here is the bug worth avoiding: someone types a follow-up, the agent
 * is parked, and nothing happens.
 */
export function composerNote(session: LiveSession | null): string | null {
  if (!session || session.controlMode !== "human_control") return null;
  return "Agent paused — give control back to continue";
}
