import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = readFileSync(join(process.cwd(), "skills-seed/browse/SKILL.md"), "utf8");

test("the browser is registered with QM, so the person gets a pane", () => {
  assert.match(SKILL, /POST "\$AGENT_API_URL\/v1\/browser-sessions"/);
  assert.match(SKILL, /liveViewUrl/);
  assert.match(SKILL, /expiresAt/);
});

test("a live-view URL is never handed to the person as a link", () => {
  // It is bearer material: whoever holds it can watch and drive a browser
  // logged in as that person. The pane holds it instead, and a transcript is
  // forever.
  assert.doesNotMatch(SKILL, /hand the person `\$LIVE_VIEW`/);
  assert.match(SKILL, /never paste one into the conversation/);
  assert.match(SKILL, /Take control/);
});

test("the CDP URL is not what gets registered", () => {
  // Some providers embed the API key in it, and this value reaches a tab.
  const register = /v1\/browser-sessions"[\s\S]{0,400}/.exec(SKILL)?.[0] ?? "";
  assert.doesNotMatch(register, /CDP_URL/);
  assert.match(SKILL, /Send `LIVE_VIEW`, never `CDP_URL`/);
});

test("the runner parks between steps while a person holds the wheel", () => {
  // Verified against browser-use 0.12.9: Agent.run awaits on_step_start, so a
  // coroutine hook genuinely blocks the next step rather than being dropped.
  assert.match(SKILL, /on_step_start=lambda _a: wait_for_the_wheel\(\)/);
  assert.match(SKILL, /BROWSE_STATE_URL/);
  assert.match(SKILL, /controlMode/);
  // Parking must not become a hang when core is unreachable.
  assert.match(SKILL, /Cannot ask: carry on rather than stall forever/);
});

test("every runner invocation is told where to check for the wheel", () => {
  // Only the lines that actually RUN it — the heredoc that writes the file
  // also mentions the path, and counting that would hide a missing one.
  const invocations = [...SKILL.matchAll(/venv\/bin\/python \/tmp\/browse-runner\.py/g)];
  assert.ok(invocations.length >= 2, "there is more than one invocation to keep in step");
  const states = [...SKILL.matchAll(/BROWSE_STATE_URL="/g)];
  assert.equal(
    states.length,
    invocations.length,
    "an invocation without BROWSE_STATE_URL silently disables Take control for that path",
  );
});

test("cleanup releases the pane, not just the browser", () => {
  assert.match(SKILL, /DELETE "\$AGENT_API_URL\/v1\/browser-sessions/);
});
