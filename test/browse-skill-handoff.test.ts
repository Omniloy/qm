import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAW = readFileSync(join(process.cwd(), "skills-seed/browse/SKILL.md"), "utf8");
// Prose assertions run against a whitespace-flattened copy: this is markdown,
// and a formatter rewrapping a line should not fail a test about what the file
// SAYS. Code and shape assertions keep using RAW.
const SKILL = RAW.replace(/\s+/g, " ");

test("the browser is registered with QM, so the person gets a pane", () => {
  assert.match(RAW, /POST "\$AGENT_API_URL\/v1\/browser-sessions"/);
  assert.match(SKILL, /liveViewUrl/);
  assert.match(SKILL, /expiresAt/);
});

test("a live-view URL is never handed to the person as a link", () => {
  // It is bearer material: whoever holds it can watch and drive a browser
  // logged in as that person. The pane holds it instead, and a transcript is
  // forever.
  assert.doesNotMatch(RAW, /hand the person `\$LIVE_VIEW`/);
  assert.match(SKILL, /never paste one into the conversation/);
  assert.match(SKILL, /Take control/);
});

test("the CDP URL is not what gets registered", () => {
  // Some providers embed the API key in it, and this value reaches a tab.
  const register = /v1\/browser-sessions"[\s\S]{0,400}/.exec(RAW)?.[0] ?? "";
  assert.doesNotMatch(register, /CDP_URL/);
  assert.match(SKILL, /Send `LIVE_VIEW`, never `CDP_URL`/);
});

test("the runner parks between steps while a person holds the wheel", () => {
  // Verified against browser-use 0.12.9: Agent.run awaits on_step_start, so a
  // coroutine hook genuinely blocks the next step rather than being dropped.
  assert.match(RAW, /on_step_start=lambda _a: wait_for_the_wheel\(\)/);
  assert.match(SKILL, /BROWSE_STATE_URL/);
  assert.match(SKILL, /controlMode/);
  // Parking must not become a hang when core is unreachable.
  assert.match(RAW, /Cannot ask: carry on rather than stall forever/);
});

test("the runner finds the wheel even when the invocation forgets to say", () => {
  // Caught on the deployed stack: the agent composed its own command line and
  // dropped BROWSE_STATE_URL, so control flipped in core and the runner never
  // looked. A contract that depends on an agent copying an env var is not a
  // contract. The create step now writes the value to a file the runner reads.
  assert.match(RAW, /\/tmp\/browse-state-url/);
  assert.match(RAW, /\/tmp\/browse-state-token/);
  const fn = /def _state_url\(\):[\s\S]{0,400}/.exec(RAW)?.[0] ?? "";
  assert.match(fn, /BROWSE_STATE_URL/, "the env var still wins when present");
  assert.match(fn, /open\("\/tmp\/browse-state-url"\)/, "and the file is the fallback");
});

test("every runner invocation is told where to check for the wheel", () => {
  // Only the lines that actually RUN it — the heredoc that writes the file
  // also mentions the path, and counting that would hide a missing one.
  const invocations = [...RAW.matchAll(/venv\/bin\/python \/tmp\/browse-runner\.py/g)];
  assert.ok(invocations.length >= 2, "there is more than one invocation to keep in step");
  const states = [...RAW.matchAll(/BROWSE_STATE_URL="/g)];
  assert.equal(
    states.length,
    invocations.length,
    "an invocation without BROWSE_STATE_URL silently disables Take control for that path",
  );
});

test("cleanup releases the pane, not just the browser", () => {
  assert.match(RAW, /DELETE "\$AGENT_API_URL\/v1\/browser-sessions/);
});

test("a missing key sends the person to Keychain, not into a search", () => {
  // The credential UI already exists — Add credential with a service, an env
  // key and a one-time page. The skill's job is to name it, not to invent a
  // second way in.
  assert.match(SKILL, /Keychain \u2192 Add credential/);
  assert.match(SKILL, /ANCHOR_API_KEY/);
  assert.match(SKILL, /never passes through the conversation/);
});

test("both keys are asked for at once, because one of them is useless alone", () => {
  // Caught on the deployed stack: with only a provider key the agent reports
  // "blocked pending a model key" and the person is back where they started.
  // Browsing needs a browser AND a model to drive it.
  const missing = /None set \u2192.{0,1200}/.exec(SKILL)?.[0] ?? "";
  assert.match(missing, /ANCHOR_API_KEY/);
  assert.match(missing, /BROWSE_LAB_ANTHROPIC_KEY/);
  assert.match(missing, /both/i);
});

test("a personal key is never offered in a shared room", () => {
  const missing = /None set \u2192.{0,1200}/.exec(SKILL)?.[0] ?? "";
  assert.match(missing, /channel or group/);
  assert.match(missing, /never be minted into a shared room/);
});
