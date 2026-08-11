import { test } from "node:test";
import assert from "node:assert/strict";
import { levelOf, crumbsOf, nearestExistingDir } from "../src/workspace-tree.ts";

const PATHS = [
  "licit/ted.py",
  "licit/tedharvest.py",
  "licit/hits/placsp-candidates.json",
  "licit/hits/ted-2026-06.json",
  "pliegos/contacts.py",
  "vidsigner-pendientes-2026-08-07.md",
];

test("root level puts folders before files, each sorted by name", () => {
  assert.deepEqual(
    levelOf(PATHS, "").map((e) => [e.kind, e.name]),
    [
      ["dir", "licit"],
      ["dir", "pliegos"],
      ["file", "vidsigner-pendientes-2026-08-07.md"],
    ],
  );
});

test("folder counts include files nested deeper than one level", () => {
  const licit = levelOf(PATHS, "").find((e) => e.name === "licit");
  assert.equal(licit?.fileCount, 4);
});

test("descending a level lists that directory only", () => {
  assert.deepEqual(
    levelOf(PATHS, "licit").map((e) => [e.kind, e.name, e.path]),
    [
      ["dir", "hits", "licit/hits"],
      ["file", "ted.py", "licit/ted.py"],
      ["file", "tedharvest.py", "licit/tedharvest.py"],
    ],
  );
});

test("a directory whose name prefixes another is not absorbed by it", () => {
  const paths = ["lic/crawl.py", "licit/ted.py"];
  assert.deepEqual(
    levelOf(paths, "lic").map((e) => e.name),
    ["crawl.py"],
  );
});

test("an unknown directory lists nothing rather than throwing", () => {
  assert.deepEqual(levelOf(PATHS, "nope"), []);
});

test("crumbs walk the root down to the current directory", () => {
  assert.deepEqual(crumbsOf("licit/hits"), [
    { label: "workspace", path: "" },
    { label: "licit", path: "licit" },
    { label: "hits", path: "licit/hits" },
  ]);
});

test("crumbs at the root are just the root", () => {
  assert.deepEqual(crumbsOf(""), [{ label: "workspace", path: "" }]);
});

test("a directory that survived a refresh is kept", () => {
  assert.equal(nearestExistingDir(PATHS, "licit/hits"), "licit/hits");
});

test("a directory the agent deleted climbs to its nearest surviving parent", () => {
  assert.equal(nearestExistingDir(PATHS, "licit/hits/old/deeper"), "licit/hits");
});

test("a directory with no surviving ancestor falls back to the root", () => {
  assert.equal(nearestExistingDir(PATHS, "gone/entirely"), "");
});
