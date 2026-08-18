/**
 * The share feature is actually connected to the chat.
 *
 * These are source-level assertions on purpose. The previous round of this feature shipped a
 * complete, well-tested `shareStrip()` that nothing called, a dialog nothing opened, and a CSS
 * class nothing defined — every unit test passed and the feature was invisible. What follows is
 * the set of connections that were missing, each pinned so that deleting one fails the build
 * rather than quietly un-shipping the feature again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const chat = read("src/chat.ts");
const css = read("src/shell.css");

test("the strip has a caller, and it is the draw path both viewers go through", () => {
  assert.match(chat, /function shareStripBanner\(\)/);
  assert.match(chat, /shareStrip\(chatState\.shares\)/, "the strip is derived from the conversation's live links");
  // drawActiveChat (the one you type into) and the read-only draw. A member sitting in a Slack-
  // backed conversation is published by the link exactly like anyone else.
  const rendered = [...chat.matchAll(/\$\{shareStripBanner\(\)\}/g)].length;
  assert.ok(rendered >= 2, `shareStripBanner is rendered ${rendered} times; both draw paths need it`);
});

test("the strip has a data source, and it is core through the web-ui relay", () => {
  assert.match(chat, /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/share/);
  assert.match(chat, /function loadShareLinks/);
  // Every viewer of the conversation reads it, not only the person who minted: the read is keyed
  // on the session, and the only input is chatState.sessionId.
  assert.match(chat, /syncShareLinks\(\);/);
});

test("the strip goes live for someone already sitting in the conversation", () => {
  // The window the strip exists for is the minute after a colleague mints, which a mount-time
  // read alone would miss entirely.
  assert.match(chat, /SHARE_POLL_MS\s*=\s*30_000/);
  assert.match(chat, /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?loadShareLinks\(chatState\.sessionId\)/);
  assert.match(chat, /clearInterval\(sharePoll\)/, "the poll must stop when the surface is disposed");
});

test("the strip is not dismissable and carries the action that ends it", () => {
  assert.ok(!/share-strip-dismiss|share-strip-close/.test(chat), "the state it reports is standing, not an event");
  assert.match(chat, /class="share-strip-action"/);
  assert.match(chat, /revokeFromStrip\(/);
});

test("the Share action is wired to a dialog that mints, copies and revokes", () => {
  assert.match(chat, /function shareButton\(\)/);
  assert.match(chat, /openShareDialog\(sessionId, e\.currentTarget as HTMLElement\)/);
  assert.match(chat, /function shareDialogTpl\(\)/);
  for (const call of [
    "mintShareLink(sessionId, false)",
    "mintShareLink(sessionId, true)",
    "revokeShareLinks(sessionId)",
  ]) {
    assert.ok(chat.includes(call), `the dialog must offer ${call}`);
  }
  assert.match(chat, /copyShareLink\(view\.url!\)/);
  // The dialog is rendered where it can be seen, from both draw paths.
  assert.ok([...chat.matchAll(/\$\{shareDialogTpl\(\)\}/g)].length >= 2);
});

test("opening the dialog moves focus into it, so its Escape and Tab handling is reachable", () => {
  // trapDialogFocus hangs off the dialog element. Leaving focus on the button that opened the
  // dialog is the difference between a focus trap and a decorative keydown handler: Escape would
  // not close, Tab would walk straight out into the transcript behind the backdrop.
  assert.match(chat, /focusDialogCancel\(document\)/);
  assert.match(chat, /data-dialog-cancel/, "focusDialogCancel has nothing to find without this hook");
  assert.match(chat, /restoreDialogFocus\(opener/, "and focus goes back to the opener when it shuts");
});

test("the dialog's words come from share-state.ts, not from chat.ts", () => {
  // The copy is the consent. It is asserted verbatim in test/share-state.test.ts, which is worth
  // nothing if the dialog hand-writes its own sentences beside it.
  assert.match(chat, /from "\.\/share-state"/);
  for (const banned of ["Anyone with this link", "Create link", "Turn off link", "Copy link"]) {
    assert.ok(!chat.includes(`>${banned}<`), `chat.ts hardcodes the string "${banned}" instead of importing it`);
  }
});

test("every class the share surfaces render has a rule in shell.css", () => {
  for (const cls of [
    ".share-strip",
    ".share-strip-text",
    ".share-strip-action",
    ".chat-float-actions",
    ".share-dialog",
    ".share-dialog-bullets",
    ".share-dialog-url",
    ".share-dialog-error",
    ".share-page",
    ".share-head",
    ".share-access",
    ".share-scroll",
    ".share-foot",
    ".share-dead",
  ]) {
    assert.ok(css.includes(`${cls} {`) || css.includes(`${cls},`), `shell.css has no rule for ${cls}`);
  }
});

test("the strip takes a grid row instead of collapsing the transcript", () => {
  // .custom-chat-shell is a two-row grid; an extra flow child without a matching row would hand
  // the transcript's minmax(0, 1fr) to the strip and leave the scroller unscrollable.
  assert.match(css, /\.custom-chat-shell:has\(> \.share-strip\) \{\s*grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.readonly-chat \.custom-chat-shell:has\(> \.share-strip\)/);
});
