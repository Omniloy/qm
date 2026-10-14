import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; actor: string | null; body: string }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-screening-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("screening reports and skill trusts reach the core admin API", async () => {
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie: ADMIN, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await send("GET", "/api/screening-reports?status=all")).status, 200);
  assert.equal((await send("POST", "/api/screening-reports/r1/status", { status: "screen_correct" })).status, 200);
  assert.equal((await send("GET", "/api/skill-trusts")).status, 200);
  assert.equal((await send("GET", "/api/skill-trusts/preview?skillId=s1&version=3")).status, 200);
  assert.equal((await send("POST", "/api/skill-trusts", { skillId: "s1", version: 3, contentHash: "h" })).status, 200);
  assert.equal(
    (await send("POST", `/api/scopes/${encodeURIComponent("org:acme")}/auto-flagger/sample`, { payload: "x" })).status,
    200,
  );
  assert.equal((await send("DELETE", `/api/skill-trusts/${encodeURIComponent("s1@3")}`)).status, 200);
  const admin = calls.filter((c) => c.url.startsWith("/v1/admin/"));
  assert.deepEqual(
    admin.map((c) => [c.method, c.url, c.actor]),
    [
      ["GET", "/v1/admin/screening-reports?status=all", "U-admin@acme"],
      ["POST", "/v1/admin/screening-reports/r1/status", "U-admin@acme"],
      ["GET", "/v1/admin/skill-trusts", "U-admin@acme"],
      ["GET", "/v1/admin/skill-trusts/preview?skillId=s1&version=3", "U-admin@acme"],
      ["POST", "/v1/admin/skill-trusts", "U-admin@acme"],
      ["POST", "/v1/admin/scopes/org%3Aacme/auto-flagger/sample", "U-admin@acme"],
      ["DELETE", "/v1/admin/skill-trusts/s1%403", "U-admin@acme"],
    ],
  );
  assert.deepEqual(JSON.parse(admin[1]!.body), { status: "screen_correct" });
});

test("screening reports require a signed-in admin cookie", async () => {
  const r = await fetch(`${base}/api/screening-reports`);
  assert.equal(r.status, 401);
});
