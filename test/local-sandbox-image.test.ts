import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalSandbox } from "../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";

const dockerfile = readFileSync(new URL("../local/Dockerfile", import.meta.url), "utf8");
const constraints = readFileSync(new URL("../local/agent-constraints.txt", import.meta.url), "utf8");

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

function envValue(name: string): string | undefined {
  return [...dockerfile.matchAll(new RegExp(`^ENV ${name}=(\\S+)$`, "gm"))].at(-1)?.[1];
}

function pipPackages(): string[] {
  const installs = [...dockerfile.matchAll(/pip3? install/g)];
  assert.equal(installs.length, 1, "the local image installs Python packages in exactly one place");
  const args = /^RUN pip install -c \/tmp\/agent-constraints\.txt((?: \\\n\s+[a-z0-9-]+)+)/m.exec(dockerfile)?.[1];
  assert.ok(args, "the pip install must be bound to the constraints file");
  return args
    .split("\\\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function pinnedVersions(): Map<string, string> {
  const pins = new Map<string, string>();
  for (const line of constraints.split("\n").filter(Boolean)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][\w.]*)$/.exec(line);
    assert.ok(match, `constraint line must be an exact pin: ${line}`);
    pins.set(normalize(match[1]!), match[2]!);
  }
  return pins;
}

const profileSpec = () =>
  createLocalSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "local-image-"))), {}).profile.spec;

test("caches the image bakes live outside the per-scope home volume, set before the steps that fill them", () => {
  assert.equal(envValue("HOME"), "/root");
  assert.equal(envValue("HF_HOME"), undefined, "the Hugging Face token must stay in the home volume");
  assert.equal(envValue("XDG_CACHE_HOME"), undefined);
  for (const [name, step] of [
    ["PLAYWRIGHT_BROWSERS_PATH", "playwright install"],
    ["HF_HUB_CACHE", "download_model("],
  ] as const) {
    assert.ok(envValue(name)?.startsWith("/opt/"), `${name} must point at a baked path outside /root`);
    assert.ok(dockerfile.indexOf(`ENV ${name}=`) < dockerfile.indexOf(step), `${name} must be set before ${step}`);
  }
});

test("pip writes no download cache into the home volume", () => {
  assert.equal(envValue("PIP_NO_CACHE_DIR"), "1");
});

test("every Python package in the image comes from the exact-pin lock", () => {
  const pins = pinnedVersions();
  const packages = pipPackages();
  assert.ok(packages.length > 0);
  for (const pkg of packages) assert.ok(pins.has(normalize(pkg)), `${pkg} has no pin in local/agent-constraints.txt`);
  assert.match(dockerfile, /&& pip check/);
});

test("the build clears what it wrote under /root, which Docker would copy into every new home volume", () => {
  const lastBakeStep = dockerfile.indexOf("download_model(");
  assert.ok(lastBakeStep > 0);
  assert.ok(dockerfile.indexOf("rm -rf /root/.cache", lastBakeStep) > lastBakeStep);
});

test("the agent's environment profile names the tooling the image bakes", () => {
  const spec = profileSpec();
  const python = spec?.runtimes?.find((r) => r.startsWith("Python")) ?? "";
  for (const pkg of pipPackages()) assert.ok(python.includes(pkg), `profile does not mention ${pkg}`);
  const tools = spec?.tools?.join(" ") ?? "";
  for (const bin of ["soffice", "tesseract", "pdftotext", "ffmpeg"]) {
    assert.match(dockerfile, new RegExp(`\\b${bin}\\b`));
    assert.ok(tools.includes(bin), `profile does not mention ${bin}`);
  }
});
