import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if ((req.url ?? "").startsWith("/v1/connectors/apps"))
      calls.push({ method: req.method ?? "GET", url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "connector-apps-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

test("saving connector app settings pins the signed-in principal and ignores a forged one", async () => {
  const r = await fetch(`${base}/api/connectors/microsoft/apps`, {
    method: "POST",
    headers: { cookie: "webuiuser=alice", "content-type": "application/json" },
    body: JSON.stringify({ principalId: "mallory", provider: "google", apps: { mail: false } }),
  });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(new URL(calls[0]!.url, "http://core").pathname, "/v1/connectors/apps");
  assert.deepEqual(calls[0]!.body, { principalId: "alice", provider: "microsoft", apps: { mail: false } });
});
