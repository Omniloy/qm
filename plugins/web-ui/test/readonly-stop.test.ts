import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("a failed Stop on a read-only run keeps the run and tells the person why", () => {
  const start = chat.indexOf("async function stopReadOnlyRun(");
  const body = chat.slice(start, chat.indexOf("\n  }\n", start));
  assert.doesNotMatch(body, /void 0/);
  assert.match(
    body,
    /await abortRunById\(run\.runId\);\s*if \(readOnlyRun\?\.runId === run\.runId\) readOnlyRun = null;/,
  );
  assert.match(body, /catch \(e\) \{[\s\S]*readOnlyStopError = errMessage\(e, /);
  assert.match(chat, /class="readonly-run-error" role="alert">\$\{readOnlyStopError\}/);
});
