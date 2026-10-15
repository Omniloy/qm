import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";
import type { PendingApproval } from "../src/core-bridge.ts";

test("the composer approval panel mounts legacy approvals with their old buttons and holds with the new card", async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div><div id="composer"></div>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async () => Response.json({ sessions: [] }),
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  let composer: ComposerSurface | undefined;
  try {
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { render, html } = await vite.ssrLoadModule("lit");
    const host = document.querySelector<HTMLElement>("#composer")!;
    const decided: unknown[] = [];
    const ctx = {
      pane: false,
      chat: {
        state: { agent: null, host, threadRef: "web:tester:t", resolvingApprovals: new Set<string>() },
        approvalSummaryView: (a: PendingApproval) =>
          html`<span class="approval-title">Approval needed</span><code>${a.command}</code>`,
        resolveCommandApproval: (decision: unknown) => decided.push(decision),
        redraw() {},
      },
    } as unknown as ConvCtx;
    composer = createComposerSurface(ctx) as ComposerSurface;
    const legacy: PendingApproval = { requestId: "legacy-1", command: "git push --force", reason: "force push" };
    const hold: PendingApproval = {
      requestId: "hold-1",
      command: "release quarantined skills output",
      securityHoldView: {
        title: "Paused: content from the browse skill",
        held: "content from the browse skill",
        subject: "browse",
        categoryLabel: "Credential request",
        explanation: "The security screen held back the browse skill's content.",
        facts: [{ label: "Source", value: "Skill browse · v28 · built-in" }],
        allowEffect: "The assistant gets this exact content once.",
        keepEffect: "The assistant stops here without it.",
      },
    };
    render(composer.composerApprovalPanel([legacy, hold]), host);
    const legacyCard = host.querySelector(".composer-approval")!;
    const labels = [...legacyCard.querySelectorAll("button")].map((b) => b.textContent?.trim());
    assert.match(legacyCard.textContent ?? "", /Approval needed/);
    assert.deepEqual(labels, ["Deny", "Allow once", "Allow for session", "Allow always"]);
    const holdCard = host.querySelector(".hold-card")!;
    assert.match(holdCard.textContent ?? "", /Paused: content from the browse skill/);
    assert.doesNotMatch(holdCard.textContent ?? "", /release quarantined|Deny/);
    [...legacyCard.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Deny")!.click();
    assert.deepEqual(decided, [{ requestId: "legacy-1", approved: false }]);
  } finally {
    composer?.dispose?.();
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
