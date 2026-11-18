import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../local/Dockerfile", import.meta.url), "utf8");

function envValue(name: string): string | undefined {
  return new RegExp(`^ENV ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1];
}

function pipRequirements(): string[] {
  const args = /^RUN pip install((?: \\\n\s+\S+)+)$/m.exec(dockerfile)?.[1];
  assert.ok(args, "the local image must bake its Python tooling in one pip install");
  return args
    .split("\\\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("caches the image bakes live outside the per-scope home volume", () => {
  const home = envValue("HOME");
  assert.equal(home, "/root");
  for (const name of ["PLAYWRIGHT_BROWSERS_PATH", "HF_HUB_CACHE"]) {
    const dir = envValue(name);
    assert.ok(dir?.startsWith("/opt/"), `${name} must point at a baked path outside ${home}, got ${dir}`);
  }
});

test("pip writes no download cache into the home volume", () => {
  assert.equal(envValue("PIP_NO_CACHE_DIR"), "1");
});

test("every baked Python package is pinned to an exact version", () => {
  const requirements = pipRequirements();
  assert.ok(requirements.length > 0);
  for (const requirement of requirements) assert.match(requirement, /^[a-z0-9][a-z0-9.-]*==[0-9][\w.]*$/);
  assert.ok(requirements.some((r) => r.startsWith("playwright==")));
});

test("the build clears what it wrote under /root, which Docker would copy into every new home volume", () => {
  const browserStep = dockerfile.indexOf("playwright install");
  assert.ok(browserStep > 0);
  assert.ok(dockerfile.indexOf("rm -rf /root/.cache", browserStep) > browserStep);
});
