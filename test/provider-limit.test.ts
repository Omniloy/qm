import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  NonRetryableTurnError,
  providerLimit,
  providerLimitMessage,
  settleProviderLimit,
  turnFailureKind,
  turnFailureMessage,
} from "../src/core/turn-error.ts";
import { userFacingFailureText } from "../src/core/failure-copy.ts";
import { codexProxyResetAt, type CodexProxy } from "../src/model/codex-proxy.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const COOLDOWN =
  'OpenAI API error (429): {"code":"model_cooldown","message":"All credentials for model gpt-6-sol are cooling down via provider codex"}';
const COOLDOWN_WITH_RESET =
  'OpenAI API error (429): {"code":"model_cooldown","message":"All credentials for model gpt-6-sol are cooling down via provider codex","reset_seconds":80003,"reset_time":"22h13m22s"}';
const CODEX_USAGE = (field: string) =>
  `Codex turn failed: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"prolite",${field}}}`;
const ANTHROPIC_RATE =
  "Model provider API error (rate_limit_error): This request would exceed your organization's rate limit of 50,000 input tokens per minute.";

const NOW = Date.UTC(2026, 9, 2, 20, 3);
const RESET = Date.UTC(2026, 9, 3, 18, 3);
const FAR_RESET = Date.UTC(2036, 9, 4, 18, 3);

async function withProxy(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  run: (proxy: CodexProxy) => Promise<void>,
): Promise<void> {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await run({ url: `http://127.0.0.1:${port}`, managementKey: "mgmt-key" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function authFiles(resetsAt: number[]) {
  return JSON.stringify({
    files: [
      { name: "gemini.json", provider: "gemini", status: "error", status_message: '{"error":{"resets_at":1}}' },
      ...resetsAt.map((at, i) => ({
        name: `codex-${i}.json`,
        provider: "codex",
        status: "error",
        status_message: JSON.stringify({
          error: { type: "usage_limit_reached", resets_at: Math.floor(at / 1000), limit_window_minutes: 10080 },
        }),
      })),
      { name: "codex-ok.json", provider: "codex", status: "active", status_message: "" },
    ],
  });
}

test("the codex proxy cooldown is a usage limit on the ChatGPT subscription, model named, reset unknown", () => {
  assert.deepEqual(providerLimit(new Error(COOLDOWN), undefined, NOW), {
    kind: "usage",
    viaCodexProxy: true,
    provider: "OpenAI",
    model: "gpt-6-sol",
    subscription: "the connected ChatGPT subscription",
  });
});

test("a non-streaming cooldown carries its reset in seconds", () => {
  assert.equal(providerLimit(new Error(COOLDOWN_WITH_RESET), undefined, NOW)?.resetAt, NOW + 80_003_000);
});

test("a Codex usage_limit_reached reads resets_at or resets_in_seconds and falls back to the turn's model", () => {
  const absolute = providerLimit(new Error(CODEX_USAGE(`"resets_at":${RESET / 1000}`)), "gpt-6-sol", NOW);
  assert.equal(absolute?.kind, "usage");
  assert.equal(absolute?.provider, "OpenAI");
  assert.equal(absolute?.model, "gpt-6-sol");
  assert.equal(absolute?.resetAt, RESET);
  const relative = providerLimit(new Error(CODEX_USAGE(`"resets_in_seconds":900`)), undefined, NOW);
  assert.equal(relative?.resetAt, NOW + 900_000);
});

test("an Anthropic rate_limit_error is a rate limit", () => {
  const limit = providerLimit(new Error(ANTHROPIC_RATE), "claude-opus-5", NOW);
  assert.equal(limit?.kind, "rate");
  assert.equal(limit?.provider, "Anthropic");
  assert.equal(limit?.model, "claude-opus-5");
  assert.equal(limit?.resetAt, undefined);
});

test("ordinary failures are not provider limits", () => {
  for (const message of ["socket hang up", "boom: simulated turn fault", "OpenAI API error (500): upstream"]) {
    assert.equal(providerLimit(new Error(message)), null, message);
  }
});

test("the message names provider, model and subscription, with a relative and UTC reset", () => {
  const limit = providerLimit(new Error(COOLDOWN), undefined, NOW)!;
  assert.equal(
    providerLimitMessage({ ...limit, resetAt: RESET }, NOW),
    "You've reached the OpenAI usage limit for gpt-6-sol on the connected ChatGPT subscription. It resets in about 22 hours (Sat 3 Oct, 18:03 UTC). Pick another model to keep working now.",
  );
  assert.match(providerLimitMessage({ ...limit, resetAt: NOW + 15 * 60_000 }, NOW), /resets in 15 minutes \(/);
  assert.match(providerLimitMessage({ ...limit, resetAt: NOW + 3 * 86_400_000 }, NOW), /resets in about 3 days \(/);
});

test("without a known reset the message says to try later or switch model", () => {
  assert.equal(
    turnFailureMessage(new Error(COOLDOWN)),
    "You've reached the OpenAI usage limit for gpt-6-sol on the connected ChatGPT subscription. Try again later or pick another model.",
  );
  assert.equal(
    turnFailureMessage(new NonRetryableTurnError(ANTHROPIC_RATE)),
    "You've reached the Anthropic rate limit. Try again later or pick another model.",
  );
});

test("a usage limit settles into a non-retryable failure whose message survives turnFailureMessage", async () => {
  const raw = new Error(CODEX_USAGE(`"resets_in_seconds":80003`));
  const settled = await settleProviderLimit(raw, { model: "gpt-6-sol" });
  assert.ok(settled instanceof NonRetryableTurnError);
  assert.equal(settled.cause, raw);
  assert.match(settled.message, /^You've reached the OpenAI usage limit for gpt-6-sol on the connected ChatGPT/);
  assert.match(settled.message, /resets in about 22 hours/);
  assert.equal(turnFailureMessage(settled), settled.message);
  assert.equal(turnFailureKind(settled), "provider_limit");
});

test("only provider limits mark their failure reason as user-facing", () => {
  assert.equal(turnFailureKind(new Error(ANTHROPIC_RATE)), "provider_limit");
  assert.equal(turnFailureKind(new NonRetryableTurnError("swarm service unavailable")), undefined);
  assert.equal(turnFailureKind(new Error("socket hang up")), undefined);
});

test("transient rate limits stay on the retry path", async () => {
  const unknown = new Error(ANTHROPIC_RATE);
  assert.equal(await settleProviderLimit(unknown, {}), unknown);
  const soon = new Error(CODEX_USAGE(`"resets_in_seconds":30`));
  assert.equal(await settleProviderLimit(soon, {}), soon);
  const ordinary = new Error("socket hang up");
  assert.equal(await settleProviderLimit(ordinary, {}), ordinary);
});

test("a proxy cooldown takes its reset from the earliest cooling codex account", async () => {
  const seen: Array<string | undefined> = [];
  await withProxy(
    (req, res) => {
      seen.push(req.headers["x-management-key"] as string | undefined);
      res.end(
        req.url === "/v0/management/auth-files"
          ? authFiles([FAR_RESET + 86_400_000, FAR_RESET, Date.now() - 60_000])
          : "{}",
      );
    },
    async (proxy) => {
      assert.equal(await codexProxyResetAt(proxy), FAR_RESET);
      const settled = await settleProviderLimit(new Error(COOLDOWN), { codexProxy: proxy });
      assert.ok(settled instanceof NonRetryableTurnError);
      assert.match(
        settled.message,
        /It resets in .* \(Sat 4 Oct, 18:03 UTC\)\. Pick another model to keep working now\.$/,
      );
    },
  );
  assert.deepEqual(seen, ["mgmt-key", "mgmt-key"]);
});

test("the proxy is not consulted when the error already carries its reset or is not a proxy limit", async () => {
  let calls = 0;
  await withProxy(
    (_req, res) => {
      calls++;
      res.end(authFiles([FAR_RESET]));
    },
    async (proxy) => {
      await settleProviderLimit(new Error(COOLDOWN_WITH_RESET), { codexProxy: proxy });
      await settleProviderLimit(new Error(ANTHROPIC_RATE), { codexProxy: proxy });
      await settleProviderLimit(new Error(CODEX_USAGE(`"plan_type_only":1`)), { codexProxy: proxy });
    },
  );
  assert.equal(calls, 0);
});

test("a failing, garbled or hung proxy leaves the reset unknown without throwing", async () => {
  await withProxy(
    (_req, res) => {
      res.statusCode = 500;
      res.end("nope");
    },
    async (proxy) => {
      const settled = await settleProviderLimit(new Error(COOLDOWN), { codexProxy: proxy });
      assert.ok(settled instanceof NonRetryableTurnError);
      assert.match(settled.message, /Try again later or pick another model\.$/);
    },
  );
  await withProxy(
    (_req, res) => res.end("not json"),
    async (proxy) => assert.equal(await codexProxyResetAt(proxy), undefined),
  );
  await withProxy(
    () => {},
    async (proxy) => assert.equal(await codexProxyResetAt(proxy, 50), undefined),
  );
  assert.equal(await codexProxyResetAt({ url: "http://127.0.0.1:1", managementKey: "k" }, 500), undefined);
});

test("a turn that hits the proxy usage limit parks on its first attempt with the reset in the transcript", async () => {
  await withProxy(
    (_req, res) => res.end(authFiles([FAR_RESET])),
    async (codexProxy) => {
      const { app, runs } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-")), codexProxy }));
      const dm = (text: string, idempotencyKey?: string) => ({
        surface: "test",
        actor: { externalId: "U1" },
        conversation: { kind: "dm" as const, threadRef: "dm:U1:limit" },
        text,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      const first = await app.turn(dm("hello"));
      assert.equal(first.status, "ok");
      await assert.rejects(app.turn(dm("!usage-limit", "usage-limit-1")), /usage limit for gpt-6-sol/);
      assert.equal(await runs.activeForThread("dm:U1:limit"), null, "parked on the first attempt, no retry queued");
      const parked = await runs.latestForThread("dm:U1:limit");
      assert.equal(parked?.status, "failed");
      assert.equal(parked?.result?.refusalKind, "provider_limit");
      assert.match(userFacingFailureText(parked!.result!), /^You've reached the OpenAI usage limit for gpt-6-sol/);
      const session = await app.getSession(first.sessionId!);
      const failures = session!.entries.filter(
        (e) => e.type === "system" && (e.payload as { kind?: string }).kind === "turn_failure",
      );
      assert.equal(failures.length, 1);
      assert.match(
        (failures[0]!.payload as { message: string }).message,
        /^You've reached the OpenAI usage limit for gpt-6-sol on the connected ChatGPT subscription\. It resets in .* \(Sat 4 Oct, 18:03 UTC\)\./,
      );
    },
  );
});

test("an OpenAI billing quota 429 keeps its own message instead of a rate-limit hint", () => {
  const err = new NonRetryableTurnError(
    'OpenAI API error (429): {"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}',
  );
  assert.equal(providerLimit(err), null);
  assert.equal(turnFailureMessage(err), err.message);
});
