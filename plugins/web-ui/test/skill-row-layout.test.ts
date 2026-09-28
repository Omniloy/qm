import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/skills.ts", import.meta.url), "utf8");
const rowActions = readFileSync(new URL("../src/row-actions.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped} \\{[^}]*\\}`).exec(css)?.[0] ?? "";
}

test("a conversation's skills view is a visible, clearable scope filter rather than a hidden one", () => {
  const draw = bodyOf("drawSkills");
  assert.doesNotMatch(draw, /skill\.scopeId === scopedScope/);
  assert.match(draw, /scopeFilter = scopedScope \?\? "all"/);
  assert.match(draw, /<option value=\$\{scopedScope\}>\$\{scopeTitle\(scopedScope\)\} and org-wide<\/option>/);
});

test("the status tab counts come from the same filters as the list", () => {
  const draw = bodyOf("drawSkills");
  assert.doesNotMatch(draw, /statusCounts\(skillRows\)/);
  assert.match(draw, /statusCounts\(filterSkillGroups\(allGroups, \{ \.\.\.filters, status: "all" \}\)/);
});

test("each skill row names where it lives and where else the same skill lives", () => {
  const row = bodyOf("skillVariant");
  assert.match(row, /class="badge skill-home"/);
  assert.match(row, /otherHomes\(s, variants\)\.map\(skillHome\)/);
  assert.match(row, /also in \$\{also\.join\(", "\)\}/);
  assert.doesNotMatch(row, /Scope variant/);
  assert.match(rule(".skill-home,\n.skill-also"), /text-overflow: ellipsis/);
});

test("an open row menu stacks above the rows below it", () => {
  assert.match(rule(".skill-variant-state"), /z-index: 1/);
  assert.match(rule(".skill-variant-state:has(.session-menu-popover)"), /z-index: 2/);
});

test("a row menu is as wide as its longest label and flips up when it would clip", () => {
  const popover = rule(".row-menu .session-menu-popover");
  assert.match(popover, /width: max-content/);
  assert.match(popover, /max-width: min\(320px, calc\(100vw - 32px\)\)/);
  assert.match(rowActions, /\$\{ref\(\(el\) => queueMicrotask\(\(\) => placeMenuPopover\(el\)\)\)\}/);
});

test("the change-context list scrolls inside the dialog while its heading and buttons stay put", () => {
  const picker = rule(".drive-picker");
  assert.match(picker, /display: flex/);
  assert.match(picker, /flex-direction: column/);
  assert.match(picker, /max-height: min\(76dvh, 640px\)/);
  const choices = rule(".context-choices");
  assert.match(choices, /min-height: 0/);
  assert.match(choices, /overflow-y: auto/);
});
