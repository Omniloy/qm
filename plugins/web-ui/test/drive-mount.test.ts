import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandState,
  canAttach,
  listedAgo,
  accessLabel,
  requestAccessUrl,
  rowStatus,
  rowTitle,
  rowIsInert,
  driveFolderUrl,
  folderActions,
  mountNameError,
  slugFromFolderName,
  parseDriveFolderId,
  type BandState,
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
  externalId: "1A2b3C4d5E6f7G8h9I0j",
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

test("a folder URL is derived from the id, not fetched", () => {
  assert.equal(driveFolderUrl("1A2b3C4d5E6f7G8h9I0j"), "https://drive.google.com/drive/folders/1A2b3C4d5E6f7G8h9I0j");
  assert.equal(driveFolderUrl("a/b?c"), "https://drive.google.com/drive/folders/a%2Fb%3Fc", "ids are escaped");
});

test("request access points at Drive, since QM cannot grant it", () => {
  assert.equal(
    requestAccessUrl({ externalId: "x", webViewLink: "https://drive.google.com/x" }),
    "https://drive.google.com/x",
    "Drive's own link wins when a listing supplied one",
  );
  // Regression: this used to return null whenever webViewLink was absent,
  // which is almost always — so the no-access state offered a link that
  // never rendered. The id we already hold resolves the same folder.
  assert.equal(
    requestAccessUrl({ externalId: "1A2b3C4d5E6f7G8h9I0j" }),
    "https://drive.google.com/drive/folders/1A2b3C4d5E6f7G8h9I0j",
  );
  assert.equal(requestAccessUrl({}), null, "no link rather than a fabricated one");
});

test("a healthy folder says nothing at all", () => {
  // It used to report "Listed just now" forever. Nobody acts on that, and the
  // column it occupied is what squeezed the row's actions at narrow widths.
  assert.equal(rowStatus(row(), "populated", NOW), null);
  assert.equal(rowStatus(row({ listedAt: NOW - 3 * 86_400_000 }), "populated", NOW), null, "age alone is not a status");
});

test("row status reflects why a row cannot be used", () => {
  assert.equal(rowStatus(row(), "not-connected", NOW), "Not connected");
  assert.equal(rowStatus(row(), "needs-reconnect", NOW), "Paused");
  assert.equal(rowStatus(row({ inaccessible: true }), "populated", NOW), "No access");
  assert.equal(rowStatus(row({ enabled: false }), "populated", NOW), "Off");
});

test("off outranks no-access, because an off folder is never listed", () => {
  const r = row({ enabled: false, inaccessible: true });
  assert.equal(rowStatus(r, "populated", NOW), "Off", "a stale access flag would send someone chasing the wrong fix");
});

test("the listing age survives in the tooltip", () => {
  assert.equal(
    rowTitle(row({ displayPath: "Design docs", listedAt: NOW - 2 * 60_000, createdBy: "sam@example.com" }), NOW),
    "Design docs \u00b7 listed 2m ago \u00b7 attached by sam@example.com",
  );
  assert.equal(rowTitle(row({ displayPath: undefined, listedAt: undefined }), NOW), "Google Drive");
});

test("a folder with no listing explains what happens next", () => {
  // Regression: this once read "Listed not listed yet" — a prefix glued onto a
  // phrase — and then stated an absence the person could do nothing about.
  // Nothing lists a folder until a conversation needs it.
  assert.equal(rowStatus(row({ listedAt: undefined }), "populated", NOW), "Opens when the agent needs it");
});

test("the overflow menu always offers the one action that cannot fail", () => {
  // Opening in Drive is a link. It works when the token is dead, when the
  // folder is off, and when this person has no access — which is exactly when
  // someone needs it most.
  for (const [r, state] of [
    [row(), "populated"],
    [row({ enabled: false }), "populated"],
    [row({ inaccessible: true }), "populated"],
    [row(), "needs-reconnect"],
  ] as Array<[MountRow, BandState]>) {
    assert.equal(folderActions(r, state)[0]?.id, "open");
  }
});

test("refresh is offered but refused when it could not work", () => {
  const refreshOf = (r: MountRow, state: BandState) => folderActions(r, state).find((a) => a.id === "refresh");
  assert.equal(refreshOf(row(), "populated")?.disabled, false);
  assert.equal(refreshOf(row({ enabled: false }), "populated")?.disabled, true);
  assert.equal(refreshOf(row({ inaccessible: true }), "populated")?.disabled, true);
  assert.equal(refreshOf(row(), "needs-reconnect")?.disabled, true);
  assert.ok(refreshOf(row({ enabled: false }), "populated")?.reason, "a disabled action has to say why");
});

test("removing is marked destructive so it renders apart", () => {
  const remove = folderActions(row(), "populated").find((a) => a.id === "remove");
  assert.equal(remove?.danger, true);
  assert.equal(remove?.disabled, undefined, "removing stays available even when the folder cannot be read");
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

test("the browser rejects a bad mount name before a round trip", () => {
  // Duplicated from core on purpose: the browser must be able to refuse
  // early, and core must never trust that it did.
  for (const bad of ["", "-lead", "Upper", "has space", "dots.no", "a/b"]) {
    assert.ok(mountNameError(bad), `expected ${JSON.stringify(bad)} to be rejected`);
  }
  for (const ok of ["a", "specs", "q4-planning", "x".repeat(32)]) {
    assert.equal(mountNameError(ok), null, `expected ${JSON.stringify(ok)} to be accepted`);
  }
  assert.ok(mountNameError("x".repeat(33)), "33 characters is too long");
});

test("suggested names from Drive titles are always storable", () => {
  for (const [title, expected] of [
    ["Product Specs", "product-specs"],
    ["  Q4 / Planning  ", "q4-planning"],
    ["A".repeat(64), "a".repeat(32)],
  ] as Array<[string, string]>) {
    const slug = slugFromFolderName(title);
    assert.equal(slug, expected);
    assert.equal(mountNameError(slug), null);
  }
  assert.equal(slugFromFolderName("..."), "", "an unusable title yields nothing rather than a bad name");
});

test("a pasted Drive link yields its folder id, whatever form it takes", () => {
  const id = "1A2b3C4d5E6f7G8h9I0j";
  assert.equal(parseDriveFolderId(`https://drive.google.com/drive/folders/${id}`), id);
  assert.equal(parseDriveFolderId(`https://drive.google.com/drive/u/0/folders/${id}`), id);
  assert.equal(parseDriveFolderId(`https://drive.google.com/drive/folders/${id}?usp=sharing`), id);
  assert.equal(parseDriveFolderId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(parseDriveFolderId(id), id, "a bare id is accepted too");
  assert.equal(parseDriveFolderId(`  ${id}  `), id, "surrounding whitespace is forgiven");
});

test("anything that is not a Drive folder reference is refused", () => {
  for (const bad of ["", "   ", "hello", "https://example.com/drive/folders/abc", "https://evil.com/?id=abc"]) {
    assert.equal(parseDriveFolderId(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});
