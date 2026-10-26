import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("a held connector write shows its full arguments where the person decides", () => {
  assert.match(
    composer,
    /<div class="composer-approval-copy">\$\{ctx\.chat\.approvalSummaryView\(a, true\)\}<\/div>/,
    "the composer approval panel renders the expanded view",
  );
  const view = chat.slice(chat.indexOf("  function approvalSummaryView("), chat.indexOf("  function approvalMarker("));
  assert.match(
    view,
    /expanded\s*\?\s*html`<code class="approval-cmd approval-cmd-full">\$\{a\.command\}<\/code>`/,
    "the expanded view prints the whole command, which carries the call's arguments",
  );
  assert.match(view, /<code class="approval-summary" \$\{tip\(a\.command\)\}>\$\{summary\}<\/code>/);
});
