import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { Directory } from "./directory.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import { SECURITY_HOLD_ACTION_IDS } from "./approval-cards.ts";
import { samePerson } from "../directory/person.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";
import { MAX_REPORT_NOTE_CHARS } from "../security/screening-reports.ts";

export const SECURITY_HOLD_REPORT_CALLBACK = "security_hold_report";
const NOTE_BLOCK = "note";
const NOTE_ACTION = "note";
const MAX_SHOWN_BLOCKS = 40;
const SHOWN_CHUNK_CHARS = 2_900;

interface HoldActionDeps {
  core: Pick<SlackCoreClient, "getApproval" | "reportSecurityHold">;
  directory: Pick<Directory, "classifyActor">;
}

interface SlackRegistrar {
  action(pattern: RegExp, handler: (args: any) => Promise<void>): void;
  view(callbackId: string, handler: (args: any) => Promise<void>): void;
}

function plain(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}

function blockedContentModal(content: string): Record<string, unknown> {
  const chunks: string[] = [];
  for (let i = 0; i < content.length && chunks.length < MAX_SHOWN_BLOCKS; i += SHOWN_CHUNK_CHARS)
    chunks.push(content.slice(i, i + SHOWN_CHUNK_CHARS));
  return {
    type: "modal",
    title: plain("What was blocked"),
    close: plain("Close"),
    blocks: [
      {
        type: "context",
        elements: [
          plain(
            "This is the exact content the security screen held back. It is still blocked until you choose Allow once.",
          ),
        ],
      },
      ...(chunks.length ? chunks : ["(nothing was captured)"]).map((chunk) => ({
        type: "section",
        text: plain(chunk),
      })),
    ],
  };
}

function reportModal(meta: { requestId: string; channel?: string }): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: SECURITY_HOLD_REPORT_CALLBACK,
    private_metadata: JSON.stringify(meta),
    title: plain("Report false positive"),
    submit: plain("Send to admins"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Your admins will see the flagged text, the screener's reason and your note. Reporting never releases the content; you still choose *Allow once* or *Keep blocked*.",
        },
      },
      {
        type: "input",
        block_id: NOTE_BLOCK,
        optional: true,
        label: plain("Why does this look wrong?"),
        element: {
          type: "plain_text_input",
          action_id: NOTE_ACTION,
          multiline: true,
          max_length: MAX_REPORT_NOTE_CHARS,
          placeholder: plain("e.g. This is our own built-in skill doing what it documents."),
        },
      },
    ],
  };
}

function reportedModal(): Record<string, unknown> {
  return {
    type: "modal",
    title: plain("Report sent"),
    close: plain("Close"),
    blocks: [
      {
        type: "section",
        text: plain(
          "Reported to your admins as a possible false positive. The content is still blocked; choose Allow once or Keep blocked on the card.",
        ),
      },
    ],
  };
}

function reportedRequestId(metadata: unknown): string {
  try {
    const meta = JSON.parse(String(metadata ?? "{}")) as { requestId?: unknown };
    return typeof meta.requestId === "string" ? meta.requestId : "";
  } catch {
    return "";
  }
}

async function requesterOf(deps: HoldActionDeps, client: any, requestId: string, clickerId: string) {
  const stored = await deps.core.getApproval(requestId).catch(swallowAs("slack: security hold lookup", null));
  const requester = (stored?.request as { actor?: { externalId?: unknown } } | undefined)?.actor?.externalId;
  if (!stored?.securityHold || typeof requester !== "string") return null;
  if (clickerId === requester) return { stored, actorId: requester };
  const actor = await deps.directory.classifyActor(client, clickerId);
  return samePerson(actor.externalId, requester) ? { stored, actorId: actor.externalId } : null;
}

export function registerSecurityHoldActions(app: SlackRegistrar, deps: HoldActionDeps): void {
  app.action(/^security_hold_/, async ({ ack, body, action, client }) => {
    await ack();
    const parsed = parseBlockAction(action, SECURITY_HOLD_ACTION_IDS);
    const { clickerId, channel } = parseInteractionBody(body);
    const triggerId = isObj(body) && typeof body.trigger_id === "string" ? body.trigger_id : "";
    if (!parsed || !clickerId || !triggerId) return;
    try {
      const found = await requesterOf(deps, client, parsed.value, clickerId);
      if (!found) {
        if (channel)
          await client.chat
            .postEphemeral({
              channel,
              user: clickerId,
              text: "Only the person this security hold is waiting on can open it, and it may have been resolved already.",
            })
            .catch(swallowAs("slack: chat.postEphemeral", undefined));
        return;
      }
      const view =
        parsed.actionId === "security_hold_show"
          ? blockedContentModal(found.stored.summaryDetail ?? "")
          : reportModal({ requestId: parsed.value, ...(channel ? { channel } : {}) });
      await client.views.open({ trigger_id: triggerId, view });
    } catch (error) {
      console.error("[slack] security hold action failed:", errMessage(error));
    }
  });

  app.view(SECURITY_HOLD_REPORT_CALLBACK, async ({ ack, body, view, client }) => {
    const requestId = reportedRequestId(view?.private_metadata);
    const clickerId = String(body?.user?.id ?? "");
    const note = view?.state?.values?.[NOTE_BLOCK]?.[NOTE_ACTION]?.value;
    const found = requestId && clickerId ? await requesterOf(deps, client, requestId, clickerId) : null;
    if (!found) {
      await ack({
        response_action: "errors",
        errors: { [NOTE_BLOCK]: "This hold was already resolved, or it isn't yours to report." },
      });
      return;
    }
    const outcome = await deps.core
      .reportSecurityHold(requestId, found.actorId, typeof note === "string" ? note : undefined)
      .catch(swallowAs("slack: security hold report", { state: "unavailable" as const }));
    if (outcome.state === "created" || outcome.state === "exists") {
      await ack({ response_action: "update", view: reportedModal() });
      return;
    }
    await ack({
      response_action: "errors",
      errors: { [NOTE_BLOCK]: "I couldn't send the report just now. Try again in a moment." },
    });
  });
}
