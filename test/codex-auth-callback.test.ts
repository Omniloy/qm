import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexCallback } from "../src/api/routes/admin/codex-auth.ts";

test("parseCodexCallback reads whatever an operator copies out of the browser", () => {
  const full = "http://localhost:1455/auth/callback?code=ac_abc123&state=st456";
  assert.deepEqual(parseCodexCallback(full), { code: "ac_abc123", state: "st456" });
  // The tab failed to connect, so people paste it with the scheme mangled or
  // stripped, or copy only the query.
  assert.deepEqual(parseCodexCallback("localhost:1455/auth/callback?code=a&state=b"), { code: "a", state: "b" });
  assert.deepEqual(parseCodexCallback("?code=a&state=b"), { code: "a", state: "b" });
  assert.deepEqual(parseCodexCallback("code=a&state=b"), { code: "a", state: "b" });
  assert.deepEqual(parseCodexCallback("  code=a&state=b  "), { code: "a", state: "b" });
});

test("parseCodexCallback refuses anything without both halves", () => {
  assert.equal(parseCodexCallback(""), null);
  assert.equal(parseCodexCallback("http://localhost:1455/auth/callback"), null);
  assert.equal(parseCodexCallback("?code=only"), null, "a code with no state cannot be matched to a login");
  assert.equal(parseCodexCallback("?state=only"), null);
  // An error redirect carries neither, and must not read as a usable callback.
  assert.equal(parseCodexCallback("?error=access_denied&error_description=nope"), null);
});
