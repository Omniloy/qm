import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFastSpeed,
  fastModeChannel,
  fastModeIsActive,
  modelSupportsFastMode,
  wantsFastMode,
  TURN_PROVIDER_EFFORT_ALIASES,
} from "../src/harness/pi-harness.ts";
import { defaultInteractiveThinkingLevel } from "../src/model/pi-models.ts";

test("modelSupportsFastMode allows only the documented fast-capable ids", () => {
  for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
    assert.equal(modelSupportsFastMode(id), true, `${id} should support fast mode`);
  }
  for (const id of [
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4.8",
    "anthropic/claude-opus-4.8-fast",
    "",
    undefined,
  ]) {
    assert.equal(modelSupportsFastMode(id as string | undefined), false, `${String(id)} must not support fast mode`);
  }
});

test('applyFastSpeed injects speed:"fast" into the body only when fast is requested', () => {
  const on = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  assert.equal(applyFastSpeed(on, true), on, "returns the same object (in-place mutation)");
  assert.equal(on.speed, "fast");

  const off = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  applyFastSpeed(off, false);
  applyFastSpeed(off, undefined);
  assert.equal("speed" in off, false, "no speed field on a non-fast turn");
});

test("applyFastSpeed never throws on non-object payloads", () => {
  assert.doesNotThrow(() => applyFastSpeed(undefined, true));
  assert.doesNotThrow(() => applyFastSpeed(null, true));
  assert.doesNotThrow(() => applyFastSpeed("raw", true));
});

test("fast mode reaches OpenAI as service_tier and Anthropic as speed", () => {
  const openai = {} as Record<string, unknown>;
  applyFastSpeed(openai, true, { provider: "openai" });
  assert.equal(openai.service_tier, "fast", "OpenAI takes fast mode as service_tier");
  assert.equal("speed" in openai, false, "Anthropic's field must not ride along — it is not a parameter there");

  const anthropic = {} as Record<string, unknown>;
  applyFastSpeed(anthropic, true, { provider: "anthropic" });
  assert.equal(anthropic.speed, "fast");
  assert.equal("service_tier" in anthropic, false);

  // Callers that know nothing about the model keep the shape they always got.
  const unknown = {} as Record<string, unknown>;
  applyFastSpeed(unknown, true);
  assert.equal(unknown.speed, "fast");
});

test("fastModeChannel sends only OpenAI down the per-request path", () => {
  assert.equal(fastModeChannel("openai"), "payload");
  assert.equal(fastModeChannel("anthropic"), "header");
  assert.equal(fastModeChannel(undefined), "header", "an unknown provider keeps the prior behaviour");
});

test("fastModeIsActive trusts the header for Anthropic and intent for OpenAI", () => {
  const withBeta = { provider: "anthropic", headers: { "anthropic-beta": "fast-mode-2026-02-01" } };
  const withoutBeta = { provider: "anthropic", headers: {} };
  assert.equal(fastModeIsActive(withBeta, true), true);
  // The switch did not take, so the turn is not fast however it was asked for.
  assert.equal(fastModeIsActive(withoutBeta, true), false);

  // OpenAI writes nothing on the model, so a missing header proves nothing.
  assert.equal(fastModeIsActive({ provider: "openai", headers: {} }, true), true);
  assert.equal(fastModeIsActive({ provider: "openai", headers: {} }, false), false);
});

test("only the GPT model OpenAI documents for fast mode is marked fast-capable", () => {
  assert.equal(modelSupportsFastMode("gpt-5.6-sol"), true);
  for (const id of ["gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.equal(modelSupportsFastMode(id), false, `${id} is not documented for fast mode`);
  }
});

test("TURN_PROVIDER_EFFORT_ALIASES maps web-ui aliases to Anthropic effort values", () => {
  assert.equal(TURN_PROVIDER_EFFORT_ALIASES.max, "max");
  assert.equal(
    TURN_PROVIDER_EFFORT_ALIASES.ultracode,
    "max",
    "Ultracode is a UI alias, not a provider effort enum (#312)",
  );
  assert.equal(TURN_PROVIDER_EFFORT_ALIASES.auto, null, "auto leaves effort to the provider/default path");
});

test("defaultInteractiveThinkingLevel keeps human turns light by provider", () => {
  assert.equal(defaultInteractiveThinkingLevel({ provider: "anthropic", api: "anthropic-messages" }), "low");
  assert.equal(defaultInteractiveThinkingLevel({ provider: "openai", api: "openai-responses" }), "auto");
});

test("fast mode is opt-in: only an explicit true selects it", () => {
  // A turn that never mentions fastMode has expressed no preference. Reading that as "yes"
  // bills it against a tier nobody asked for, and on an organization with no fast-mode
  // quota the provider rejects every such turn outright.
  assert.equal(wantsFastMode(undefined, "claude-opus-5"), false, "unset must not select fast mode");
  assert.equal(wantsFastMode(false, "claude-opus-5"), false);
  assert.equal(wantsFastMode(true, "claude-opus-5"), true, "an explicit opt-in is honoured");
});

test("an explicit opt-in still cannot select fast mode on a model that lacks it", () => {
  assert.equal(wantsFastMode(true, "claude-sonnet-5"), false);
  assert.equal(wantsFastMode(true, undefined), false);
  assert.equal(wantsFastMode(true, ""), false);
});
