import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { conversationScope } from "../src/resolution/resolution-service.ts";
import { createDeduper, createThreadTracker, openConversationFor, slackUserIdFor } from "../src/slack/lib.ts";
import { createSlackRateLimitNotice } from "../src/slack/rate-limit-notice.ts";
import { createTurnHandler } from "../src/slack/turn-handler.ts";
import { createConversationSerializer } from "../src/slack/conversation-view.ts";
import type { BotIdentity, Directory } from "../src/slack/directory.ts";

const LOGIN = "dana.lee@acme.test";
const SLACK_EMAIL = "dana.leeds@acme.test";
const OIDC_LOGIN = "oidc:issuer.acme.test:dana";

function slackError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error },
  });
}

function slackClient(members: Record<string, string>) {
  const lookups: string[] = [];
  const opened: string[] = [];
  return {
    lookups,
    opened,
    users: {
      lookupByEmail: async ({ email }: { email: string }) => {
        lookups.push(email);
        const id = members[email];
        if (!id) throw slackError("users_not_found");
        return { ok: true, user: { id } };
      },
    },
    conversations: {
      open: async ({ users }: { users: string }) => {
        opened.push(users);
        return { channel: { id: `D-${users}` } };
      },
    },
  };
}

async function link(alias: string, canonical: string): Promise<void> {
  const links = createPrincipalLinkService();
  await links.link({
    principalId: alias,
    canonicalId: canonical,
    evidence: "admin confirmed both identities belong to one member",
    linkedBy: "admin@acme.test",
  });
  installPrincipalLinks(links);
}

const linkSlackEmail = () => link(SLACK_EMAIL, LOGIN);

describe("Slack resolves a linked member through any of their linked identities", () => {
  afterEach(() => installPrincipalLinks(null));

  it("opens the DM through the linked Slack email when the login email has no Slack member", async () => {
    await linkSlackEmail();
    const client = slackClient({ [SLACK_EMAIL]: "U0DANA" });
    assert.equal(await openConversationFor(client, [LOGIN]), "D-U0DANA");
    assert.equal(await openConversationFor(client, [LOGIN, "U0KAI"]), "D-U0DANA,U0KAI");
    assert.deepEqual(client.lookups, [LOGIN, SLACK_EMAIL, LOGIN, SLACK_EMAIL]);
    assert.deepEqual(client.opened, ["U0DANA", "U0DANA,U0KAI"]);
  });

  it("uses a linked Slack member id directly once the login email misses", async () => {
    await link("U0DANA", LOGIN);
    const client = slackClient({});
    assert.equal(await slackUserIdFor(client, LOGIN), "U0DANA");
    assert.equal(await slackUserIdFor(client, "U0DANA"), "U0DANA");
    assert.deepEqual(client.lookups, [LOGIN]);
  });

  it("reaches a sign-in without an email through its linked Slack email", async () => {
    await link(SLACK_EMAIL, OIDC_LOGIN);
    const client = slackClient({ [SLACK_EMAIL]: "U0DANA" });
    assert.equal(await slackUserIdFor(client, OIDC_LOGIN), "U0DANA");
    assert.deepEqual(client.lookups, [SLACK_EMAIL]);
  });

  it("prefers the canonical email's member when both emails resolve, from either principal", async () => {
    await linkSlackEmail();
    const client = slackClient({ [LOGIN]: "U0LOGIN", [SLACK_EMAIL]: "U0SLACK" });
    assert.equal(await slackUserIdFor(client, LOGIN), "U0LOGIN");
    assert.equal(await slackUserIdFor(client, SLACK_EMAIL), "U0LOGIN");
    assert.deepEqual(client.lookups, [LOGIN, LOGIN]);
  });

  it("propagates Slack failures other than users_not_found without trying the next email", async () => {
    await linkSlackEmail();
    for (const failure of [{ code: "slack_webapi_rate_limited_error", retryAfter: 30 }, slackError("invalid_auth")]) {
      const lookups: string[] = [];
      const client = {
        users: {
          lookupByEmail: async ({ email }: { email: string }) => {
            lookups.push(email);
            throw failure;
          },
        },
      };
      await assert.rejects(slackUserIdFor(client, LOGIN), (err) => err === failure);
      assert.deepEqual(lookups, [LOGIN]);
    }
  });

  it("reports no Slack member only after every linked email misses", async () => {
    await linkSlackEmail();
    const client = slackClient({});
    await assert.rejects(slackUserIdFor(client, LOGIN), /no Slack member found for dana\.lee@acme\.test/);
    assert.deepEqual(client.lookups, [LOGIN, SLACK_EMAIL]);
  });

  it("without links looks up only the given email and passes other ids through untouched", async () => {
    const client = slackClient({ [SLACK_EMAIL]: "U0DANA" });
    await assert.rejects(openConversationFor(client, [LOGIN]), /no Slack member found for dana\.lee@acme\.test/);
    assert.deepEqual(client.lookups, [LOGIN]);
    assert.equal(await slackUserIdFor(client, SLACK_EMAIL), "U0DANA");
    assert.equal(await slackUserIdFor(client, "U0OTHER"), "U0OTHER");
    assert.equal(await slackUserIdFor(client, OIDC_LOGIN), OIDC_LOGIN);
    assert.deepEqual(client.lookups, [LOGIN, SLACK_EMAIL]);
    assert.deepEqual(client.opened, []);
  });

  it("sends the history rate-limit notice to the member found through the linked email", async () => {
    await linkSlackEmail();
    const ephemeral: Array<{ channel: string; user: string }> = [];
    const client = {
      ...slackClient({ [SLACK_EMAIL]: "U0DANA" }),
      chat: {
        postEphemeral: async (args: { channel: string; user: string }) => void ephemeral.push(args),
      },
    };
    const notice = createSlackRateLimitNotice({ managed: true, setupUrl: "https://qm.example/admin/?setup=slack" });
    await notice.run(client, { target: "C1:1700.1", user: LOGIN }, () =>
      notice.observe({ code: "slack_webapi_rate_limited_error", retryAfter: 30 }),
    );
    assert.deepEqual(
      ephemeral.map(({ channel, user }) => ({ channel, user })),
      [{ channel: "C1", user: "U0DANA" }],
    );
  });

  it("points a linked member's DM header at their canonical personal scope", async () => {
    await linkSlackEmail();
    const headers: Array<{ channel: string; scope: string; kind: string }> = [];
    const turns: string[] = [];
    const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;
    const actor = { externalId: SLACK_EMAIL, displayName: "Dana" };
    const directory = { classifyUserCached: async () => ({ actor }) } as unknown as Directory;
    const handler = createTurnHandler({
      core: { stageBlob: async () => ({ blobId: "b", sizeBytes: 0 }) },
      flow: {
        inFlightRuns: { add() {}, delete() {}, has: () => false },
        inFlightRunByThread: { get() {}, set() {}, clear() {} },
        ackRunDelivery() {},
        callCore: async (turn: { actor: { externalId: string } }) => {
          turns.push(turn.actor.externalId);
          return { status: "ok", reply: "" };
        },
      },
      directory,
      mirror: { mirrorMessageEvent: async () => {} },
      serializer: createConversationSerializer({
        ids,
        directory,
        externalParticipantsEnabled: async () => false,
        readHistory: async () => {
          throw new Error("history unavailable");
        },
      }),
      ackEmoji: { refreshAckEmoji() {}, ackPickCandidates: () => [], requestAckEmoji: async () => undefined },
      ackEmojiCandidates: () => ["eyes"],
      ids,
      threads: createThreadTracker(),
      deduper: createDeduper(),
      externalParticipantsEnabled: async () => false,
      ensureHeader: (_client: unknown, channel: string, scope: string, kind: string) =>
        void headers.push({ channel, scope, kind }),
    } as unknown as Parameters<typeof createTurnHandler>[0]);
    await handler.handleIncoming(
      { kind: "dm", channel: "D1", userId: "U0DANA", rawText: "hello", files: [], ts: "1.000" },
      {
        chat: { postMessage: async () => ({ ts: "2.000" }) },
        reactions: { add: async () => {}, remove: async () => {} },
      },
    );
    const coreScope = conversationScope({ kind: "dm", threadRef: "D1" }, createIdentityService().resolve(actor).id);
    assert.equal(coreScope, `personal:${LOGIN}`);
    assert.deepEqual(headers, [{ channel: "D1", scope: coreScope, kind: "dm" }]);
    assert.deepEqual(turns, [SLACK_EMAIL]);
  });
});
