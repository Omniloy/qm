/**
 * The share dialog's file note tells the truth on a read-only conversation.
 *
 * `shareFilesNote` chooses between "no files are attached yet" and "this is what's loaded so
 * far" by asking `chatState.earlierCount` how much of the transcript is missing. Every write of
 * that field used to be on the active-chat path, and `mountReadOnly` — the path a Slack-backed
 * or otherwise uncontinuable conversation takes — never wrote it. So a windowed read-only
 * transcript reported zero unfetched turns and the dialog printed a reassurance it could not
 * support, one line above the Create button, while the earlier turns it was reassuring about
 * could carry attachments the link publishes. It failed the other way too: arriving from a
 * windowed active chat left that chat's count behind and called a complete list partial.
 *
 * This is a DOM test rather than a source-level one because the bug was not in either half —
 * both `mountReadOnly` and `shareFilesNote` read correctly on their own — it was in what one
 * of them left on `chatState` for the other to read.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ChatSurface, ComposerSurface, Conversation, ConvCtx, ConvHost } from "../src/conv-types.ts";
import type { CoreSession } from "../src/core-bridge.ts";

const SESSION: CoreSession = {
  id: "sess-windowed",
  type: "channel",
  scopeId: "project:1",
  threadRef: "slack:C1:1700000000.1",
  createdAt: 1,
  title: "Launch chatter",
  channelName: "launch",
  archived: false,
};

/** Open the dialog and return the words it renders under the file heading. */
async function noteAfterMount(mount: () => void): Promise<string> {
  mount();
  const button = document.querySelector<HTMLButtonElement>(".share-open");
  assert.ok(button, "the read-only header must offer Share");
  button.click();
  // openShareDialog draws synchronously, then awaits the relay; the dialog's file note is only
  // painted once the answer ("this conversation has no live link") has landed.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  const dialog = document.querySelector(".share-dialog");
  assert.ok(dialog, "the Share button must open a dialog");
  return dialog.textContent ?? "";
}

test("a windowed read-only transcript is described as partial, and a complete one is not", async () => {
  // #app is required by shell.ts's module body, which chat.ts pulls in transitively — the very
  // coupling that keeps the anonymous share page from importing chat.ts at all.
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="main"></div>', {
    url: "http://localhost/",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  // The only request that matters here is the share relay; the read-only mount also polls for a
  // live run, and answering it keeps the poll from turning into an unhandled rejection.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/share")) return Response.json({ shares: [] });
    if (path.includes("/runs")) return Response.json({ runs: [] });
    return Response.json({});
  }) as typeof fetch;

  let conv: Conversation | null = null;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { createChatSurface } = await vite.ssrLoadModule("/src/chat.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { SHARE_FILES_EMPTY, SHARE_FILES_PARTIAL } = await vite.ssrLoadModule("/src/share-state.ts");

    const main = document.querySelector<HTMLElement>("#main")!;
    const host: ConvHost = {
      pane: true,
      ownsUrl: false,
      container: () => main,
      claimContainer: () => main,
      visible: () => true,
      density: () => "full",
      onDensityChange: () => {},
      ensureDeliveryStream: () => {},
    };
    // ssrLoadModule is untyped by construction, so the two factories are re-typed here rather
    // than inferred; conversations.ts assembles exactly this pair the same way.
    const makeChat = createChatSurface as (c: ConvCtx) => ChatSurface;
    const makeComposer = createComposerSurface as (c: ConvCtx) => ComposerSurface;
    const ctx = { ...host } as ConvCtx;
    ctx.chat = makeChat(ctx);
    ctx.composer = makeComposer(ctx);
    const conversation = ctx.chat as Conversation;
    conversation.composer = ctx.composer;
    conv = conversation;

    // 1. Windowed: five turns this tab has never fetched, any of which may carry attachments.
    const windowed = await noteAfterMount(() => conversation.mountReadOnly(SESSION, [], 5, 42, []));
    // 2. Complete, arrived at from the windowed one — the stale 5 must not survive the remount.
    const complete = await noteAfterMount(() => conversation.mountReadOnly(SESSION, [], 0, null, []));

    assert.deepEqual(
      {
        windowedIsPartial: windowed.includes(SHARE_FILES_PARTIAL),
        windowedDoesNotClaimEmpty: !windowed.includes(SHARE_FILES_EMPTY),
        completeIsEmpty: complete.includes(SHARE_FILES_EMPTY),
        completeIsNotPartial: !complete.includes(SHARE_FILES_PARTIAL),
      },
      {
        windowedIsPartial: true,
        windowedDoesNotClaimEmpty: true,
        completeIsEmpty: true,
        completeIsNotPartial: true,
      },
    );
  } finally {
    // The read-only mount starts a run watcher and a share poll; both outlive the assertions and
    // would keep the test process alive after the file is done.
    conv?.dispose();
    conv?.composer.dispose();
    await vite.close();
  }
});
