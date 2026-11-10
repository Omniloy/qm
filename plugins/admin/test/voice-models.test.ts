import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { GATED_MODEL_PROBE_PATH, HUGGING_FACE_ORIGIN } from "../../chassis/src/hugging-face.ts";

delete process.env.CORE_SIGNING_SECRET;
process.env.CORE_API_URL = "http://127.0.0.1:9";
const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const PROBE_STATUS: Record<string, number> = {
  "Bearer hf_accepted_secret": 200,
  "Bearer hf_revoked_secret": 401,
  "Bearer hf_ungranted_secret": 403,
};
const probes: Array<{ url: string; method?: string; authorization: string | null }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(HUGGING_FACE_ORIGIN)) return realFetch(input, init);
  const authorization = new Headers(init?.headers).get("authorization");
  probes.push({ url, method: init?.method, authorization });
  if (authorization === "Bearer hf_offline_secret") throw new TypeError("fetch failed");
  return new Response(null, { status: PROBE_STATUS[authorization ?? ""] ?? 500 });
};
test.after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

const voiceModels = (cookie?: string) => fetch(`${base}/api/voice-models`, cookie ? { headers: { cookie } } : {});

test("voice models report whether Hugging Face accepts the token without exposing it", async () => {
  for (const [env, expected, probed] of [
    [{ HF_TOKEN: " hf_accepted_secret\n" }, "servable", true],
    [{ HF_TOKEN: "hf_revoked_secret" }, "token_refused", true],
    [{ HF_TOKEN: "hf_ungranted_secret" }, "token_refused", true],
    [{ HF_TOKEN: "hf_offline_secret" }, "unchecked", true],
    [{ HF_TOKEN: "hf_pasted\u200bsecret" }, "token_refused", false],
    [{ VOICE_MODEL_DIR: "/models", HF_TOKEN: "hf_revoked_secret" }, "servable", false],
    [{ HF_TOKEN: "   " }, "no_token", false],
    [{}, "no_token", false],
  ] as const) {
    delete process.env.HF_TOKEN;
    delete process.env.VOICE_MODEL_DIR;
    Object.assign(process.env, env);
    probes.length = 0;
    const r = await voiceModels("admin=U-admin");
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { gatedModelAccess: expected }, JSON.stringify(env));
    assert.ok(!text.includes("secret"));
    const token = "HF_TOKEN" in env ? env.HF_TOKEN.trim() : "";
    const expectedProbes = probed
      ? [{ url: `${HUGGING_FACE_ORIGIN}${GATED_MODEL_PROBE_PATH}`, method: "HEAD", authorization: `Bearer ${token}` }]
      : [];
    assert.deepEqual(probes, expectedProbes, JSON.stringify(env));
  }
  delete process.env.HF_TOKEN;
  delete process.env.VOICE_MODEL_DIR;
});

test("voice models require a signed-in principal", async () => {
  const r = await voiceModels();
  assert.equal(r.status, 401);
});
