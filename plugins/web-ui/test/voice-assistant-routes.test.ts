import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";
import { findRoute } from "../../chassis/src/router.ts";
import { GATED_MODEL_PROBE_PATH } from "../../chassis/src/hugging-face.ts";
import { VOICE_MODEL_FILES } from "../src/voice-assistant/models.ts";
import { MODEL_PROXY_PREFIX, VOICE_PERMISSION, modelFileKey, type ModelFile } from "../src/voice-assistant/protocol.ts";
import {
  HUGGING_FACE_UPSTREAM,
  isModelHost,
  modelUpstreamUrl,
  voiceAssistantRoutes,
  type VoiceAssistantDeps,
} from "../server/voice-assistant.ts";

const SECRET = "voice-assistant-route-test";

interface ReplyCall {
  url: string;
  body: Record<string, unknown>;
  headers: IncomingMessage["headers"];
  raw: string;
}

const replyCalls: ReplyCall[] = [];
let replyClosed: Promise<void> = Promise.resolve();

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ORG_CONFIG = {
  ttsEngine: "supertonic-3",
  asrEngine: "qwen3-asr-0.6b",
  wakePhrase: "Hola Omni",
  pttStyle: "toggle",
  announceScope: "voice",
};

const transcriptAppends: Array<Record<string, unknown>> = [];

const core = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://core");
  const path = url.pathname;
  if (path === "/v1/voice/access") {
    res.writeHead(200, { "content-type": "application/json" });
    const enabled = url.searchParams.get("principalId") === "alice";
    return void res.end(JSON.stringify(enabled ? { enabled, config: ORG_CONFIG } : { enabled }));
  }
  if (req.method === "POST" && path === "/v1/voice/transcript/activity") {
    const body = JSON.parse(await readRaw(req)) as Record<string, unknown>;
    transcriptAppends.push({ path, ...body });
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ entry: { id: body.entryId } }));
  }
  if (req.method === "POST" && path === "/v1/voice/transcript") {
    const body = JSON.parse(await readRaw(req)) as Record<string, unknown>;
    transcriptAppends.push(body);
    res.writeHead(body.principalId === "alice" ? 200 : 403, { "content-type": "application/json" });
    return void res.end(JSON.stringify(body.principalId === "alice" ? { entries: [] } : { error: "feature_disabled" }));
  }
  if (path === "/v1/voice/transcript") {
    const principal = url.searchParams.get("principalId");
    res.writeHead(principal === "alice" ? 200 : 403, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify(
        principal === "alice"
          ? { entries: [{ id: "e1", role: "assistant", text: `**hola** ${principal}`, at: 1 }] }
          : { error: "feature_disabled" },
      ),
    );
  }
  if (req.method === "POST" && path === "/v1/voice/reply") {
    const raw = await readRaw(req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    replyCalls.push({ url: req.url ?? "", body, headers: req.headers, raw });
    if (body.principalId !== "alice") {
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "feature_disabled" }));
    }
    if (body.purpose === "garbled") {
      res.writeHead(500, { "content-type": "text/plain" });
      return void res.end("boom");
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ type: "delta", text: "Hola" })}\n\n`);
    if (body.purpose === "hang") {
      replyClosed = new Promise((resolve) => res.on("close", resolve));
      return;
    }
    res.write(`data: ${JSON.stringify({ type: "done", model: "claude-sonnet-5-5" })}\n\n`);
    return void res.end();
  }
  res.setHeader("content-type", "application/json");
  if (path === "/v1/admin/whoami") return void res.end(JSON.stringify({ permissions: ["member"] }));
  res.end("{}");
});
const coreBase = await listen(core);

process.env.CORE_API_URL = coreBase;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice,bob";
delete process.env.HF_TOKEN;
delete process.env.VOICE_MODEL_DIR;

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
const base = await listen(surface);

function identity(principalId: string): Record<string, string> {
  return {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: principalId, exp: Date.now() + 60_000 }, SECRET),
    "content-type": "application/json",
  };
}

const FILE: ModelFile = {
  repo: "acme/voice-onnx",
  revision: "0123456789abcdef0123456789abcdef01234567",
  path: "onnx/encoder.onnx",
  bytes: 26,
  sha256: "0".repeat(64),
  role: "asr",
};
const GATED: ModelFile = { ...FILE, repo: "acme/gated-tts", path: "model.q8.gguf", role: "tts", gated: true };
const PAYLOAD = Buffer.from("abcdefghijklmnopqrstuvwxyz");
const FAKE_TOKEN = "fake-hf-token-for-tests";

interface UpstreamHit {
  url: string;
  headers: IncomingMessage["headers"];
}

const hfHits: UpstreamHit[] = [];
const probeHits: Array<{ method?: string; authorization?: string }> = [];
const PROBE_STATUS: Record<string, number> = {
  [`Bearer ${FAKE_TOKEN}`]: 200,
  "Bearer redirected-token": 302,
  "Bearer revoked-token": 401,
  "Bearer ungranted-token": 403,
};
const cdnHits: UpstreamHit[] = [];
const evilHits: UpstreamHit[] = [];
let hfMode:
  | "redirect"
  | "relative"
  | "evil"
  | "direct"
  | "missing"
  | "short"
  | "loop"
  | "unauthorized"
  | "forbidden"
  | "expired" = "redirect";

function serveBytes(req: IncomingMessage, res: ServerResponse): void {
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= PAYLOAD.length) {
      res.writeHead(416, { "content-range": `bytes */${PAYLOAD.length}` });
      return void res.end();
    }
    const slice = PAYLOAD.subarray(start, end + 1);
    res.writeHead(206, {
      "content-length": String(slice.length),
      "content-range": `bytes ${start}-${end}/${PAYLOAD.length}`,
      "accept-ranges": "bytes",
      etag: '"sha"',
      "set-cookie": "tracker=1",
    });
    return void res.end(slice);
  }
  res.writeHead(200, {
    "content-length": String(PAYLOAD.length),
    "accept-ranges": "bytes",
    etag: '"sha"',
    "content-type": "text/html",
    "set-cookie": "tracker=1",
  });
  res.end(PAYLOAD);
}

const cdn = createServer((req, res) => {
  cdnHits.push({ url: req.url ?? "", headers: req.headers });
  if (req.url?.startsWith("/expired")) {
    res.writeHead(403);
    return void res.end("Request has expired");
  }
  serveBytes(req, res);
});
const cdnBase = await listen(cdn);
const evil = createServer((req, res) => {
  evilHits.push({ url: req.url ?? "", headers: req.headers });
  serveBytes(req, res);
});
const evilBase = await listen(evil);
const hf = createServer((req, res) => {
  if (req.url === GATED_MODEL_PROBE_PATH) {
    probeHits.push({ method: req.method, authorization: req.headers.authorization });
    if (req.headers.authorization === "Bearer hung-token") return;
    const status = PROBE_STATUS[req.headers.authorization ?? ""] ?? 500;
    res.writeHead(status, status === 302 ? { location: `${evilBase}/probe` } : {});
    return void res.end();
  }
  hfHits.push({ url: req.url ?? "", headers: req.headers });
  if (req.url?.startsWith("/cache/")) {
    if (req.url.includes(GATED.repo) && req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      res.writeHead(401);
      return void res.end("Access to model is restricted");
    }
    return serveBytes(req, res);
  }
  if (hfMode === "direct") return serveBytes(req, res);
  if (hfMode === "missing") {
    res.writeHead(404);
    return void res.end("Entry not found");
  }
  if (hfMode === "unauthorized") {
    res.writeHead(401);
    return void res.end("Access to model is restricted");
  }
  if (hfMode === "forbidden") {
    res.writeHead(403);
    return void res.end("Access to model is not granted");
  }
  if (hfMode === "short") {
    res.writeHead(200, { "content-length": "3" });
    return void res.end("abc");
  }
  const locations: Record<string, string> = {
    relative: `/cache${req.url}`,
    evil: `${evilBase}/steal`,
    loop: req.url ?? "/",
    redirect: `${cdnBase}/xet/blob?sig=1`,
    expired: `${cdnBase}/expired?sig=1`,
  };
  const location = locations[hfMode]!;
  res.writeHead(302, { location });
  res.end();
});
const hfBase = await listen(hf);

const deps: VoiceAssistantDeps = {
  models: new Map([
    [modelFileKey(FILE), FILE],
    [modelFileKey(GATED), GATED],
  ]),
  coreFetch: async () => ({ status: 200, text: "{}" }),
  coreStream: () => Promise.reject(new Error("unused")),
  readJson: async () => ({}),
  modelUpstream: {
    origin: hfBase,
    allowRedirect: (target) => target.origin === hfBase || target.origin === cdnBase,
  },
  hfToken: ` ${FAKE_TOKEN}\n`,
};
const proxies: Server[] = [];

async function startProxy(overrides: Partial<VoiceAssistantDeps>): Promise<string> {
  const routes = voiceAssistantRoutes({ ...deps, ...overrides });
  const proxy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://surface");
    const found = findRoute(routes, req.method ?? "GET", url.pathname);
    if (!found) {
      res.writeHead(404);
      return void res.end();
    }
    void found.route.handle({ req, res, url, user: "alice" });
  });
  proxies.push(proxy);
  return listen(proxy);
}

const proxyBase = await startProxy({});
const modelUrl = `${proxyBase}${MODEL_PROXY_PREFIX}${modelFileKey(FILE)}`;
const gatedUrl = `${proxyBase}${MODEL_PROXY_PREFIX}${modelFileKey(GATED)}`;

test.after(() => {
  for (const server of [surface, core, hf, cdn, evil, ...proxies]) {
    server.closeAllConnections();
    server.close();
  }
});

test("/me grants the voice permission only when core enables voice for the user", async () => {
  const alice = await (await fetch(`${base}/me`, { headers: identity("alice") })).json();
  assert.ok(alice.permissions.includes(VOICE_PERMISSION));
  const bob = await (await fetch(`${base}/me`, { headers: identity("bob") })).json();
  assert.ok(!bob.permissions.includes(VOICE_PERMISSION));
});

test("the SPA CSP allows same-origin and blob media", async () => {
  const csp = (await fetch(`${base}/connectors/oauth/test/callback`)).headers.get("content-security-policy")!;
  const directives = csp.split(";").map((directive) => directive.trim().split(/\s+/));
  assert.deepEqual(
    directives.find(([name]) => name === "media-src"),
    ["media-src", "'self'", "blob:"],
  );
});

test("voice access relays core's answer for the signed-in user", async () => {
  const response = await fetch(`${base}/api/voice/access`, { headers: identity("alice") });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, config: ORG_CONFIG, gatedModels: false });
  assert.equal((await fetch(`${base}/api/voice/access`)).status, 401);
});

test("the voice transcript is relayed for the signed-in user only", async () => {
  const response = await fetch(`${base}/api/voice/transcript`, { headers: identity("alice") });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    entries: [{ id: "e1", role: "assistant", text: "**hola** alice", at: 1 }],
  });
  const bob = await fetch(`${base}/api/voice/transcript?principalId=alice`, { headers: identity("bob") });
  assert.equal(bob.status, 403, "the principal is pinned to the session user, not the query");
  assert.equal((await fetch(`${base}/api/voice/transcript`)).status, 401);
});

test("transcript notes are appended for the signed-in user only", async () => {
  const entries = [{ role: "user", text: "sí" }];
  const saved = await fetch(`${base}/api/voice/transcript`, {
    method: "POST",
    headers: identity("alice"),
    body: JSON.stringify({ principalId: "mallory", entries }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(transcriptAppends.at(-1), { entries, principalId: "alice" });
  const bob = await fetch(`${base}/api/voice/transcript`, {
    method: "POST",
    headers: identity("bob"),
    body: JSON.stringify({ entries }),
  });
  assert.equal(bob.status, 403);
  const before = transcriptAppends.length;
  assert.equal((await fetch(`${base}/api/voice/transcript`, { method: "POST", body: "{}" })).status, 401);
  assert.equal(transcriptAppends.length, before);
});

test("activity for a transcript entry is relayed for the signed-in user with only the entry and items", async () => {
  const activity = [{ kind: "task_created", title: "Informe", taskRef: "web:alice:voice:1" }];
  const saved = await fetch(`${base}/api/voice/transcript/activity`, {
    method: "POST",
    headers: identity("alice"),
    body: JSON.stringify({ principalId: "mallory", entryId: "e1", activity, extra: true }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(transcriptAppends.at(-1), {
    path: "/v1/voice/transcript/activity",
    entryId: "e1",
    activity,
    principalId: "alice",
  });
  assert.equal((await fetch(`${base}/api/voice/transcript/activity`, { method: "POST", body: "{}" })).status, 401);
});

test("voice access tells the browser whether gated models can be served", async () => {
  const access = async (overrides: Partial<VoiceAssistantDeps>) =>
    (await fetch(`${await startProxy(overrides)}/api/voice/access`)).json();
  const coreFetch: VoiceAssistantDeps["coreFetch"] = async () => ({ status: 200, text: '{"enabled":true}' });
  assert.deepEqual(await access({ coreFetch }), { enabled: true, gatedModels: true });
  const configured: VoiceAssistantDeps["coreFetch"] = async () => ({
    status: 200,
    text: JSON.stringify({ enabled: true, config: ORG_CONFIG }),
  });
  assert.deepEqual(await access({ coreFetch: configured }), { enabled: true, config: ORG_CONFIG, gatedModels: true });
  for (const hfToken of [undefined, "", "  "])
    assert.deepEqual(await access({ coreFetch, hfToken }), { enabled: true, gatedModels: false });
  assert.deepEqual(await access({ coreFetch, hfToken: undefined, localModelDir: "/models" }), {
    enabled: true,
    gatedModels: true,
  });
  const denied = await fetch(
    `${await startProxy({ coreFetch: async () => ({ status: 403, text: "nope" }) })}/api/voice/access`,
  );
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), "nope");
});

async function probedAccess(overrides: Partial<VoiceAssistantDeps>) {
  const coreFetch: VoiceAssistantDeps["coreFetch"] = async () => ({ status: 200, text: '{"enabled":true}' });
  const text = await (await fetch(`${await startProxy({ coreFetch, ...overrides })}/api/voice/access`)).text();
  assert.ok(!text.includes(String(overrides.hfToken).trim()));
  return JSON.parse(text);
}

test("voice access withholds gated models only when Hugging Face refuses the token, asking once per window", async () => {
  evilHits.length = 0;
  for (const [hfToken, gatedModels] of [
    ["redirected-token", true],
    ["revoked-token", false],
    ["ungranted-token", false],
    ["unexpected-token", true],
  ] as const) {
    probeHits.length = 0;
    const answers = await Promise.all([probedAccess({ hfToken: ` ${hfToken}\n` }), probedAccess({ hfToken })]);
    assert.deepEqual(answers, [
      { enabled: true, gatedModels },
      { enabled: true, gatedModels },
    ]);
    assert.deepEqual(await probedAccess({ hfToken }), { enabled: true, gatedModels }, hfToken);
    assert.deepEqual(probeHits, [{ method: "HEAD", authorization: `Bearer ${hfToken}` }], hfToken);
  }
  assert.equal(evilHits.length, 0, "the probe never follows a redirect");
  const offline = { origin: "http://127.0.0.1:9", allowRedirect: () => false };
  assert.deepEqual(await probedAccess({ hfToken: "offline-token", modelUpstream: offline }), {
    enabled: true,
    gatedModels: true,
  });
  probeHits.length = 0;
  assert.deepEqual(await probedAccess({ hfToken: "hf_pasted\u200btoken" }), { enabled: true, gatedModels: false });
  assert.equal(probeHits.length, 0, "a token that cannot be sent as a header is refused without sending it");
});

test(
  "a Hugging Face that never answers leaves gated models on after the probe times out",
  { timeout: 10_000 },
  async () => {
    assert.deepEqual(await probedAccess({ hfToken: "hung-token" }), { enabled: true, gatedModels: true });
  },
);

test("a refused token is asked about again once the window passes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  PROBE_STATUS["Bearer regranted-token"] = 403;
  assert.equal((await probedAccess({ hfToken: "regranted-token" })).gatedModels, false);
  PROBE_STATUS["Bearer regranted-token"] = 200;
  t.mock.timers.tick(4 * 60_000);
  assert.equal((await probedAccess({ hfToken: "regranted-token" })).gatedModels, false);
  t.mock.timers.tick(60_000);
  assert.equal((await probedAccess({ hfToken: "regranted-token" })).gatedModels, true);
});

test("the token probe asks for a gated file the model proxy serves", () => {
  const probed = VOICE_MODEL_FILES.filter(
    (file) => file.gated && modelUpstreamUrl(file, HUGGING_FACE_UPSTREAM.origin).pathname === GATED_MODEL_PROBE_PATH,
  );
  assert.equal(probed.length, 1);
});

test("voice reply streams core SSE, signs the request and pins the principal to the session user", async () => {
  const response = await fetch(`${base}/api/voice/reply`, {
    method: "POST",
    headers: identity("alice"),
    body: JSON.stringify({ purpose: "reply", principalId: "mallory", messages: [] }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  const text = await response.text();
  assert.match(text, /"type":"delta","text":"Hola"/);
  assert.match(text, /"type":"done"/);
  const call = replyCalls.at(-1)!;
  assert.equal(call.body.principalId, "alice");
  assert.match(call.url, /_sourceAuthNonce=/);
  const timestamp = Number(call.headers["x-timestamp"]);
  assert.equal(
    call.headers["x-signature"],
    signRequest(SECRET, timestamp, canonicalPayload("POST", call.url, call.raw)),
  );
  assert.ok(call.headers[PORTAL_IDENTITY_HEADER]);
});

test("voice reply relays core refusals as status and JSON", async () => {
  const refused = await fetch(`${base}/api/voice/reply`, {
    method: "POST",
    headers: identity("bob"),
    body: JSON.stringify({ purpose: "reply", messages: [] }),
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "feature_disabled" });
  const garbled = await fetch(`${base}/api/voice/reply`, {
    method: "POST",
    headers: identity("alice"),
    body: JSON.stringify({ purpose: "garbled", messages: [] }),
  });
  assert.equal(garbled.status, 500);
  assert.deepEqual(await garbled.json(), { error: "upstream_error" });
});

test("voice reply rejects unauthenticated, empty and non-object bodies before calling core", async () => {
  const before = replyCalls.length;
  assert.equal((await fetch(`${base}/api/voice/reply`, { method: "POST", body: "{}" })).status, 401);
  for (const body of ["", "[]", "null", "nope"]) {
    const response = await fetch(`${base}/api/voice/reply`, { method: "POST", headers: identity("alice"), body });
    assert.equal(response.status, 400, body);
  }
  assert.equal(replyCalls.length, before);
});

test("closing the voice reply stream aborts the upstream core request", async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/voice/reply`, {
    method: "POST",
    headers: identity("alice"),
    body: JSON.stringify({ purpose: "hang", messages: [] }),
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /Hola/);
  controller.abort();
  await replyClosed;
});

test("the model proxy requires a session and refuses anything outside the allowlist", async () => {
  assert.equal((await fetch(`${base}${MODEL_PROXY_PREFIX}${modelFileKey(FILE)}`)).status, 401);
  for (const suffix of [
    modelFileKey(FILE),
    "../../etc/passwd",
    "%2e%2e/%2e%2e/etc/passwd",
    "acme/voice-onnx@main/onnx/encoder.onnx",
  ]) {
    const response = await fetch(`${base}${MODEL_PROXY_PREFIX}${suffix}`, { headers: identity("alice") });
    assert.equal(response.status, 404, suffix);
  }
});

test("the model proxy follows allowed redirects and serves immutable octet streams without upstream cookies", async () => {
  hfMode = "redirect";
  hfHits.length = 0;
  cdnHits.length = 0;
  const response = await fetch(modelUrl, { headers: { cookie: "qm_session=secret", authorization: "Bearer x" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("content-length"), String(PAYLOAD.length));
  assert.equal(response.headers.get("etag"), '"sha"');
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PAYLOAD);
  assert.equal(hfHits[0]?.url, `/${FILE.repo}/resolve/${FILE.revision}/${FILE.path}`);
  assert.equal(cdnHits[0]?.url, "/xet/blob?sig=1");
  for (const hit of [...hfHits, ...cdnHits]) {
    assert.equal(hit.headers.cookie, undefined);
    assert.equal(hit.headers.authorization, undefined);
    assert.equal(hit.headers[PORTAL_IDENTITY_HEADER], undefined);
  }
});

test("the model proxy forwards byte ranges through relative redirects", async () => {
  hfMode = "relative";
  const response = await fetch(modelUrl, { headers: { range: "bytes=2-5" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 2-5/${PAYLOAD.length}`);
  assert.equal(await response.text(), "cdef");
  const unsatisfiable = await fetch(modelUrl, { headers: { range: "bytes=99-100" } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${PAYLOAD.length}`);
});

test("the model proxy refuses redirects off the allowed hosts and bad upstream answers", async () => {
  evilHits.length = 0;
  for (const mode of ["evil", "missing", "short", "loop"] as const) {
    hfMode = mode;
    const response = await fetch(modelUrl);
    assert.equal(response.status, 502, mode);
    assert.deepEqual(await response.json(), { error: "upstream_error" });
  }
  assert.equal(evilHits.length, 0);
  hfMode = "direct";
  assert.equal((await fetch(modelUrl)).status, 200);
});

test("gated models send the token on every Hugging Face hop, never to the CDN, and are cached privately", async () => {
  for (const mode of ["redirect", "relative"] as const) {
    hfMode = mode;
    hfHits.length = 0;
    cdnHits.length = 0;
    const response = await fetch(gatedUrl);
    assert.equal(response.status, 200, mode);
    assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PAYLOAD);
    assert.equal(hfHits[0]?.url, `/${GATED.repo}/resolve/${GATED.revision}/${GATED.path}`);
    assert.equal(hfHits.length + cdnHits.length, 2, mode);
    for (const hit of hfHits) assert.equal(hit.headers.authorization, `Bearer ${FAKE_TOKEN}`, mode);
    for (const hit of cdnHits) assert.equal(hit.headers.authorization, undefined, mode);
    const text = JSON.stringify([...response.headers]);
    assert.ok(!text.includes(FAKE_TOKEN));
  }
});

test("gated models answer 503 model_unavailable without a token or when Hugging Face refuses it", async () => {
  hfMode = "direct";
  for (const hfToken of [undefined, "", "  ", "hf_pasted\u200btoken"]) {
    const base = await startProxy({ hfToken });
    hfHits.length = 0;
    const response = await fetch(`${base}${MODEL_PROXY_PREFIX}${modelFileKey(GATED)}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "model_unavailable");
    assert.equal(hfHits.length, 0);
    assert.equal((await fetch(`${base}${MODEL_PROXY_PREFIX}${modelFileKey(FILE)}`)).status, 200);
  }
  for (const mode of ["unauthorized", "forbidden"] as const) {
    hfMode = mode;
    hfHits.length = 0;
    const refused = await fetch(gatedUrl);
    assert.equal(refused.status, 503, mode);
    assert.equal(hfHits[0]?.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    const body = await refused.text();
    assert.equal(JSON.parse(body).error, "model_unavailable");
    assert.ok(!body.includes(FAKE_TOKEN));
  }
});

test("refusals of ungated files or from the CDN stay ordinary upstream errors", async () => {
  for (const [mode, url] of [
    ["unauthorized", modelUrl],
    ["forbidden", modelUrl],
    ["expired", modelUrl],
    ["expired", gatedUrl],
  ] as const) {
    hfMode = mode;
    const response = await fetch(url);
    assert.equal(response.status, 502, `${mode} ${url}`);
    assert.deepEqual(await response.json(), { error: "upstream_error" });
  }
});

test("a local model directory serves exact-size files before upstream and falls back otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-models-"));
  const local = Buffer.from("ZYXWVUTSRQPONMLKJIHGFEDCBA");
  for (const [file, bytes] of [
    [GATED, local],
    [FILE, Buffer.from("short")],
  ] as const) {
    const path = join(dir, file.repo, file.revision, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const base = await startProxy({ localModelDir: dir, hfToken: undefined });
  hfMode = "direct";
  hfHits.length = 0;
  const served = await fetch(`${base}${MODEL_PROXY_PREFIX}${modelFileKey(GATED)}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-length"), String(local.length));
  assert.equal(served.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), local);
  assert.equal(hfHits.length, 0);
  const fallback = await fetch(`${base}${MODEL_PROXY_PREFIX}${modelFileKey(FILE)}`);
  assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), PAYLOAD);
  assert.equal(hfHits.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("only Hugging Face hosts over default-port HTTPS are allowed as redirect targets", () => {
  for (const host of ["huggingface.co", "cdn-lfs.hf.co", "cas-bridge.xethub.hf.co", "cdn-lfs.huggingface.co"]) {
    assert.ok(isModelHost(host), host);
    assert.ok(HUGGING_FACE_UPSTREAM.allowRedirect(new URL(`https://${host}/x`)), host);
  }
  for (const href of [
    "https://huggingface.co.evil.com/x",
    "https://evilhf.co/x",
    "https://evilhuggingface.co/x",
    "http://huggingface.co/x",
    "https://huggingface.co:8443/x",
    "https://127.0.0.1/x",
  ]) {
    assert.ok(!HUGGING_FACE_UPSTREAM.allowRedirect(new URL(href)), href);
  }
});

test("upstream model URLs are built from the pinned manifest entry", () => {
  assert.equal(
    modelUpstreamUrl(FILE, HUGGING_FACE_UPSTREAM.origin).href,
    `https://huggingface.co/acme/voice-onnx/resolve/${FILE.revision}/onnx/encoder.onnx`,
  );
});
