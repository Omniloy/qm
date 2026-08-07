import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

/**
 * The browser proxy carries a live-view URL, which is bearer material: anyone
 * holding it can watch and drive someone's logged-in browser. So this is three
 * named verbs rather than a passthrough, and the identity comes from the
 * signed-in cookie rather than anything the caller can state.
 */

interface Call {
  method: string;
  url: string;
  body: string;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", body: raw });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ session: { sessionId: "s1", controlMode: "agent" } }));
  });
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "browser-proxy-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((r) => surface.listen(0, r));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "browser-proxy-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("the pane asks core for the current browser, with no viewer it could forge", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/browser/live`, { headers });
  assert.equal(r.status, 200);
  const call = calls.slice(before).find((c) => c.url.startsWith("/v1/browser-sessions/current"));
  assert.ok(call, "forwarded to core");
  // Core reads the owner from the portal identity coreFetch attaches. A viewer
  // parameter here would imply the caller gets to choose who they are.
  assert.doesNotMatch(call.url, /viewer=/);
});

test("handoff carries its body through", async () => {
  const before = calls.length;
  await fetch(`${base}/api/browser/session/s1/handoff`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "human_control" }),
  });
  const call = calls.slice(before).find((c) => c.method === "POST");
  assert.ok(call);
  assert.match(call.url, /^\/v1\/browser-sessions\/s1\/handoff/);
  assert.deepEqual(JSON.parse(call.body), { mode: "human_control" });
});

test("ending a session reaches core as a DELETE", async () => {
  const before = calls.length;
  await fetch(`${base}/api/browser/session/s1`, { method: "DELETE", headers });
  const call = calls.slice(before).find((c) => c.method === "DELETE");
  assert.ok(call);
  assert.match(call.url, /^\/v1\/browser-sessions\/s1/);
});

test("nothing else on that router is reachable through the proxy", async () => {
  // The guard that matters: /v1/browser-sessions vends bearer material, so a
  // generic relay would expose every route on it to anything that can shape a
  // path.
  const before = calls.length;
  for (const [method, path] of [
    ["GET", "/api/browser/session/s1/state"],
    ["POST", "/api/browser/sessions"],
    ["PUT", "/api/browser/live"],
  ] as Array<[string, string]>) {
    const r = await fetch(`${base}${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.notEqual(r.status, 200, `${method} ${path} should not be proxied`);
  }
  assert.equal(calls.length, before, "none of them reached core");
});
