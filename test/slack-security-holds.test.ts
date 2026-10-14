import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSecurityHoldActions, SECURITY_HOLD_REPORT_CALLBACK } from "../src/slack/security-holds.ts";

type Handler = (args: any) => Promise<void>;

function fixture(stored: Record<string, unknown> = {}) {
  const actions: Array<{ pattern: RegExp; handler: Handler }> = [];
  const views = new Map<string, Handler>();
  const reports: Array<[string, string, string | undefined]> = [];
  const events: string[] = [];
  const opened: any[] = [];
  const updated: any[] = [];
  const record = {
    requestId: "req-1",
    command: "release quarantined skills output",
    summaryDetail: "--- name: browse\n`cookies` returns the site's cookies as JSON, HttpOnly included.",
    securityHold: { source: { kind: "command", command: "ls" }, category: "other" },
    request: { surface: "test", actor: { externalId: "owner@acme.test" } },
    ...stored,
  };
  registerSecurityHoldActions(
    {
      action: (pattern, handler) => void actions.push({ pattern, handler }),
      view: (id, handler) => void views.set(id, handler),
    },
    {
      core: {
        getApproval: async (id: string) => {
          events.push("lookup");
          return id === "req-1" ? (record as never) : null;
        },
        reportSecurityHold: async (id: string, reporter: string, note?: string) => {
          events.push("report");
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
    views: {
      open: async (body: any) => {
        events.push("open");
        opened.push(body);
        return { view: { id: "V1" } };
      },
      update: async (body: any) => void updated.push(body),
    },
    chat: { postEphemeral: async () => ({ ok: true }) },
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
      ack: async (body?: unknown) => {
        events.push("ack");
        acks.push(body);
      },
      body: { user: { id: user } },
      view: { private_metadata: "req-1", state: { values: { note: { note: { value: note } } } } },
      client,
    });
    return acks;
  };
  return { click, submit, opened, updated, reports, events };
}

test("show opens the modal before any lookup, then fills in what was blocked for the requester", async () => {
  const f = fixture();
  await f.click("security_hold_show", "U-owner");
  assert.deepEqual(f.events.slice(0, 2), ["open", "lookup"], "the trigger id is used before it can expire");
  assert.equal(f.opened[0].trigger_id, "trig");
  assert.equal(f.updated[0].view_id, "V1");
  assert.match(JSON.stringify(f.updated[0].view), /HttpOnly included/);
});

test("report opens immediately, discloses what admins see, and the submission acks before writing", async () => {
  const f = fixture();
  await f.click("security_hold_report", "U-owner");
  assert.deepEqual(f.events, ["open"]);
  const view = f.opened[0].view;
  assert.equal(view.callback_id, SECURITY_HOLD_REPORT_CALLBACK);
  assert.equal(view.private_metadata, "req-1");
  assert.equal(view.blocks.find((b: any) => b.type === "input").optional, true);
  assert.match(JSON.stringify(view), /full blocked content/);
  assert.match(JSON.stringify(view), /never releases the content/);
  const acks = await f.submit("U-owner", "our own built-in skill");
  assert.ok(f.events.indexOf("ack") < f.events.indexOf("report"), "ack lands before the write");
  assert.deepEqual(f.reports, [["req-1", "owner@acme.test", "our own built-in skill"]]);
  assert.equal(acks[0].response_action, "update");
  assert.match(JSON.stringify(acks[0].view), /Saved for your admins to review/);
  assert.doesNotMatch(JSON.stringify(acks[0].view), /Reported to your admins/);
});

test("someone other than the person the hold waits on can neither see nor report it", async () => {
  const f = fixture();
  await f.click("security_hold_show", "U-other");
  assert.doesNotMatch(JSON.stringify(f.updated[0].view), /HttpOnly/);
  const acks = await f.submit("U-other", "sneaky");
  assert.equal(f.reports.length, 0);
  assert.equal(acks[0].response_action, "errors");
});

test("a scheduled task's hold is decided by the cron owner, not the acting member", async () => {
  const f = fixture({
    request: { surface: "cron", actor: { externalId: "floor@acme.test" } },
    securityHold: {
      source: { kind: "command", command: "ls" },
      category: "other",
      scheduledTask: { id: "c1", ownerId: "owner@acme.test" },
    },
  });
  await f.submit("U-owner", "fine");
  assert.deepEqual(f.reports, [["req-1", "owner@acme.test", "fine"]]);
  const acks = await f.submit("U-floor", "not mine");
  assert.equal(acks[0].response_action, "errors");
});
