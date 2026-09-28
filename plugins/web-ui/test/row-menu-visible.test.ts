import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("a list row's overflow trigger is visible without hovering", () => {
  const rule = /\.row-menu\s+\.session-menu-btn\s*\{[^}]*opacity:\s*1/;
  assert.match(css, rule, ".row-menu .session-menu-btn must set opacity: 1");
});

test("a list row's overflow trigger sits in the row, not wherever it lands", () => {
  const block = /\.row-menu\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(block, /position:\s*relative/);
  assert.match(block, /top:\s*auto/);
  assert.match(block, /right:\s*auto/);
  assert.match(block, /margin-top:\s*0/);
});

test("the base session-menu-btn still hides until its row is hovered", () => {
  assert.match(css, /\.session-menu-btn\s*\{[^}]*opacity:\s*0/);
});

test("dismissing a row menu redraws the view that opened it, whichever view that is", () => {
  const rowActions = readFileSync(new URL("../src/row-actions.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(rowActions, /openMenu = open \? null : \{ key, rerender \};/);
  assert.match(rowActions, /export function closeRowMenu\([^)]*\): void \{[\s\S]*?rerender\(\);\n\}/);
  assert.doesNotMatch(main, /redrawFilesPage/);
  assert.match(main, /closeRowMenu\(target\);/);
  assert.match(main, /closeRowMenu\(null\);/);
});
