import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken, verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { BROWSER_RELAY_AUD } from "../src/browser-relay/server.ts";
import { CAPABILITY_HEADER } from "../src/api/contract.ts";
import { personalScope } from "../src/types.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

const SECRET = "core-signing-secret".repeat(3);
const PAIRING = "/v1/browser-relay/pairing";

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "relay-pairing-")) }));
const core = createServer(built.app, { signingSecret: SECRET, capabilitySecret: TEST_CAPABILITY_SECRET });
core.listen(0);
const coreBase = `http://localhost:${(core.address() as AddressInfo).port}`;

process.env.CORE_API_URL = coreBase;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
  await built.runtime.stop();
});

const portal = (user: string) => ({
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
});

async function capabilityPairing(token: string): Promise<number> {
  const r = await fetch(`${coreBase}${PAIRING}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CAPABILITY_HEADER]: token },
    body: "{}",
  });
  return r.status;
}

test("an agent's live personal turn token cannot mint a pairing token", async () => {
  const turnToken = await mintCapabilityToken(
    {
      actorId: "U1",
      scopeId: personalScope("U1"),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + 60_000,
    },
    TEST_CAPABILITY_SECRET,
  );
  assert.equal(await capabilityPairing(turnToken), 403);
});

test("the person's portal identity mints their own pairing token", async () => {
  const r = await fetch(`${coreBase}${PAIRING}`, {
    method: "POST",
    headers: { ...signedHeaders(SECRET, "POST", PAIRING, "{}"), ...portal("U1") },
    body: "{}",
  });
  assert.equal(r.status, 200);
  const minted = await verifyCapabilityToken(((await r.json()) as { token: string }).token, TEST_CAPABILITY_SECRET);
  assert.equal(minted?.aud, BROWSER_RELAY_AUD);
  assert.equal(minted?.actorId, "U1");
});

test("the web UI's pairing button mints the signed-in person's pairing token", async () => {
  const r = await fetch(`${webBase}/api/browser-relay/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "webuiuser=U1", ...portal("U1") },
    body: "{}",
  });
  assert.equal(r.status, 200);
  const minted = await verifyCapabilityToken(((await r.json()) as { token: string }).token, TEST_CAPABILITY_SECRET);
  assert.equal(minted?.actorId, "U1");
  assert.equal(minted?.scopeId, personalScope("U1"));
});
