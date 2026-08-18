import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

// A flag is only half a feature if nothing follows it into the app. These go
// through buildApp and ask the App itself, because the failure they guard
// against is silent: drop the one line that injects the store and every share
// method starts answering "not_configured", every public route 404s, and the
// whole suite stays green because nothing else calls buildApp.
//
// They also pin "absent means on". A plain truthy read made the default depend
// on how the config object was built — env-parsed configs carry `?? true`, but a
// config assembled in code omits the field and shipped the feature disabled.

function app(over: Record<string, unknown> = {}) {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "share-flag-")), ...over }));
}

test("share links are on when the flag is absent, and the store reaches the App", async () => {
  const built = app();
  const r = await built.app.createSessionShare("no-such-session", "nobody");
  assert.ok(!r.ok);
  // "not_found" is the store answering; "not_configured" would mean it is absent.
  assert.equal(r.reason, "not_found", "the feature is live — it refused on the session, not on itself");
  await built.runtime.stop();
});

test("an explicit false switches the whole feature off", async () => {
  const built = app({ publicShareLinks: false });
  const r = await built.app.createSessionShare("no-such-session", "nobody");
  assert.ok(!r.ok);
  assert.equal(r.reason, "not_configured");
  await built.runtime.stop();
});
