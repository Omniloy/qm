import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

delete process.env.CORE_SIGNING_SECRET;
process.env.CORE_API_URL = "http://127.0.0.1:9";
const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());

const voiceModels = (cookie?: string) => fetch(`${base}/api/voice-models`, cookie ? { headers: { cookie } } : {});

test("voice models report gated availability from the environment without exposing the token", async () => {
  const token = "hf_secret_value_123";
  for (const [env, expected] of [
    [{ HF_TOKEN: token }, true],
    [{ VOICE_MODEL_DIR: "/models" }, true],
    [{ HF_TOKEN: "   " }, false],
    [{}, false],
  ] as const) {
    delete process.env.HF_TOKEN;
    delete process.env.VOICE_MODEL_DIR;
    Object.assign(process.env, env);
    const r = await voiceModels("admin=U-admin");
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { gatedModels: expected });
    assert.ok(!text.includes(token));
  }
  delete process.env.HF_TOKEN;
  delete process.env.VOICE_MODEL_DIR;
});

test("voice models require a signed-in principal", async () => {
  const r = await voiceModels();
  assert.equal(r.status, 401);
});
