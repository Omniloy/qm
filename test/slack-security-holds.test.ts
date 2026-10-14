import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSecurityHoldActions, SECURITY_HOLD_REPORT_CALLBACK } from "../src/slack/security-holds.ts";

type Handler = (args: any) => Promise<void>;

function fixture() {
  const actions: Array<{ pattern: RegExp; handler: Handler }> = [];
  const views = new Map<string, Handler>();
  const reports: Array<[string, string, string | undefined]> = [];
  const opened: any[] = [];
  const ephemerals: any[] = [];
  const stored = {
    requestId: "req-1",
    command: "release quarantined skills output",
    summaryDetail: "--- name: browse\n`cookies` returns the site's cookies as JSON, HttpOnly included.",
    securityHold: {
      source: { kind: "command", command: "ls" },
      step: "Running a command",
      category: "other",
    },
    request: { actor: { externalId: "owner@acme.test" } },
  };
  registerSecurityHoldActions(
    {
      action: (pattern, handler) => void actions.push({ pattern, handler }),
      view: (id, handler) => void views.set(id, handler),
    },
    {
      core: {
        getApproval: async (id: string) => (id === "req-1" ? (stored as never) : null),
        reportSecurityHold: async (id: string, reporter: string, note?: string) => {
          reports.push([id, reporter, note]);
          return { state: "created", report: { id: "r1" } } as never;
        },
      },
      directory: {
        classifyActor: async (_client: unknown, userId: string) => ({
          externalId: userId === "U-owner" ? "owner@acme.test" : `${userId}@acme.test`,
        }),
      },
    },
  );
  const client = {
    views: { open: async (body: any) => void opened.push(body) },
    chat: { postEphemeral: async (body: any) => void ephemerals.push(body) },
  };
  const click = (actionId: string, user: string) =>
    actions
      .find((a) => a.pattern.test(actionId))!
      .handler({
        ack: async () => {},
        body: { user: { id: user }, channel: { id: "D1" }, message: { ts: "1.0" }, trigger_id: "trig" },
        action: { action_id: actionId, value: "req-1" },
        client,
      });
  const submit = async (user: string, note?: string) => {
    const acks: any[] = [];
    await views.get(SECURITY_HOLD_REPORT_CALLBACK)!({
      ack: async (body?: unknown) => void acks.push(body),
      body: { user: { id: user } },
      view: {
        private_metadata: JSON.stringify({ requestId: "req-1" }),
        state: { values: { note: { note: { value: note } } } },
      },
      client,
    });
    return acks;
  };
  return { click, submit, opened, ephemerals, reports };
}

test("the requester can open what was blocked in a modal", async () => {
  const f = fixture();
  await f.click("security_hold_show", "U-owner");
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].trigger_id, "trig");
  assert.match(JSON.stringify(f.opened[0].view), /HttpOnly included/);
});

test("report opens a modal with an optional note, and submitting it files the report without releasing", async () => {
  const f = fixture();
  await f.click("security_hold_report", "U-owner");
  const view = f.opened[0].view;
  assert.equal(view.callback_id, SECURITY_HOLD_REPORT_CALLBACK);
  assert.equal(view.blocks.find((b: any) => b.type === "input").optional, true);
  assert.match(JSON.stringify(view), /never releases the content/);
  const acks = await f.submit("U-owner", "our own built-in skill");
  assert.deepEqual(f.reports, [["req-1", "owner@acme.test", "our own built-in skill"]]);
  assert.equal(acks[0].response_action, "update");
  assert.match(JSON.stringify(acks[0].view), /Reported to your admins/);
});

test("someone other than the requester can neither open nor report the hold", async () => {
  const f = fixture();
  await f.click("security_hold_show", "U-other");
  await f.click("security_hold_report", "U-other");
  assert.equal(f.opened.length, 0);
  assert.equal(f.ephemerals.length, 2);
  const acks = await f.submit("U-other", "sneaky");
  assert.equal(f.reports.length, 0);
  assert.equal(acks[0].response_action, "errors");
});
