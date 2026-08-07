import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("a list row's overflow trigger is visible without hovering", () => {
  // Regression: .row-menu reuses .session-menu-btn, which the sessions sidebar
  // keeps at opacity 0 until .session-row:hover. There is no .session-row on
  // the Files page, so the trigger shipped permanently invisible and every
  // action behind it was unreachable. Reusing that markup is still right; it
  // just has to opt out of the reveal-on-hover.
  const rule = /\.row-menu\s+\.session-menu-btn\s*\{[^}]*opacity:\s*1/;
  assert.match(css, rule, ".row-menu .session-menu-btn must set opacity: 1");
});

test("a list row's overflow trigger sits in the row, not wherever it lands", () => {
  // Regression: .session-menu is position:absolute with top:50%/right:6px so it
  // can pin to a position:relative session row. List rows are not positioned,
  // so the trigger resolved against a far-away ancestor and rendered hundreds
  // of pixels outside the card. .row-menu returns it to flow — and being
  // relative is also what its own popover anchors to.
  const block = /\.row-menu\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
  assert.match(block, /position:\s*relative/);
  assert.match(block, /top:\s*auto/);
  assert.match(block, /right:\s*auto/);
  assert.match(block, /margin-top:\s*0/);
});

test("the base session-menu-btn still hides until its row is hovered", () => {
  // The override is scoped on purpose — the sidebar's behaviour is unchanged.
  assert.match(css, /\.session-menu-btn\s*\{[^}]*opacity:\s*0/);
});
