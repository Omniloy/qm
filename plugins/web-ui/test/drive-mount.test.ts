import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandState,
  canAttach,
  listedAgo,
  accessLabel,
  requestAccessUrl,
  rowStatus,
  rowIsInert,
  type MountRow,
  type ConnectorState,
} from "../src/drive-mount.ts";

const NOW = 1_700_000_000_000;

const connector = (over: Partial<ConnectorState> = {}): ConnectorState => ({
  configured: true,
  connected: true,
  needsReconnect: false,
  ...over,
});

const row = (over: Partial<MountRow> = {}): MountRow => ({
  id: "m1",
  name: "Product Specs",
  mode: "rw",
  listedAt: NOW,
  ...over,
});

test("an unconfigured provider outranks every other state", () => {
  // Nothing the person does can fix this, so a Connect button would be a dead end.
  assert.equal(bandState(connector({ configured: false, connected: false }), []), "not-configured");
  assert.equal(bandState(connector({ configured: false, connected: true }), [row()]), "not-configured");
  assert.equal(
    bandState(connector({ configured: false, needsReconnect: true }), [row()]),
    "not-configured",
    "a broken token is irrelevant when the org never configured the provider",
  );
});

test("not connected is distinguished from having no folders", () => {
  assert.equal(bandState(connector({ connected: false }), []), "not-connected");
  assert.equal(bandState(connector(), []), "empty");
});

test("folders someone else attached still show as not-connected for this person", () => {
  assert.equal(
    bandState(connector({ connected: false }), [row(), row({ id: "m2" })]),
    "not-connected",
    "the rows exist but this person cannot use them",
  );
});

test("a failed refresh outranks populated, because the rows are inert", () => {
  assert.equal(bandState(connector({ needsReconnect: true }), [row()]), "needs-reconnect");
});

test("attaching is only offered when it would actually work", () => {
  assert.equal(canAttach("populated"), true);
  assert.equal(canAttach("empty"), true);
  assert.equal(canAttach("not-connected"), false);
  assert.equal(canAttach("not-configured"), false);
  assert.equal(canAttach("needs-reconnect"), false);
});

test("listing age is coarse and answers 'should I refresh?'", () => {
  assert.equal(listedAgo(NOW, NOW), "just now");
  assert.equal(listedAgo(NOW - 30_000, NOW), "just now");
  assert.equal(listedAgo(NOW - 60_000, NOW), "1m ago");
  assert.equal(listedAgo(NOW - 45 * 60_000, NOW), "45m ago");
  assert.equal(listedAgo(NOW - 3 * 3_600_000, NOW), "3h ago");
  assert.equal(listedAgo(NOW - 2 * 86_400_000, NOW), "2d ago");
});

test("a folder this person has never listed says so rather than claiming 'just now'", () => {
  assert.equal(listedAgo(undefined, NOW), "not listed yet");
});

test("a clock skewed into the future does not produce a negative age", () => {
  assert.equal(listedAgo(NOW + 60_000, NOW), "just now");
});

test("the access label describes the agent's access", () => {
  assert.equal(accessLabel("rw"), "Read & write");
  assert.equal(accessLabel("ro"), "Read only");
});

test("request access points at Drive, since QM cannot grant it", () => {
  assert.equal(requestAccessUrl({ id: "m1", webViewLink: "https://drive.google.com/x" }), "https://drive.google.com/x");
  assert.equal(requestAccessUrl({ id: "m1" }), null, "no link rather than a fabricated one");
});

test("row status reflects why a row cannot be used", () => {
  assert.equal(rowStatus(row(), "populated", NOW), "Listed just now");
  assert.equal(rowStatus(row(), "not-connected", NOW), "Not connected");
  assert.equal(rowStatus(row(), "needs-reconnect", NOW), "Paused");
  assert.equal(rowStatus(row({ inaccessible: true }), "populated", NOW), "No access");
});

test("inaccessibility beats the listing age in the row status", () => {
  const r = row({ inaccessible: true, listedAt: NOW - 60_000 });
  assert.equal(rowStatus(r, "populated", NOW), "No access", "a stale age would imply the folder is usable");
});

test("rows are inert unless this person can actually open the folder", () => {
  assert.equal(rowIsInert(row(), "populated"), false);
  assert.equal(rowIsInert(row({ inaccessible: true }), "populated"), true);
  assert.equal(rowIsInert(row(), "needs-reconnect"), true);
  assert.equal(rowIsInert(row(), "not-connected"), true);
});
