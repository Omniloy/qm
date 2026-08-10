import test from "node:test";
import assert from "node:assert/strict";
import { createRelayHub, type RelaySocket } from "../src/browser-relay/relay.ts";

const PERSON = "someone@example.com";

function fake(): RelaySocket & { sent: string[]; closed: Array<{ code?: number; reason?: string }> } {
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    sent,
    closed,
    send: (data) => void sent.push(data),
    close: (code, reason) => void closed.push({ ...(code ? { code } : {}), ...(reason ? { reason } : {}) }),
  };
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

test("the browser-level handshake is answered here, not forwarded", () => {
  const hub = createRelayHub();
  const ext = fake();
  const cdp = fake();
  hub.attach(PERSON, "extension", ext);
  hub.attach(PERSON, "cdp", cdp);

  hub.deliver(PERSON, "cdp", JSON.stringify({ id: 1, method: "Target.getTargets" }));
  hub.deliver(PERSON, "cdp", JSON.stringify({ id: 2, method: "Target.attachToTarget", params: {} }));

  // Chrome's debugger attaches to a tab, so there is nothing upstream to ask.
  assert.equal(ext.sent.length, 0);
  const targets = parse(cdp.sent[0]!).result as { targetInfos: Array<{ type: string; targetId: string }> };
  assert.equal(targets.targetInfos.length, 1);
  assert.equal(targets.targetInfos[0]!.type, "page");
  assert.ok((parse(cdp.sent[1]!).result as { sessionId: string }).sessionId);
});

test("the synthetic page reports the tab the extension actually attached to", () => {
  const hub = createRelayHub();
  const ext = fake();
  const cdp = fake();
  hub.attach(PERSON, "extension", ext);
  hub.deliver(
    PERSON,
    "extension",
    JSON.stringify({ qm: "attached", title: "Uber Eats", url: "https://ubereats.com/" }),
  );
  hub.attach(PERSON, "cdp", cdp);

  hub.deliver(PERSON, "cdp", JSON.stringify({ id: 1, method: "Target.getTargets" }));
  const info = (parse(cdp.sent[0]!).result as { targetInfos: Array<{ title: string; url: string }> }).targetInfos[0]!;
  assert.equal(info.title, "Uber Eats");
  assert.equal(info.url, "https://ubereats.com/");
  assert.deepEqual(hub.describe(PERSON), { title: "Uber Eats", url: "https://ubereats.com/" });
});

test("everything else crosses to the extension untouched", () => {
  const hub = createRelayHub();
  const ext = fake();
  const cdp = fake();
  hub.attach(PERSON, "extension", ext);
  hub.attach(PERSON, "cdp", cdp);

  const go = JSON.stringify({ id: 7, sessionId: "s", method: "Page.navigate", params: { url: "https://x.test/" } });
  hub.deliver(PERSON, "cdp", go);
  assert.deepEqual(ext.sent, [go]);

  const result = JSON.stringify({ id: 7, result: { frameId: "f" } });
  hub.deliver(PERSON, "extension", result);
  assert.deepEqual(cdp.sent, [result]);
});

test("a command sent while Chrome is absent is refused, not dropped", () => {
  const hub = createRelayHub();
  const cdp = fake();
  hub.attach(PERSON, "cdp", cdp);
  hub.deliver(PERSON, "cdp", JSON.stringify({ id: 3, method: "Page.navigate", params: {} }));
  // Silence would hang the turn until its wall clock; an error ends it now.
  const err = parse(cdp.sent[0]!).error as { message: string };
  assert.match(err.message, /not connected/);
});

test("losing the extension closes the agent's side rather than hanging it", () => {
  const hub = createRelayHub();
  const ext = fake();
  const cdp = fake();
  hub.attach(PERSON, "extension", ext);
  hub.attach(PERSON, "cdp", cdp);
  hub.detach(PERSON, "extension");
  assert.equal(cdp.closed.length, 1);
  assert.deepEqual(hub.connected(PERSON), { extension: false, cdp: false });
});

test("a reconnecting extension replaces the stale socket", () => {
  const hub = createRelayHub();
  const first = fake();
  const second = fake();
  hub.attach(PERSON, "extension", first);
  hub.attach(PERSON, "extension", second);
  // A service worker restart is routine; the old socket must stop receiving.
  assert.equal(first.closed.length, 1);
  const cdp = fake();
  hub.attach(PERSON, "cdp", cdp);
  hub.deliver(PERSON, "cdp", JSON.stringify({ id: 1, method: "Page.reload" }));
  assert.equal(first.sent.length, 0);
  assert.equal(second.sent.length, 1);
});

test("one person's Chrome is never reachable from another's agent", () => {
  const hub = createRelayHub();
  const mine = fake();
  const theirCdp = fake();
  hub.attach(PERSON, "extension", mine);
  hub.attach("someone-else@example.com", "cdp", theirCdp);
  hub.deliver("someone-else@example.com", "cdp", JSON.stringify({ id: 1, method: "Page.navigate", params: {} }));
  assert.equal(mine.sent.length, 0);
  assert.match((parse(theirCdp.sent[0]!).error as { message: string }).message, /not connected/);
});

test("closing the browser ends the agent's use of it, not the person's Chrome", () => {
  const hub = createRelayHub();
  const ext = fake();
  const cdp = fake();
  hub.attach(PERSON, "extension", ext);
  hub.attach(PERSON, "cdp", cdp);
  hub.deliver(PERSON, "cdp", JSON.stringify({ id: 9, method: "Browser.close" }));
  // Never forwarded: quitting someone's own browser is not ours to do.
  assert.equal(ext.sent.length, 0);
  assert.deepEqual(parse(cdp.sent[0]!), { id: 9, result: {} });
});
