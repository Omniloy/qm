import test from "node:test";
import assert from "node:assert/strict";
import {
  browserAction,
  browserById,
  browserTabs,
  connectDraft,
  extensionNote,
  extensionState,
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

test("the tabs are the catalog core sent, with no built-in prepended", () => {
  const tabs = browserTabs([ANCHOR, KERNEL], null);
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    ["anchor", "kernel"],
  );
  assert.doesNotMatch(tabs.map((tab) => tab.id).join(","), /built-in/);
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

test("an active provider that has since disappeared falls back to the first tab", () => {
  // A provider doc can be removed while someone still has it selected; the card
  // must not open on a tab that is not there.
  assert.equal(initialBrowserTab([KERNEL], "anchor"), "kernel");
});

test("with no browser connected at all, there is no tab to open on", () => {
  // The built-in browser used to be the guaranteed fallback. With it gone, a
  // person who has connected nothing has an empty picker and an empty state.
  assert.deepEqual(browserTabs([], null), []);
  assert.equal(initialBrowserTab([], null), null);
});

test("the button offers the one thing that tab can do", () => {
  const tabs = browserTabs([ANCHOR, KERNEL], null);
  assert.deepEqual(browserAction(tabs[0]!), { kind: "use", label: "Use Anchor" });
  assert.deepEqual(browserAction(tabs[1]!), { kind: "connect", label: "Connect Kernel" });
  // The live one says so rather than offering to switch to itself.
  assert.deepEqual(browserAction(browserTabs([ANCHOR], "anchor")[0]!), { kind: "in-use" });
});

test("a connected provider is never asked for its key again", () => {
  const [anchorTab] = browserTabs([ANCHOR], null);
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

test("a browser that is not in the catalog has nothing to connect", () => {
  assert.equal(browserById([ANCHOR], "gone"), undefined);
  assert.equal(connectDraft(browserById([ANCHOR], "gone")), null);
});

const EXTENSION: BrowserProvider = {
  id: "extension",
  name: "Your Chrome",
  summary: "Drive one tab in your own browser.",
  keyEnv: "",
  keyService: "",
  connected: false,
};

test("the extension is chosen, not key-dropped, even when not attached", async () => {
  const { browserAction, browserTabs, connectDraft, isExtensionTab } = await import("../src/browser-picker-state.ts");
  const [extTab] = browserTabs([EXTENSION], null);
  // A detached extension still offers "use": the person selects it, then pairs.
  assert.deepEqual(browserAction(extTab!), { kind: "use", label: "Use my Chrome" });
  // Nothing to paste — pairing is a token, not a stored secret.
  assert.equal(connectDraft(EXTENSION), null);
  assert.equal(isExtensionTab("extension"), true);
  assert.equal(isExtensionTab("anchor"), false);
});

test("a connected extension with no shared tab reads as neither ready nor absent", () => {
  const provider = { id: "extension", name: "Your Chrome", summary: "", keyEnv: "", keyService: "", connected: true };

  assert.deepEqual(extensionState(provider), { kind: "idle" });
  const note = extensionNote(extensionState(provider));
  assert.equal(note.tone, "warning");
  assert.match(note.text, /no tab is shared/);
});

test("a shared tab is named, so the card answers which one", () => {
  const provider = {
    id: "extension",
    name: "Your Chrome",
    summary: "",
    keyEnv: "",
    keyService: "",
    connected: true,
    sharing: true,
    sharedTabTitle: "Gmail",
  };

  assert.deepEqual(extensionState(provider), { kind: "sharing", tab: "Gmail" });
  assert.equal(extensionNote(extensionState(provider)).tone, "ok");
  assert.match(extensionNote(extensionState(provider)).text, /Gmail/);
});

test("sharing without a title still reads as sharing", () => {
  const provider = {
    id: "extension",
    name: "Your Chrome",
    summary: "",
    keyEnv: "",
    keyService: "",
    connected: true,
    sharing: true,
  };

  assert.deepEqual(extensionState(provider), { kind: "sharing", tab: "a tab" });
});

test("an absent extension keeps the install instructions", () => {
  const provider = { id: "extension", name: "Your Chrome", summary: "", keyEnv: "", keyService: "" };

  assert.deepEqual(extensionState(provider), { kind: "absent" });
  assert.equal(extensionNote(extensionState(provider)).tone, "neutral");
});

test("a stale sharing flag cannot outlive the connection", () => {
  const provider = {
    id: "extension",
    name: "Your Chrome",
    summary: "",
    keyEnv: "",
    keyService: "",
    connected: false,
    sharing: true,
  };

  assert.deepEqual(extensionState(provider), { kind: "absent" }, "no socket means nothing is shared");
});
