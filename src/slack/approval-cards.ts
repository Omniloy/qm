import { xmlEscape } from "../util/message-tag.ts";
import { clip, escapedClip, inlineCode } from "./util.ts";
import { securityHoldView, type SecurityHold } from "../security/security-hold.ts";
import { parseDeliveryTarget } from "./delivery.ts";
import type { AgentRequestActionId } from "./agent-requests.ts";

export const APPROVAL_ACTION_IDS = ["hilo_allow_once", "hilo_allow_session", "hilo_allow_always", "hilo_deny"] as const;
export type ApprovalActionId = (typeof APPROVAL_ACTION_IDS)[number];
export const SECURITY_HOLD_ACTION_IDS = ["security_hold_report", "security_hold_show"] as const;
export type SecurityHoldActionId = (typeof SECURITY_HOLD_ACTION_IDS)[number];

export interface PendingApproval {
  requestId: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  securityHold?: SecurityHold;
}

export interface SlackApprovalMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

const APPROVAL_BLOCK_PREFIX = "hilo_approval:";
const MAX_CARD_BLOCKS = 50;
const SECURITY_HOLD_BLOCKS = 5;

export function button(
  text: string,
  actionId: ApprovalActionId | AgentRequestActionId | SecurityHoldActionId,
  value: string,
  style?: "primary" | "danger",
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

export interface ApprovalCardDestination {
  toDm: boolean;
  channelPointer: string;
}

export function approvalCardDestination(threadOnly: boolean): ApprovalCardDestination {
  return threadOnly
    ? { toDm: true, channelPointer: "I sent you a DM to approve before I run that." }
    : { toDm: false, channelPointer: "" };
}

export function approvalMessage(approvals: readonly PendingApproval[]): SlackApprovalMessage {
  const items = approvals.length
    ? approvals
    : [{ requestId: "", command: "unknown command", reason: "requires approval" }];
  const describe = (p: (typeof items)[number]): string => {
    if (p.kind === "input") return "My security screen flagged part of this message. Allow it?";
    if (p.purpose) return `Approval needed: ${escapedClip(p.purpose, 400)}`;
    return `Approval needed before I can run ${inlineCode(p.command)}.`;
  };
  const text = items
    .map((p) => (p.securityHold ? `${xmlEscape(securityHoldView(p.securityHold).title)} needs your OK.` : describe(p)))
    .join("\n");
  const blocks: Array<Record<string, unknown>> = [];
  for (const [index, p] of items.entries()) {
    const needed = p.securityHold ? SECURITY_HOLD_BLOCKS : 2;
    if (blocks.length + needed > MAX_CARD_BLOCKS - 1) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${items.length - index} more ${items.length - index === 1 ? "approval is" : "approvals are"} waiting. Open the conversation in the web app to see them all.`,
          },
        ],
      });
      break;
    }
    if (p.securityHold) {
      blocks.push(...securityHoldBlocks(p.requestId, p.securityHold));
      continue;
    }
    const lines = [
      p.kind === "input"
        ? ":lock: *My security screen flagged part of this message. Allow it?*"
        : ":lock: *Approval needed.*",
    ];
    if (p.summary) lines.push(escapedClip(p.summary, 400));
    if (p.purpose) lines.push(`*Why:* ${escapedClip(p.purpose, 400)}`);
    if (p.kind !== "input") lines.push(`*Command:* ${inlineCode(p.command)}`);
    lines.push(`*Flagged as:* ${escapedClip(p.reason, 200)}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } });
    blocks.push({
      type: "actions",
      block_id: `${APPROVAL_BLOCK_PREFIX}${p.requestId || "unknown"}`.slice(0, 255),
      elements: [
        button("Allow once", "hilo_allow_once", p.requestId, "primary"),
        ...(p.grantModes?.session === false ? [] : [button("Allow session", "hilo_allow_session", p.requestId)]),
        ...(p.grantModes?.always === false ? [] : [button("Allow always", "hilo_allow_always", p.requestId)]),
        button("Deny", "hilo_deny", p.requestId, "danger"),
      ],
    });
  }
  return { text, blocks };
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `>${xmlEscape(line)}`)
    .join("\n");
}

function mrkdwn(text: string, verbatim = false): Record<string, unknown> {
  return { type: "mrkdwn", text, ...(verbatim ? { verbatim: true } : {}) };
}

function securityHoldBlocks(requestId: string, hold: SecurityHold): Array<Record<string, unknown>> {
  const view = securityHoldView(hold);
  const title = view.subject
    ? escapedClip(view.title, 600).replace(xmlEscape(view.subject), () => inlineCode(view.subject!))
    : escapedClip(view.title, 600);
  const facts = view.facts.map((fact) => `${fact.label}: ${clip(fact.value, 600)}`);
  return [
    {
      type: "section",
      text: mrkdwn(`:shield: *${title} needs your OK*\n${escapedClip(view.explanation, 1500)}`, true),
    },
    ...(view.evidence
      ? [{ type: "section", text: mrkdwn(`*Text the screener flagged*\n${quoted(clip(view.evidence, 400))}`, true) }]
      : []),
    {
      type: "context",
      elements: [mrkdwn(escapedClip([...facts, `Category: ${view.categoryLabel}`].join(" · "), 2900), true)],
    },
    {
      type: "section",
      text: mrkdwn(
        `*Allow once:* ${escapedClip(view.allowEffect, 600)}\n*Keep blocked:* ${escapedClip(view.keepEffect, 600)}`,
      ),
    },
    {
      type: "actions",
      block_id: `${APPROVAL_BLOCK_PREFIX}${requestId || "unknown"}`.slice(0, 255),
      elements: [
        button("Allow once", "hilo_allow_once", requestId, "primary"),
        button("Keep blocked", "hilo_deny", requestId),
        button("Report false positive", "security_hold_report", requestId),
        button("Show what was blocked", "security_hold_show", requestId),
      ],
    },
  ];
}

export interface StoredApproval {
  requestId: string;
  command: string;
  reason?: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  securityHold?: SecurityHold;
  request?: Record<string, unknown>;
}

export interface RecoveredApprovalContext {
  requesterId: string;
  channel: string;
  replyThreadTs?: string;
  threadOnly: boolean;
  approvalChannel: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  kind?: "approval" | "input";
  grantModes?: { session: boolean; always: boolean };
  securityHold?: SecurityHold;
  turn: Record<string, unknown>;
}

export function recoveredApprovalContext(
  stored: Pick<
    StoredApproval,
    "command" | "reason" | "purpose" | "summary" | "kind" | "grantModes" | "securityHold" | "request"
  >,
  click: { channel: string; threadTs?: string },
): RecoveredApprovalContext | null {
  const req = stored.request as
    | (Record<string, unknown> & {
        actor?: { externalId?: unknown };
        conversation?: { kind?: unknown };
        deliveryTarget?: unknown;
      })
    | undefined;
  if (!req || typeof req.actor?.externalId !== "string" || typeof req.text !== "string") return null;
  const kind = req.conversation?.kind;
  if (kind !== "dm" && kind !== "channel" && kind !== "group") return null;
  const {
    surface: _surface,
    async: _async,
    idempotencyKey: _idempotencyKey,
    redeliveryKey: _redeliveryKey,
    approval: _approval,
    relayInput: _relayInput,
    intakePreambleMs: _intakePreambleMs,
    clientSentAt: _clientSentAt,
    ...turn
  } = req;
  const origin =
    typeof req.deliveryTarget === "string" && req.deliveryTarget
      ? parseDeliveryTarget(req.deliveryTarget)
      : { channel: click.channel, ...(click.threadTs ? { threadTs: click.threadTs } : {}) };
  return {
    requesterId: req.actor.externalId,
    channel: origin.channel,
    ...(origin.threadTs ? { replyThreadTs: origin.threadTs } : {}),
    threadOnly: kind === "channel",
    approvalChannel: click.channel,
    command: stored.command,
    reason: stored.reason ?? "requires approval",
    ...(stored.purpose ? { purpose: stored.purpose } : {}),
    ...(stored.summary ? { summary: stored.summary } : {}),
    ...(stored.kind ? { kind: stored.kind } : {}),
    ...(stored.grantModes ? { grantModes: stored.grantModes } : {}),
    ...(stored.securityHold ? { securityHold: stored.securityHold } : {}),
    turn,
  };
}

type ApprovalBegin<T> = { state: "missing" } | { state: "busy" } | { state: "ready"; ctx: T };

export interface ApprovalRegistry<T> {
  remember(id: string, ctx: T): void;
  get(id: string): T | undefined;
  busy(id: string): boolean;
  begin(id: string): ApprovalBegin<T>;
  settle(id: string): void;
  release(id: string): void;
}

export function createApprovalRegistry<T>(): ApprovalRegistry<T> {
  const pending = new Map<string, { ctx: T; inFlight: boolean }>();
  return {
    remember(id, ctx) {
      pending.set(id, { ctx, inFlight: false });
    },
    get(id) {
      return pending.get(id)?.ctx;
    },
    busy(id) {
      return pending.get(id)?.inFlight === true;
    },
    begin(id) {
      const entry = pending.get(id);
      if (!entry) return { state: "missing" };
      if (entry.inFlight) return { state: "busy" };
      entry.inFlight = true;
      return { state: "ready", ctx: entry.ctx };
    },
    settle(id) {
      pending.delete(id);
    },
    release(id) {
      const entry = pending.get(id);
      if (entry) entry.inFlight = false;
    },
  };
}
