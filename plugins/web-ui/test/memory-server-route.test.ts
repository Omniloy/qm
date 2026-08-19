import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

interface Call {
  method: string;
  pathname: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const u = new URL(req.url ?? "", "http://core");
    const params = Object.fromEntries([...u.searchParams].filter(([key]) => key !== "_sourceAuthNonce"));
    calls.push({ method: req.method ?? "GET", pathname: u.pathname, params, body: raw ? JSON.parse(raw) : {} });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: "hello", revision: "r0", revisions: [] }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "memory-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "memory-route-test"),
  "content-type": "application/json",
};

const SCOPE = "group:web-project-p1";

function coreCalls(from: number, pathname: string): Call[] {
  return calls.slice(from).filter((call) => call.pathname === pathname);
}

test.after(() => {
  surface.close();
  core.close();
});

test("each memory endpoint forwards the requested scope under the signed-in principal", async () => {
  let before = calls.length;
  let r = await fetch(`${base}/api/memory?scopeId=${encodeURIComponent(SCOPE)}`, { headers });
  assert.equal(r.status, 200);
  assert.deepEqual(coreCalls(before, "/v1/memory")[0]?.params, { principalId: "alice", scopeId: SCOPE });

  before = calls.length;
  r = await fetch(`${base}/api/memory/history?scopeId=${encodeURIComponent(SCOPE)}`, { headers });
  assert.equal(r.status, 200);
  assert.deepEqual(coreCalls(before, "/v1/memory/history")[0]?.params, { principalId: "alice", scopeId: SCOPE });

  before = calls.length;
  r = await fetch(`${base}/api/memory`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ content: "notes", revision: "r0", scopeId: SCOPE, principalId: "mallory" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(coreCalls(before, "/v1/memory")[0]?.body, {
    principalId: "alice",
    content: "notes",
    revision: "r0",
    scopeId: SCOPE,
  });

  before = calls.length;
  r = await fetch(`${base}/api/memory/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({ revision: "r1", expectedRevision: "r0", scopeId: SCOPE }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(coreCalls(before, "/v1/memory/restore")[0]?.body, {
    principalId: "alice",
    revision: "r1",
    expectedRevision: "r0",
    scopeId: SCOPE,
  });
});

test("no scope from the browser means none reaches core", async () => {
  let before = calls.length;
  await fetch(`${base}/api/memory`, { headers });
  assert.deepEqual(coreCalls(before, "/v1/memory")[0]?.params, { principalId: "alice" });

  before = calls.length;
  await fetch(`${base}/api/memory/history?scopeId=`, { headers });
  assert.deepEqual(coreCalls(before, "/v1/memory/history")[0]?.params, { principalId: "alice" });

  before = calls.length;
  await fetch(`${base}/api/memory`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ content: "notes", revision: "r0", scopeId: "" }),
  });
  assert.deepEqual(coreCalls(before, "/v1/memory")[0]?.body, {
    principalId: "alice",
    content: "notes",
    revision: "r0",
  });

  before = calls.length;
  await fetch(`${base}/api/memory/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({ revision: "r1", expectedRevision: "r0" }),
  });
  assert.deepEqual(coreCalls(before, "/v1/memory/restore")[0]?.body, {
    principalId: "alice",
    revision: "r1",
    expectedRevision: "r0",
  });
});

test("a save without a revision reads the head of the scope it will write", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/memory`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ content: "notes", scopeId: SCOPE }),
  });
  assert.equal(r.status, 200);
  const [head, put] = coreCalls(before, "/v1/memory");
  assert.equal(head?.method, "GET");
  assert.deepEqual(head?.params, { principalId: "alice", scopeId: SCOPE });
  assert.equal(put?.method, "PUT");
  assert.deepEqual(put?.body, { principalId: "alice", content: "notes", revision: "r0", scopeId: SCOPE });
});
