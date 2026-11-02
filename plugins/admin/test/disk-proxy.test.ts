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
process.env.CORE_SIGNING_SECRET = "admin-disk-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";
const adminCalls = () => calls.filter((c) => c.url.startsWith("/v1/admin/"));
const send = (method: string, path: string, body?: unknown, cookie: string | null = ADMIN) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test("disk reads and admin actions reach the core admin disk API", async () => {
  calls.length = 0;
  assert.equal((await send("GET", "/api/disk")).status, 200);
  assert.equal((await send("POST", "/api/disk/measure", {})).status, 200);
  assert.equal((await send("POST", "/api/disk/apps/a1/stop", {})).status, 200);
  assert.equal((await send("DELETE", "/api/disk/apps/a1")).status, 200);
  assert.equal((await send("DELETE", "/api/disk/apps/x/versions/2")).status, 200);
  assert.equal((await send("DELETE", "/api/disk/sandbox-containers/qm-sbx-alice")).status, 200);
  assert.equal(
    (await send("PUT", `/api/scopes/${encodeURIComponent("org:acme")}/app-idle-stop`, { days: 14 })).status,
    200,
  );
  assert.deepEqual(
    adminCalls().map((c) => [c.method, c.url, c.actor]),
    [
      ["GET", "/v1/admin/disk", "U-admin@acme"],
      ["POST", "/v1/admin/disk/measure", "U-admin@acme"],
      ["POST", "/v1/admin/disk/apps/a1/stop", "U-admin@acme"],
      ["DELETE", "/v1/admin/disk/apps/a1", "U-admin@acme"],
      ["DELETE", "/v1/admin/disk/apps/x/versions/2", "U-admin@acme"],
      ["DELETE", "/v1/admin/disk/sandbox-containers/qm-sbx-alice", "U-admin@acme"],
      ["PUT", "/v1/admin/scopes/org%3Aacme/app-idle-stop", "U-admin@acme"],
    ],
  );
  assert.deepEqual(JSON.parse(adminCalls().at(-1)!.body), { days: 14 });
});

test("disk refuses unknown methods and signed-out callers without reaching core", async () => {
  calls.length = 0;
  assert.equal((await send("PUT", "/api/disk/apps/a1", {})).status, 404);
  assert.equal((await send("PATCH", "/api/disk", {})).status, 404);
  assert.equal((await send("GET", "/api/disk", undefined, null)).status, 401);
  assert.equal((await send("DELETE", "/api/disk/apps/a1", undefined, null)).status, 401);
  assert.equal(adminCalls().length, 0);
});
