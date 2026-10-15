import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { ApprovalDecision, PendingApproval } from "../src/core-bridge.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const globals = {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  customElements: dom.window.customElements,
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { render } = await import("lit");
const { pruneHoldUi, securityHoldCard, securityHoldMarker } = await import("../src/security-hold-card.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function holdApproval(requestId: string): PendingApproval {
  return {
    requestId,
    command: "release quarantined skills output",
    reason: "security screen flagged this skills output: credential handling",
    summary: "Blocked content preview: [skill id de98 · home org · owner built-in]",
    summaryDetail: "--- name: browse\n`cookies` returns the site's cookies as JSON, HttpOnly included.",
    securityHoldView: {
      title: "Paused: content from the browse skill",
      held: "content from the browse skill",
      subject: "browse",
      categoryLabel: "Credential request",
      explanation: "The security screen held back the browse skill's instructions before the assistant read it.",
      facts: [
        { label: "Source", value: "Skill browse · v28 · built-in, managed by the org" },
        { label: "Step", value: "Reading the skill's instructions" },
        { label: "Screening model's explanation (unverified)", value: "Describes collecting browser cookies." },
      ],
      evidence: "returns the site's cookies as JSON, HttpOnly included",
      allowEffect: "The assistant reads this content for this step only and carries on.",
      keepEffect: "The assistant stops here without the browse instructions.",
    },
  };
}

function mount(a: PendingApproval, report: (id: string, note: string) => Promise<void> = async () => {}) {
  const host = document.createElement("div");
  const decisions: ApprovalDecision[] = [];
  const draw = (): void => {
    render(
      securityHoldCard(a, a.securityHoldView!, {
        disabled: false,
        decide: (d) => decisions.push(d),
        report,
        redraw: draw,
      }),
      host,
    );
  };
  draw();
  return { host, decisions };
}

const buttonNamed = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

test("a security hold renders the structured card without the raw release command or header preview", () => {
  const { host } = mount(holdApproval("h1"));
  const text = host.textContent ?? "";
  assert.equal(host.querySelector(".hold-title b")?.textContent, "browse");
  assert.equal(host.querySelector(".hold-category")?.textContent, "Credential request");
  assert.match(text, /held back the browse skill's instructions/);
  assert.deepEqual(
    [...host.querySelectorAll(".hold-facts dt")].map((dt) => dt.textContent),
    ["Source", "Step", "Screening model's explanation (unverified)"],
  );
  assert.equal(
    host.querySelector(".hold-quote mark")?.textContent,
    "returns the site's cookies as JSON, HttpOnly included",
  );
  assert.match(text, /Text the screener flagged/);
  assert.match(text, /Allow once:.*carries on/);
  assert.match(text, /Keep blocked:.*without the browse instructions/);
  assert.doesNotMatch(text, /release quarantined/);
  assert.doesNotMatch(text, /Blocked content preview/);
  assert.equal(buttonNamed(host, "Deny"), undefined);
  assert.equal(buttonNamed(host, "Allow for session"), undefined);
  assert.equal(buttonNamed(host, "Allow always"), undefined);
});

test("Keep blocked denies and Allow once approves exactly once", () => {
  const { host, decisions } = mount(holdApproval("h2"));
  buttonNamed(host, "Keep blocked")!.click();
  buttonNamed(host, "Allow once")!.click();
  assert.deepEqual(decisions, [
    { requestId: "h2", approved: false },
    { requestId: "h2", approved: true, scope: "once" },
  ]);
});

test("Show what was blocked toggles the full blocked text", () => {
  const { host } = mount(holdApproval("h3"));
  assert.equal(host.querySelector(".hold-blocked"), null);
  buttonNamed(host, "Show what was blocked")!.click();
  assert.match(host.querySelector(".hold-blocked")?.textContent ?? "", /HttpOnly included/);
  buttonNamed(host, "Hide what was blocked")!.click();
  assert.equal(host.querySelector(".hold-blocked"), null);
});

test("reporting a false positive sends the note, keeps the choice open and hides the report link", async () => {
  const sent: Array<[string, string]> = [];
  const { host, decisions } = mount(holdApproval("h4"), async (id, note) => {
    sent.push([id, note]);
  });
  document.body.append(host);
  buttonNamed(host, "Looks wrong? Report a false positive")!.click();
  assert.match(host.querySelector(".hold-report label")?.textContent ?? "", /Why does this look wrong\? \(optional\)/);
  const textarea = host.querySelector<HTMLTextAreaElement>(".hold-report textarea")!;
  textarea.value = "our own built-in skill";
  textarea.dispatchEvent(new dom.window.Event("input"));
  host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await flush();
  assert.deepEqual(sent, [["h4", "our own built-in skill"]]);
  assert.match(
    host.querySelector(".hold-sent")?.textContent ?? "",
    /Saved for your admins to review as a possible false positive/,
  );
  assert.equal(host.querySelector(".hold-title")?.textContent, "Paused: content from the browse skill");
  assert.equal(host.querySelector(".hold-category")?.textContent, "Credential request");
  assert.equal(document.activeElement, host.querySelector(".hold-sent"), "focus moves to the saved status");
  assert.equal(buttonNamed(host, "Looks wrong? Report a false positive"), undefined);
  assert.ok(buttonNamed(host, "Allow once"), "the person still chooses after reporting");
  assert.deepEqual(decisions, []);
});

test("a failed report keeps the form open with an error", async () => {
  const { host } = mount(holdApproval("h5"), async () => {
    throw new Error("down");
  });
  buttonNamed(host, "Looks wrong? Report a false positive")!.click();
  host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await flush();
  assert.match(host.querySelector(".hold-report-error")?.textContent ?? "", /Could not send the report/);
  assert.equal(host.querySelector(".hold-sent"), null);
});

test("the transcript marker shows only the hold heading", () => {
  const host = document.createElement("div");
  render(securityHoldMarker(holdApproval("h6").securityHoldView!), host);
  assert.equal(host.querySelector(".hold-title")?.textContent, "Paused: content from the browse skill");
  assert.equal(host.querySelector("button"), null);
});

test("the toggles expose their expanded state and the report form takes focus", async () => {
  const { host } = mount(holdApproval("h7"));
  document.body.append(host);
  const show = buttonNamed(host, "Show what was blocked")!;
  assert.equal(show.getAttribute("aria-expanded"), "false");
  show.click();
  assert.equal(buttonNamed(host, "Hide what was blocked")!.getAttribute("aria-expanded"), "true");
  const report = buttonNamed(host, "Looks wrong? Report a false positive")!;
  assert.equal(report.getAttribute("aria-expanded"), "false");
  report.click();
  await flush();
  assert.equal(buttonNamed(host, "Looks wrong? Report a false positive")!.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, host.querySelector(".hold-report textarea"));
  host.remove();
});

test("hold UI state is pruned once an approval is no longer pending", () => {
  const { host } = mount(holdApproval("h8"));
  buttonNamed(host, "Show what was blocked")!.click();
  pruneHoldUi([]);
  const again = mount(holdApproval("h8"));
  assert.equal(again.host.querySelector(".hold-blocked"), null, "a resolved hold starts fresh");
});
