import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_BROWSER_ID,
  browserAction,
  browserById,
  browserTabs,
  connectDraft,
  initialBrowserTab,
  type BrowserProvider,
} from "../src/browser-picker-state.ts";

const ANCHOR: BrowserProvider = {
  id: "anchor",
  name: "Anchor",
  summary: "Hosted Chrome with stealth.",
  keyEnv: "ANCHOR_API_KEY",
  keyService: "anchor",
  profileEnv: "ANCHOR_PROFILE",
  profileService: "anchor-profile",
  signupUrl: "https://app.anchorbrowser.io/api-keys",
  connected: true,
};
const KERNEL: BrowserProvider = {
  id: "kernel",
  name: "Kernel",
  summary: "Hosted browsers.",
  keyEnv: "KERNEL_API_KEY",
  keyService: "kernel",
  connected: false,
};

test("the built-in browser always leads and never needs connecting", () => {
  const tabs = browserTabs([ANCHOR, KERNEL], BUILT_IN_BROWSER_ID);
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    [BUILT_IN_BROWSER_ID, "anchor", "kernel"],
  );
  assert.equal(tabs[0]!.connected, true);
  assert.equal(tabs[0]!.active, true);
});

test("exactly one tab is live, and it is the one core reported", () => {
  const tabs = browserTabs([ANCHOR, KERNEL], "anchor");
  assert.deepEqual(
    tabs.filter((tab) => tab.active).map((tab) => tab.id),
    ["anchor"],
  );
});

test("the card opens on the browser in use, so it answers that first", () => {
  assert.equal(initialBrowserTab([ANCHOR, KERNEL], "anchor"), "anchor");
});

test("an active provider that has since disappeared falls back to built-in", () => {
  // A provider doc can be removed while someone still has it selected; the card
  // must not open on a tab that is not there.
  assert.equal(initialBrowserTab([KERNEL], "anchor"), BUILT_IN_BROWSER_ID);
});

test("the button offers the one thing that tab can do", () => {
  const tabs = browserTabs([ANCHOR, KERNEL], BUILT_IN_BROWSER_ID);
  assert.deepEqual(browserAction(tabs[0]!), { kind: "in-use" });
  assert.deepEqual(browserAction(tabs[1]!), { kind: "use", label: "Use Anchor" });
  assert.deepEqual(browserAction(tabs[2]!), { kind: "connect", label: "Connect Kernel" });
});

test("a connected provider is never asked for its key again", () => {
  const [, anchorTab] = browserTabs([ANCHOR], BUILT_IN_BROWSER_ID);
  assert.notEqual(browserAction(anchorTab!).kind, "connect");
});

test("connecting asks for the key and nothing else", () => {
  const draft = connectDraft(ANCHOR)!;
  assert.equal(draft.service, "anchor");
  assert.equal(draft.envKey, "ANCHOR_API_KEY");
  // Anchor keeps a profile, but naming it is not a decision anyone wants to
  // make, and a second required field is how the whole paste fails.
  assert.deepEqual(
    draft.fields?.map((f) => [f.key, f.secret]),
    [["ANCHOR_API_KEY", true]],
  );
  assert.match(draft.purpose, /Anchor/);
});

test("a provider without a profile also asks only for its key", () => {
  const draft = connectDraft(KERNEL)!;
  assert.deepEqual(
    draft.fields?.map((f) => f.key),
    ["KERNEL_API_KEY"],
  );
});

test("the built-in browser has nothing to connect", () => {
  assert.equal(connectDraft(browserById([ANCHOR], BUILT_IN_BROWSER_ID)), null);
});
