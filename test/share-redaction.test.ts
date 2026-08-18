import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubSecrets, shareVisibleEntries } from "../src/sessions/share-redaction.ts";
import type { EntryType, SessionEntry } from "../src/types.ts";

let seq = 0;
function entry(type: EntryType, payload: unknown): SessionEntry {
  return { sessionId: "s1", seq: seq++, parentSeq: null, type, payload, createdAt: 1_700_000_000_000 } as SessionEntry;
}

const ALL_TYPES: EntryType[] = [
  "user",
  "assistant",
  "thinking",
  "text",
  "tool_call",
  "tool_result",
  "soul",
  "system",
  "delivery",
  "approval_request",
  "approval_resolved",
];

test("only messages and attachment-bearing deliveries survive", () => {
  const kept = shareVisibleEntries(
    ALL_TYPES.map((t) =>
      entry(t, { text: `content of ${t}`, command: "env", stdout: "AGENT_API_TOKEN=live", files: [] }),
    ),
  );
  assert.deepEqual(
    kept.map((k) => k.text),
    ["content of user", "content of assistant"],
  );
});

test("tool activity never appears, however it is dressed", () => {
  // `text` is narration attached to a tool-using step, not assistant prose —
  // sharing it would contradict the page's own promise.
  for (const t of ["text", "thinking", "tool_call", "tool_result", "system", "soul"] as EntryType[]) {
    assert.deepEqual(shareVisibleEntries([entry(t, { text: "secret work", stdout: "sk-live-abcdefghijklmnop" })]), []);
  }
});

test("a hidden user entry is machinery, not a message", () => {
  // Cron and trigger prompts persist as user entries with hidden: true.
  assert.deepEqual(shareVisibleEntries([entry("user", { text: "run the nightly sweep", hidden: true })]), []);
});

test("a user entry renders what the person typed, never the wake envelope", () => {
  // On automation and Slack turns `text` is a <wake> envelope carrying other
  // people's messages and the channel's standing orders.
  const wake = "<wake><standing-orders>escalate to Mar</standing-orders><msg from='U123'>secret plan</msg></wake>";
  const out = shareVisibleEntries([entry("user", { text: wake, display: "what did you find?" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.text, "what did you find?");
  assert.ok(!out[0]!.text.includes("standing-orders"));
  assert.ok(!out[0]!.text.includes("U123"));
});

test("entries are renumbered, so a reader cannot count what was withheld", () => {
  const out = shareVisibleEntries([
    entry("user", { text: "one" }),
    entry("tool_call", { command: "env" }),
    entry("tool_result", { stdout: "TOKEN=live" }),
    entry("thinking", { text: "hmm" }),
    entry("assistant", { text: "two" }),
  ]);
  assert.deepEqual(
    out.map((o) => o.i),
    [0, 1],
    "share-local indexes, not the store's seq",
  );
});

test("a delivery contributes its files and never its manifest text", () => {
  const out = shareVisibleEntries([
    entry("delivery", {
      text: "report.pdf (application/pdf, 12 bytes)",
      files: [{ name: "report.pdf", artifactId: "art-1", mimetype: "application/pdf", sizeBytes: 12 }],
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.text, "");
  assert.deepEqual(out[0]!.files, [
    { name: "report.pdf", artifactId: "art-1", mimetype: "application/pdf", sizeBytes: 12 },
  ]);
});

test("a file without an artifact id is dropped — it cannot be served anyway", () => {
  const out = shareVisibleEntries([entry("delivery", { files: [{ name: "ghost.pdf" }] })]);
  assert.deepEqual(out, []);
});

test("only named payload fields cross the boundary", () => {
  const out = shareVisibleEntries([
    entry("assistant", { text: "hi", internalNote: "do not publish", scopeId: "personal:enrique@x.com" }),
  ]);
  assert.deepEqual(Object.keys(out[0]!).sort(), ["at", "i", "role", "text"]);
});

test("secret-drop URLs are scrubbed out of ordinary message text", () => {
  // The exact shape the agent pastes into replies.
  const url =
    "SID: https://mo.omniloy.com/drop/2e8594fb-862a-4614-88d4-dbb9534fcc55/form?t=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmdJZCI6Im9tbmlsb3kifQ.PsHT5LeMzeq1xA1t1EVVAr1fq";
  const scrubbed = scrubSecrets(url);
  assert.ok(!scrubbed.includes("2e8594fb"), "the drop id is gone");
  assert.ok(!scrubbed.includes("eyJhbGci"), "the token is gone");
  assert.match(scrubbed, /\[redacted link\]/);
});

test("the scrubber catches this codebase's own token shapes, not just three-part ones", () => {
  const twoPart = "eyJvcmdJZCI6Im9tbmlsb3kiLCJwIjoiZW5yaXF1ZSJ9.YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo";
  assert.match(scrubSecrets(twoPart), /\[redacted link\]/, "portal identity / legacy capability shape");
  const threePart = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.match(scrubSecrets(threePart), /\[redacted link\]/);
});

test("connector consent links are scrubbed — they carry the sharer's principal id", () => {
  const link = "https://mo.omniloy.com/connect/redeem/abc123?p=enrique.alcazar%40omniloy.com";
  const out = scrubSecrets(link);
  assert.ok(!out.includes("enrique.alcazar"), "no principal id survives");
  assert.match(out, /\[redacted link\]/);
});

test("vendor key shapes and private keys are scrubbed", () => {
  for (const s of [
    "sk-abcdefghijklmnopqrstuvwx",
    "ghp_abcdefghijklmnopqrstuvwxyz12",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-123456789012-abcdefghijkl",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----",
  ]) {
    assert.match(scrubSecrets(s), /\[redacted link\]/, s.slice(0, 20));
  }
});

test("scrubbing leaves ordinary prose and plain links alone", () => {
  const prose = "See https://docs.example.com/guide#setup for the steps. The answer is 42.";
  assert.equal(scrubSecrets(prose), prose);
});

test("redaction is visible, so a reader knows something was removed", () => {
  const out = shareVisibleEntries([
    entry("assistant", {
      text: "Here you go: https://mo.omniloy.com/drop/2e8594fb-862a-4614-88d4-dbb95/form?t=abcdefghijklmnopqrstuvwxyz",
    }),
  ]);
  assert.match(out[0]!.text, /\[redacted link\]/);
  assert.ok(out[0]!.text.startsWith("Here you go:"), "the sentence around it survives");
});
