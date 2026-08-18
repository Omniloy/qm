import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARE_BULLETS,
  SHARE_BULLET_CAUTION,
  SHARE_BULLET_CONTENTS,
  SHARE_BULLET_LIVE,
  SHARE_BULLET_NO_EXPIRY,
  SHARE_CREATE_AGAIN_LABEL,
  SHARE_CREATE_FAILED,
  SHARE_CREATE_LABEL,
  SHARE_CREATING_LABEL,
  SHARE_FILES_EMPTY,
  SHARE_FILES_HEADING,
  SHARE_FILES_PARTIAL,
  SHARE_INTRO,
  SHARE_OFFLINE,
  SHARE_RATE_LIMITED,
  SHARE_REPLACE_LABEL,
  SHARE_REPLACE_NOTE,
  SHARE_REVOKED_NOTICE,
  SHARE_REVOKE_FAILED,
  SHARE_STRIP_ANONYMOUS_SHARER,
  SHARE_TITLE,
  SHARE_TURNING_OFF_LABEL,
  SHARE_TURN_OFF_LABEL,
  SHARE_UNSURE,
  formatShareFileSize,
  initialShareState,
  isShareBusy,
  shareAgo,
  shareDialogView,
  shareFailureEvent,
  shareFileLabel,
  shareLinkOf,
  shareLinkUrl,
  sharePagePath,
  shareReducer,
  shareStrip,
  shareViewSummary,
  sharerName,
  type ShareEvent,
  type ShareLinkView,
  type ShareState,
} from "../plugins/web-ui/src/share-state.ts";

const SHARE_ID = "6f1d4b0e-2c4a-4a58-9d3b-0f5e1a2b3c4d" + "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
const ORIGIN = "https://qm.omniloy.com";
const NOW = 1_760_000_000_000;

// No token. The share id IS the secret and core mints nothing beside it, so the fixture that
// used to hard-code `token: "hdr.body.sig"` was exercising a wire shape that does not exist —
// and hid the fact that the Copy button could never render for a real link.
const LINK: ShareLinkView = {
  shareId: SHARE_ID,
  createdAt: NOW - 3 * 60 * 60_000,
  viewCount: 3,
  lastViewedAt: NOW - 2 * 60 * 60_000,
  sharerLabel: "Dana Ruiz",
};

const view = (state: ShareState) => shareDialogView(state, { origin: ORIGIN, now: NOW });
const run = (start: ShareState, events: ShareEvent[]): ShareState => events.reduce(shareReducer, start);

// ------------------------------------------------------------------ the copy

test("the dialog says the link is live and says whose messages it publishes", () => {
  assert.equal(
    SHARE_BULLET_LIVE,
    "It stays live. Messages sent after you share — by you or by anyone else in this conversation — become visible to everyone holding the link.",
  );
  // The whole point of the sentence: it is not only about the sharer's own words.
  assert.ok(SHARE_BULLET_LIVE.includes("anyone else in this conversation"));
});

test("the dialog says attachments are shared, and never claims file contents are withheld", () => {
  assert.equal(
    SHARE_BULLET_CONTENTS,
    "Messages and every attached file are shared — including files the agent creates from command output. Tool calls, command output, and thinking are not shown in the transcript.",
  );
  assert.ok(SHARE_BULLET_CONTENTS.includes("every attached file are shared"));
  assert.ok(SHARE_BULLET_CONTENTS.includes("files the agent creates from command output"));
});

test("no shipped sentence contradicts what the feature actually does", () => {
  // Each of these was true of some draft of this feature and is false of the
  // one that ships. A copy edit that reintroduces any of them fails here rather
  // than misleading somebody into publishing a database dump.
  const lies = [
    "file contents are not",
    "file contents aren't",
    "files are not shared",
    "files aren't shared",
    "attachments are not",
    "attachments aren't",
    "only messages are shared",
    "only the messages",
    "snapshot",
    "frozen",
    "as it looks now",
    "expires in",
    "expires after",
    "read-only copy",
  ];
  const shipped = [
    SHARE_TITLE,
    SHARE_INTRO,
    ...SHARE_BULLETS,
    SHARE_FILES_HEADING,
    SHARE_FILES_EMPTY,
    SHARE_REVOKED_NOTICE,
    SHARE_CREATE_FAILED,
    SHARE_REVOKE_FAILED,
  ].join("\n");
  for (const lie of lies) {
    assert.ok(!shipped.toLowerCase().includes(lie), `shipped copy must not claim "${lie}"`);
  }
});

test("the bullets are all present before anyone touches anything", () => {
  const bullets = view({ kind: "off" }).bullets;
  assert.deepEqual(bullets, [SHARE_BULLET_LIVE, SHARE_BULLET_CONTENTS, SHARE_BULLET_NO_EXPIRY, SHARE_BULLET_CAUTION]);
  // Not behind a disclosure, not after minting: on the screen that still has a
  // Create button, which is the only screen where the warning can change a mind.
  assert.equal(view({ kind: "off" }).buttons.create?.label, SHARE_CREATE_LABEL);
});

test("revocation reads as immediate and total", () => {
  assert.equal(SHARE_REVOKED_NOTICE, "Link turned off. It stopped working immediately.");
  assert.equal(view({ kind: "revoked" }).status, SHARE_REVOKED_NOTICE);
});

test("the file list never claims a completeness it does not have", () => {
  // The dialog builds the list from the messages loaded in this tab. With earlier turns still
  // unfetched, "no files are attached yet" would be a reassurance nothing can support.
  assert.equal(
    SHARE_FILES_PARTIAL,
    "This is what's loaded so far. Earlier messages in this conversation may have attachments too, and they are shared as well.",
  );
  assert.ok(SHARE_FILES_PARTIAL.includes("they are shared as well"));
});

test("the exposure is listed before minting, not after", () => {
  assert.equal(view({ kind: "off" }).showFiles, true);
  assert.equal(view({ kind: "creating" }).showFiles, true);
  assert.equal(view({ kind: "on", link: LINK }).showFiles, false);
});

// ------------------------------------------------------------- the transitions

test("the happy path: open, see there is no link, create one", () => {
  const state = run(initialShareState, [{ kind: "open" }, { kind: "loaded", link: null }, { kind: "create" }]);
  assert.equal(state.kind, "creating");
  assert.equal(isShareBusy(state), true);
  assert.equal(view(state).buttons.create?.label, SHARE_CREATING_LABEL);
  assert.equal(view(state).buttons.create?.disabled, true);

  const done = shareReducer(state, { kind: "created", link: LINK });
  assert.deepEqual(done, { kind: "on", link: LINK });
  assert.equal(isShareBusy(done), false);
});

test("opening on a conversation that is already shared lands on the live link", () => {
  const state = run(initialShareState, [{ kind: "open" }, { kind: "loaded", link: LINK }]);
  assert.deepEqual(state, { kind: "on", link: LINK });
});

test("a failed create says nothing was shared, and offers the button again", () => {
  const state = run(initialShareState, [
    { kind: "open" },
    { kind: "loaded", link: null },
    { kind: "create" },
    { kind: "failed", message: SHARE_CREATE_FAILED, retryable: true },
  ]);
  assert.deepEqual(state, { kind: "off", error: SHARE_CREATE_FAILED });
  assert.equal(view(state).error, SHARE_CREATE_FAILED);
  assert.equal(view(state).buttons.create?.disabled, false);
  assert.ok(SHARE_CREATE_FAILED.includes("Nothing has been shared"));
});

test("a refusal from core is shown in core's own words with no retry", () => {
  const refusal = "You are not a participant in this conversation.";
  const state = run(initialShareState, [
    { kind: "open" },
    { kind: "loaded", link: null },
    { kind: "create" },
    { kind: "failed", message: refusal, retryable: false },
  ]);
  assert.deepEqual(state, { kind: "unavailable", message: refusal });
  const rendered = view(state);
  assert.equal(rendered.error, refusal);
  assert.deepEqual(rendered.buttons, {});
});

test("a failed revoke says the link is still live and keeps it on screen", () => {
  const state = run({ kind: "on", link: LINK }, [
    { kind: "revoke" },
    { kind: "failed", message: SHARE_REVOKE_FAILED, retryable: true },
  ]);
  assert.deepEqual(state, { kind: "on", link: LINK, error: SHARE_REVOKE_FAILED });
  assert.ok(SHARE_REVOKE_FAILED.includes("still live"));
  // The link is still real, so Copy and Turn off are still offered.
  assert.equal(view(state).url, `${ORIGIN}/share/${SHARE_ID}`);
  assert.equal(view(state).buttons.turnOff?.label, SHARE_TURN_OFF_LABEL);
});

test("revoking walks through a busy label and ends on the dead-link confirmation", () => {
  const busy = shareReducer({ kind: "on", link: LINK }, { kind: "revoke" });
  assert.deepEqual(busy, { kind: "revoking", link: LINK });
  assert.equal(view(busy).buttons.turnOff?.label, SHARE_TURNING_OFF_LABEL);
  assert.equal(view(busy).buttons.turnOff?.disabled, true);

  const done = shareReducer(busy, { kind: "revoked" });
  assert.deepEqual(done, { kind: "revoked" });
  assert.equal(view(done).buttons.create?.label, SHARE_CREATE_AGAIN_LABEL);
});

test("after turning off, creating again is allowed", () => {
  const state = run({ kind: "on", link: LINK }, [{ kind: "revoke" }, { kind: "revoked" }, { kind: "create" }]);
  assert.equal(state.kind, "creating");
});

test("replacing swaps the link and never leaves the old one on screen", () => {
  const busy = shareReducer({ kind: "on", link: LINK }, { kind: "replace" });
  assert.deepEqual(busy, { kind: "replacing", link: LINK });
  const next: ShareLinkView = { ...LINK, shareId: SHARE_ID.replace("6f1d", "aaaa"), viewCount: 0 };
  const done = shareReducer(busy, { kind: "replaced", link: next });
  assert.deepEqual(done, { kind: "on", link: next });
  assert.equal(view(done).url, `${ORIGIN}/share/${next.shareId}`);
});

test("a replace that fails admits we do not know which link is live", () => {
  // Revoke-and-remint that broke halfway could have landed the revoke, or not.
  // Guessing in the reassuring direction is how someone believes a link is dead.
  const state = run({ kind: "on", link: LINK }, [
    { kind: "replace" },
    { kind: "failed", message: "boom", retryable: true },
  ]);
  assert.deepEqual(state, { kind: "unsure", message: SHARE_UNSURE });
  assert.equal(view(state).buttons.checkAgain?.disabled, false);
  assert.deepEqual(view(state).bullets, []);
});

test("a failed load never pretends the conversation is unshared", () => {
  const state = run(initialShareState, [{ kind: "open" }, { kind: "failed", message: "gone", retryable: true }]);
  assert.deepEqual(state, { kind: "unsure", message: SHARE_UNSURE });
  // Specifically not "off": an "off" screen offers Create, which would mint a
  // second link on a conversation that already has one.
  assert.equal(view(state).buttons.create, undefined);
});

test("checking again after an unsure state goes back through loading", () => {
  const state = run({ kind: "unsure", message: SHARE_UNSURE }, [{ kind: "open" }, { kind: "loaded", link: LINK }]);
  assert.deepEqual(state, { kind: "on", link: LINK });
});

test("closing forgets everything, from every state", () => {
  const states: ShareState[] = [
    { kind: "closed" },
    { kind: "loading" },
    { kind: "off" },
    { kind: "off", error: SHARE_CREATE_FAILED },
    { kind: "creating" },
    { kind: "on", link: LINK },
    { kind: "on", link: LINK, error: SHARE_REVOKE_FAILED },
    { kind: "replacing", link: LINK },
    { kind: "revoking", link: LINK },
    { kind: "revoked" },
    { kind: "unsure", message: SHARE_UNSURE },
    { kind: "unavailable", message: "nope" },
  ];
  for (const state of states) {
    assert.deepEqual(shareReducer(state, { kind: "close" }), { kind: "closed" }, state.kind);
  }
});

test("an in-flight request is not restarted by reopening", () => {
  for (const state of [
    { kind: "creating" } as ShareState,
    { kind: "revoking", link: LINK } as ShareState,
    { kind: "replacing", link: LINK } as ShareState,
    { kind: "loading" } as ShareState,
  ]) {
    assert.deepEqual(shareReducer(state, { kind: "open" }), state);
  }
});

test("events that do not belong to the current state are ignored", () => {
  const off: ShareState = { kind: "off" };
  assert.deepEqual(shareReducer(off, { kind: "created", link: LINK }), off);
  assert.deepEqual(shareReducer(off, { kind: "revoke" }), off);
  assert.deepEqual(shareReducer(off, { kind: "replace" }), off);
  assert.deepEqual(shareReducer(off, { kind: "revoked" }), off);
  const on: ShareState = { kind: "on", link: LINK };
  assert.deepEqual(shareReducer(on, { kind: "create" }), on);
  assert.deepEqual(shareReducer(on, { kind: "replaced", link: LINK }), on);
  assert.deepEqual(shareReducer({ kind: "unavailable", message: "x" }, { kind: "create" }), {
    kind: "unavailable",
    message: "x",
  });
});

test("dismissing an error clears the error and nothing else", () => {
  assert.deepEqual(shareReducer({ kind: "off", error: "x" }, { kind: "dismiss-error" }), { kind: "off" });
  assert.deepEqual(shareReducer({ kind: "on", link: LINK, error: "x" }, { kind: "dismiss-error" }), {
    kind: "on",
    link: LINK,
  });
  assert.deepEqual(shareReducer({ kind: "on", link: LINK }, { kind: "dismiss-error" }), { kind: "on", link: LINK });
});

test("a failure in flight never loses the link it was acting on", () => {
  const state = run({ kind: "on", link: LINK }, [{ kind: "revoke" }]);
  assert.deepEqual(shareLinkOf(state), LINK);
  assert.deepEqual(shareLinkOf({ kind: "off" }), null);
  assert.deepEqual(shareLinkOf({ kind: "revoked" }), null);
});

// ---------------------------------------------------------- failures from HTTP

test("HTTP failures become retryable or refused on the right side of the line", () => {
  assert.deepEqual(shareFailureEvent(0), { kind: "failed", message: SHARE_OFFLINE, retryable: true });
  assert.deepEqual(shareFailureEvent(429), { kind: "failed", message: SHARE_RATE_LIMITED, retryable: true });
  assert.equal(shareFailureEvent(503).retryable, true);
  assert.equal(shareFailureEvent(500, { error: "upstream down" }).message, "upstream down");

  const refused = shareFailureEvent(403, { error: "sharing is off for this project" });
  assert.deepEqual(refused, { kind: "failed", message: "sharing is off for this project", retryable: false });

  // Core puts the machine code in `error` and the sentence in `message`. Reading `error` first
  // rendered the word "forbidden" as the entire explanation of a refusal nobody could retry.
  const forbidden = shareFailureEvent(403, {
    error: "forbidden",
    message: "you are no longer a member of this project, so you cannot share its conversations",
  });
  assert.equal(forbidden.message, "you are no longer a member of this project, so you cannot share its conversations");
  assert.equal(
    shareFailureEvent(503, { error: "not_configured", message: "shared links are not enabled here" }).message,
    "shared links are not enabled here",
  );
  assert.equal(shareFailureEvent(404, { error: "not_found", message: "  " }).message, "not_found");
  // Flag off and a bad share id both arrive as 404, deliberately identical.
  assert.equal(shareFailureEvent(404).retryable, false);
  assert.equal(shareFailureEvent(404).message, SHARE_CREATE_FAILED);
  assert.equal(shareFailureEvent(404, { error: "   " }).message, SHARE_CREATE_FAILED);
  assert.equal(shareFailureEvent(404, null, "custom").message, "custom");
  assert.equal(shareFailureEvent(400, { error: 7 }, "custom").message, "custom");
});

// ----------------------------------------------------------------- the URL

test("the copyable link is origin + /share/<id>, with no query at all", () => {
  assert.equal(shareLinkUrl(ORIGIN, LINK), `${ORIGIN}/share/${SHARE_ID}`);
  assert.equal(shareLinkUrl(`${ORIGIN}/`, LINK), `${ORIGIN}/share/${SHARE_ID}`);
  assert.equal(sharePagePath(LINK), `/share/${SHARE_ID}`);
  assert.ok(!shareLinkUrl(ORIGIN, LINK)!.includes("?"), "there is no capability token to carry");
});

test("core's own url wins over the browser's origin, because only core knows the public base", () => {
  // Behind a portal the host the sharer is on need not be the host a stranger can reach.
  const fromCore = { ...LINK, url: `https://public.example/share/${SHARE_ID}` };
  assert.equal(shareLinkUrl(ORIGIN, fromCore), `https://public.example/share/${SHARE_ID}`);
  // ...but only when it actually addresses this link. A url for some other id is ignored.
  assert.equal(
    shareLinkUrl(ORIGIN, { ...LINK, url: "https://public.example/share/other" }),
    `${ORIGIN}/share/${SHARE_ID}`,
  );
  assert.equal(shareLinkUrl(ORIGIN, { ...LINK, url: `javascript:/share/${SHARE_ID}` }), `${ORIGIN}/share/${SHARE_ID}`);
});

test("a link that cannot be built is null rather than half-built", () => {
  // A half-built URL gets pasted, 404s for the recipient, and the sharer thinks
  // they shared something.
  assert.equal(shareLinkUrl(ORIGIN, { shareId: "short" }), null);
  assert.equal(shareLinkUrl(ORIGIN, { shareId: `${SHARE_ID}/../sessions` }), null);
  assert.equal(shareLinkUrl("javascript:alert(1)", LINK), null);
  assert.equal(shareLinkUrl("https://host/base", LINK), null);
});

test("every live link offers Copy — including one a colleague minted", () => {
  // The regression this pins: Copy used to be conditional on a `token` field core never sends,
  // so the primary action of the dialog could not render even one second after Create link.
  const rendered = view({ kind: "on", link: LINK });
  assert.equal(rendered.url, `${ORIGIN}/share/${SHARE_ID}`);
  assert.equal(rendered.buttons.copy?.disabled, false);
  assert.equal(rendered.note, SHARE_REPLACE_NOTE);
  const theirs = view({ kind: "on", link: { ...LINK, mine: false, sharerLabel: "Priya Raman" } });
  assert.equal(theirs.buttons.copy?.disabled, false);
  // Turning it off is offered to any member, which is what makes the strip's action honest.
  assert.equal(theirs.buttons.turnOff?.label, SHARE_TURN_OFF_LABEL);
});

// ---------------------------------------------------------------- the strip

test("no live link means no strip", () => {
  assert.deepEqual(shareStrip([]), { visible: false, text: "", dismissable: false, action: null });
});

test("a live link puts a permanent notice in front of everyone in the room", () => {
  const strip = shareStrip([LINK]);
  assert.equal(strip.visible, true);
  assert.equal(strip.text, "Publicly shared by Dana Ruiz · anyone with the link can read this");
  assert.equal(strip.dismissable, false);
  assert.deepEqual(strip.action, { kind: "revoke", label: SHARE_TURN_OFF_LABEL });
});

test("a participant who did not mint the link is told, and can end it", () => {
  // The person the strip is really for. They were never shown the dialog, they did not consent to
  // anything, and the next message they type is published — so the notice is theirs as much as the
  // minter's, and so is the way out of it.
  const theirs: ShareLinkView = { ...LINK, mine: false, sharerLabel: "Priya Raman" };
  const strip = shareStrip([theirs]);
  assert.equal(strip.visible, true);
  assert.equal(strip.text, "Publicly shared by Priya Raman · anyone with the link can read this");
  assert.deepEqual(strip.action, { kind: "revoke", label: SHARE_TURN_OFF_LABEL });
  assert.equal(strip.dismissable, false);
});

test("the strip reads the same for the sharer and for everyone else", () => {
  // It is derived from the link alone; there is no viewer input that could turn
  // it off for the people whose next message it publishes.
  assert.equal(shareStrip([LINK]).text, shareStrip([LINK], { canRevoke: true }).text);
});

test("a second link is counted rather than hidden", () => {
  const older: ShareLinkView = { ...LINK, shareId: `${SHARE_ID}x`, createdAt: LINK.createdAt - 1000 };
  const newer: ShareLinkView = { ...LINK, shareId: `${SHARE_ID}y`, sharerLabel: "Priya Raman" };
  assert.equal(
    shareStrip([older, newer]).text,
    "Publicly shared by Priya Raman and 1 other · anyone with the link can read this",
  );
  assert.equal(
    shareStrip([older, newer, { ...older, shareId: `${SHARE_ID}z` }]).text,
    "Publicly shared by Priya Raman and 2 others · anyone with the link can read this",
  );
});

test("the strip never prints an identifier where a name should be", () => {
  // The house `displayName || id` idiom would put alice@company.com onto a page
  // strangers can open. Every id-shaped label falls back instead.
  for (const label of [null, "", "   ", "alice@company.com", "web:alice:1234", "personal:alice"]) {
    const strip = shareStrip([{ ...LINK, sharerLabel: label }]);
    assert.equal(strip.text, `Publicly shared by ${SHARE_STRIP_ANONYMOUS_SHARER} · anyone with the link can read this`);
    assert.ok(!strip.text.includes("@"));
  }
  assert.equal(sharerName("Dana Ruiz"), "Dana Ruiz");
  assert.equal(sharerName(undefined), SHARE_STRIP_ANONYMOUS_SHARER);
});

test("a viewer who may not revoke still sees the notice", () => {
  const strip = shareStrip([LINK], { canRevoke: false });
  assert.equal(strip.visible, true);
  assert.equal(strip.action, null);
  assert.equal(strip.dismissable, false);
});

// ------------------------------------------------------------------- numbers

test("the view counter says whether the link is actually being used", () => {
  assert.equal(shareViewSummary({ ...LINK, viewCount: 0, lastViewedAt: undefined }, NOW), "Not opened yet");
  assert.equal(shareViewSummary({ ...LINK, viewCount: 1 }, NOW), "Opened once · last 2h ago");
  assert.equal(shareViewSummary(LINK, NOW), "Opened 3 times · last 2h ago");
  assert.equal(shareViewSummary({ ...LINK, lastViewedAt: undefined }, NOW), "Opened 3 times");
  assert.equal(view({ kind: "on", link: LINK }).status, "Opened 3 times · last 2h ago");
});

test("ages are coarse and never negative", () => {
  assert.equal(shareAgo(NOW, NOW), "just now");
  assert.equal(shareAgo(NOW + 5000, NOW), "just now");
  assert.equal(shareAgo(NOW - 90_000, NOW), "1m ago");
  assert.equal(shareAgo(NOW - 3 * 60 * 60_000, NOW), "3h ago");
  assert.equal(shareAgo(NOW - 3 * 24 * 60 * 60_000, NOW), "3d ago");
});

test("file rows name the file and its size", () => {
  assert.equal(shareFileLabel({ name: "debug.log", sizeBytes: 12_698 }), "debug.log · 12.4 KB");
  assert.equal(shareFileLabel({ name: "notes.md" }), "notes.md");
  assert.equal(formatShareFileSize(0), "0 B");
  assert.equal(formatShareFileSize(900), "900 B");
  assert.equal(formatShareFileSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatShareFileSize(3 * 1024 * 1024 * 1024), "3.0 GB");
  assert.equal(formatShareFileSize(undefined), null);
  assert.equal(formatShareFileSize(Number.NaN), null);
});

test("every busy state is busy, and no settled state is", () => {
  const busy: ShareState[] = [
    { kind: "loading" },
    { kind: "creating" },
    { kind: "replacing", link: LINK },
    { kind: "revoking", link: LINK },
  ];
  const settled: ShareState[] = [
    { kind: "closed" },
    { kind: "off" },
    { kind: "on", link: LINK },
    { kind: "revoked" },
    { kind: "unsure", message: SHARE_UNSURE },
    { kind: "unavailable", message: "x" },
  ];
  for (const state of busy) assert.equal(isShareBusy(state), true, state.kind);
  for (const state of settled) assert.equal(isShareBusy(state), false, state.kind);
  for (const state of busy) {
    const buttons = Object.values(view(state).buttons);
    assert.ok(
      buttons.every((button) => button.disabled),
      `${state.kind} must not offer a live button`,
    );
  }
});

test("replacing warns that the old link dies at once", () => {
  const note = view({ kind: "on", link: LINK }).note ?? "";
  assert.ok(note.includes("immediately"));
  assert.equal(view({ kind: "on", link: LINK }).buttons.replace?.label, SHARE_REPLACE_LABEL);
});
