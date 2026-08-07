import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the sandbox base permits Claude Code's required install script", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /npm install -g --allow-scripts=@anthropic-ai\/claude-code/);
});

test("the browse client is installed in every build, not just the release", () => {
  // Regression: the venv skills/browse imports lived inside the
  // INSTALL_BROWSER_ENGINE=1 block, which only the GitHub release workflow
  // passes. Every other build — including the one Dokploy runs — shipped an
  // image where /opt/browser-engine/venv did not exist, so the skill could not
  // start at all. The client and the browser are separate concerns: the client
  // is always needed because the browser it drives is remote.
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");

  const venvInstall = /python3 -m venv \/opt\/browser-engine\/venv/.exec(dockerfile);
  assert.ok(venvInstall, "the browse client venv must be built");

  const engineGate = dockerfile.indexOf('if [ "$INSTALL_BROWSER_ENGINE" = "1" ]');
  assert.ok(engineGate > 0, "the optional local-browser block should still exist");
  assert.ok(
    venvInstall.index < engineGate,
    "the venv must be installed before, and outside, the INSTALL_BROWSER_ENGINE block",
  );
});

test("a local chromium stays optional, because the browser being driven is remote", () => {
  const dockerfile = readFileSync(new URL("../fly/Dockerfile", import.meta.url), "utf8");
  const engineBlock = dockerfile.slice(dockerfile.indexOf('if [ "$INSTALL_BROWSER_ENGINE" = "1" ]'));
  assert.match(engineBlock, /chromium/, "chromium belongs behind the flag");
  assert.doesNotMatch(
    engineBlock,
    /pip install --no-cache-dir "browser-use/,
    "the client must not be reintroduced behind the flag",
  );
});
