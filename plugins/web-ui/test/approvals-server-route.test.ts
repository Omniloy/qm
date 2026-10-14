import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const storedRequest = {
  surface: "web",
  actor: { externalId: "alice" },
  conversation: { threadRef: "web:alice:default" },
  text: "run the flagged command",
  attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 4, blobId: "blob-original" }],
  idempotencyKey: "web:alice:original-send",
};

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    calls.push({
      method: req.method ?? "GET",
      url,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && url.split("?")[0]!.endsWith("/report")) {
      res.statusCode = 201;
      res.end(JSON.stringify({ reported: true, reportId: "rep-1" }));
      return;
    }
    if (req.method === "POST" && url.split("?")[0]!.endsWith("/resolve-hold")) {
      res.end(
        JSON.stringify({ outcome: "allowed", message: "Allowed once — the run continued and delivered to you." }),
      );
      return;
    }
    if (url.startsWith("/v1/approvals/a-cron")) {
      res.end(
        JSON.stringify({
          sessionId: "cron-fire",
          request: {
            ...storedRequest,
            surface: "cron",
            actor: { externalId: url.includes("hold") ? "first-member" : "alice" },
            conversation: { kind: "dm", threadRef: "cron:c1:fire:abc" },
          },
          ...(url.includes("hold")
            ? { securityHold: { source: { kind: "command", command: "ls" }, category: "other" } }
            : {}),
        }),
      );
      return;
    }
    if (url.startsWith("/v1/sessions/cron-fire")) {
      res.end(JSON.stringify({ session: { id: "cron-fire", surface: "cron", threadRef: "cron:c1:fire:abc" } }));
      return;
    }
    if (url.startsWith("/v1/approvals/a-swarm")) {
      let sessionId = "worker";
      if (url.includes("hidden")) sessionId = "hidden";
      if (url.includes("mismatch")) sessionId = "mismatch";
      if (url.includes("wrong-surface")) sessionId = "wrong-surface";
      res.end(
        JSON.stringify({
          sessionId,
          request: { ...storedRequest, surface: "swarm", conversation: { threadRef: "swarm:root:worker" } },
        }),
      );
      return;
    }
    if (url.startsWith("/v1/sessions/hidden")) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    if (url.startsWith("/v1/sessions/mismatch") || url.startsWith("/v1/sessions/wrong-surface")) {
      res.end(
        JSON.stringify({
          session: { surface: url.includes("wrong-surface") ? "web" : "swarm", threadRef: "swarm:other:worker" },
        }),
      );
      return;
    }
    if (url.startsWith("/v1/sessions/worker")) {
      res.end(JSON.stringify({ session: { id: "worker", surface: "swarm", threadRef: "swarm:root:worker" } }));
      return;
    }
    if (url.startsWith("/v1/approvals/a-1")) {
      res.end(JSON.stringify({ sessionId: "s-1", request: storedRequest }));
      return;
    }
    if (url.startsWith("/v1/approvals/a-theirs")) {
      res.end(JSON.stringify({ sessionId: "s-2", request: { ...storedRequest, actor: { externalId: "bob" } } }));
      return;
    }
    if (url.startsWith("/v1/turns")) {
      res.end(JSON.stringify({ status: "queued", runId: "r-1" }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "approvals-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "approvals-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

function turnPosts(since: number): Call[] {
  return calls.slice(since).filter((c) => c.url.startsWith("/v1/turns"));
}

test("approve replays the stored request verbatim with the decision and the namespaced gesture key", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/approvals/a-1`, {
    method: "POST",
    headers,
    body: JSON.stringify({ approved: true, scope: "session", idempotencyKey: "gesture-1" }),
  });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { runId?: string }).runId, "r-1");
  const posts = turnPosts(before);
  assert.equal(posts.length, 1);
  const body = posts[0]!.body;
  assert.equal(body.text, storedRequest.text);
  assert.deepEqual(body.attachments, storedRequest.attachments);
  assert.deepEqual(body.approval, { requestId: "a-1", approved: true, scope: "session" });
  assert.equal(body.idempotencyKey, "web:alice:gesture-1");
});

test("the original send's stored key never rides along, and unusable client keys are dropped", async () => {
  for (const key of [undefined, "a:b", "approval:a-1:true", "x".repeat(129), 42]) {
    const before = calls.length;
    const r = await fetch(`${base}/api/approvals/a-1`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approved: true, ...(key === undefined ? {} : { idempotencyKey: key }) }),
    });
    assert.equal(r.status, 200);
    const posts = turnPosts(before);
    assert.equal(posts.length, 1);
    assert.ok(!("idempotencyKey" in posts[0]!.body), `key ${JSON.stringify(key)} must not forward any idempotency key`);
  }
});

test("a malformed body is refused, never resolved as a denial", async () => {
  const before = calls.length;
  for (const raw of ["", "{not json", "null", '"approve"', JSON.stringify({ approved: "true" }), "{}"]) {
    const r = await fetch(`${base}/api/approvals/a-1`, { method: "POST", headers, body: raw });
    assert.equal(r.status, 400, `body ${JSON.stringify(raw)} must refuse`);
  }
  assert.equal(turnPosts(before).length, 0, "no malformed decision may reach core");
});

test("another user's approval record answers 404", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/approvals/a-theirs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ approved: true }),
  });
  assert.equal(r.status, 404);
  assert.equal(turnPosts(before).length, 0);
});

test("a visible worker approval replays its stored request without granting ordinary continuation", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/approvals/a-swarm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ approved: true, scope: "once" }),
  });
  assert.equal(r.status, 200);
  const posts = turnPosts(before);
  assert.equal(posts.length, 1);
  assert.equal((posts[0]!.body.conversation as { threadRef: string }).threadRef, "swarm:root:worker");
  assert.equal(posts[0]!.body.surface, "swarm");
  assert.deepEqual(posts[0]!.body.attachments, storedRequest.attachments);
});
test("worker approvals still require session visibility", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/approvals/a-swarm-hidden`, {
    method: "POST",
    headers,
    body: JSON.stringify({ approved: true }),
  });
  assert.equal(r.status, 404);
  assert.equal(turnPosts(before).length, 0);
});

test("worker replay rejects a mismatched thread or non-worker session", async () => {
  for (const id of ["a-swarm-mismatch", "a-swarm-wrong-surface"]) {
    const before = calls.length;
    const response = await fetch(`${base}/api/approvals/${id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ approved: true }),
    });
    assert.equal(response.status, 404);
    assert.equal(turnPosts(before).length, 0);
  }
});

test("a scheduled task's hold resolves through core's owner check and never replays the turn", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/approvals/a-cron-hold`, {
    method: "POST",
    headers,
    body: JSON.stringify({ approved: true, scope: "once" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    outcome: "allowed",
    message: "Allowed once — the run continued and delivered to you.",
  });
  const resolved = calls.slice(before).filter((c) => c.url.split("?")[0]!.endsWith("/resolve-hold"));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.url.split("?")[0], "/v1/approvals/a-cron-hold/resolve-hold");
  assert.deepEqual(resolved[0]!.body, { actorId: "alice", approved: true });
  assert.equal(turnPosts(before).length, 0);
});

test("a scheduled task's ordinary approval keeps failing closed on the web", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/approvals/a-cron`, {
    method: "POST",
    headers,
    body: JSON.stringify({ approved: true }),
  });
  assert.equal(r.status, 404);
  assert.equal(turnPosts(before).length, 0);
  assert.equal(calls.slice(before).filter((c) => c.url.includes("/resolve-hold")).length, 0);
});

function reportPosts(since: number): Call[] {
  return calls.slice(since).filter((c) => c.method === "POST" && c.url.split("?")[0]!.endsWith("/report"));
}

test("reporting a hold forwards the requester as reporter with the note and never resolves it", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/approvals/a-1/report`, {
    method: "POST",
    headers,
    body: JSON.stringify({ note: "our own built-in skill", reporterId: "mallory" }),
  });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { reported: true, reportId: "rep-1" });
  const posts = reportPosts(before);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url.split("?")[0], "/v1/approvals/a-1/report");
  assert.deepEqual(posts[0]!.body, { reporterId: "alice", note: "our own built-in skill" });
  assert.equal(turnPosts(before).length, 0, "reporting never releases the content");
});

test("only the requester can report a hold", async () => {
  const before = calls.length;
  for (const id of ["a-theirs", "a-cron"]) {
    const r = await fetch(`${base}/api/approvals/${id}/report`, { method: "POST", headers, body: "{}" });
    assert.equal(r.status, 404, id);
  }
  assert.equal(reportPosts(before).length, 0);
});
