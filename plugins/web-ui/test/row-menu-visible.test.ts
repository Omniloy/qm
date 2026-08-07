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

test("the base session-menu-btn still hides until its row is hovered", () => {
  // The override is scoped on purpose — the sidebar's behaviour is unchanged.
  assert.match(css, /\.session-menu-btn\s*\{[^}]*opacity:\s*0/);
});
