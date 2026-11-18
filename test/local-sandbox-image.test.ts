import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalSandbox } from "../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";

const dockerfile = readFileSync(new URL("../local/Dockerfile", import.meta.url), "utf8");
const constraints = readFileSync(new URL("../local/agent-constraints.txt", import.meta.url), "utf8");
const PIP_INSTALL = "RUN pip install -c /tmp/agent-constraints.txt";

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, word: string) => new RegExp(`(^|[\\s,(])${escape(word)}([\\s,);]|$)`).test(text);

function envOnce(name: string): string | undefined {
  const values = [...dockerfile.matchAll(new RegExp(`^ENV ${name}=(\\S+)$`, "gm"))].map((m) => m[1]);
  assert.ok(values.length <= 1, `${name} must be set at most once, found ${values.length}`);
  return values[0];
}

function pipPackages(): string[] {
  assert.equal([...dockerfile.matchAll(/pip3? install/g)].length, 1, "Python packages are installed in one place");
  const start = dockerfile.indexOf(PIP_INSTALL);
  const end = dockerfile.indexOf("&& pip check", start);
  assert.ok(start >= 0 && end > start, "the pip install must be bound to the constraints file and pip check");
  const tokens = dockerfile
    .slice(start + PIP_INSTALL.length, end)
    .split(/[\s\\]+/)
    .filter(Boolean);
  for (const token of tokens) assert.match(token, /^[a-z0-9][a-z0-9-]*$/, `not a bare package name: ${token}`);
  return tokens;
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
  assert.equal(envOnce("HOME"), "/root");
  assert.equal(envOnce("HF_HOME"), undefined, "the Hugging Face token must stay in the home volume");
  assert.equal(envOnce("XDG_CACHE_HOME"), undefined);
  for (const [name, step] of [
    ["PLAYWRIGHT_BROWSERS_PATH", "playwright install"],
    ["HF_HUB_CACHE", "download_model("],
  ] as const) {
    assert.ok(envOnce(name)?.startsWith("/opt/"), `${name} must point at a baked path outside /root`);
    assert.ok(dockerfile.indexOf(`ENV ${name}=`) < dockerfile.indexOf(step), `${name} must be set before ${step}`);
  }
});

test("pip writes no download cache into the home volume", () => {
  assert.equal(envOnce("PIP_NO_CACHE_DIR"), "1");
});

test("the venv is exactly the exact-pin lock", () => {
  const pins = pinnedVersions();
  const packages = pipPackages();
  assert.ok(packages.length > 0);
  for (const pkg of packages) assert.ok(pins.has(normalize(pkg)), `${pkg} has no pin in local/agent-constraints.txt`);
  assert.match(dockerfile, /pip freeze > (\S+) \\\n\s+&& diff \1 \/tmp\/agent-constraints\.txt/);
});

test("the build clears what it wrote under /root, which Docker would copy into every new home volume", () => {
  const lastBakeStep = dockerfile.indexOf("download_model(");
  assert.ok(lastBakeStep > 0);
  assert.ok(dockerfile.indexOf("rm -rf /root/.cache", lastBakeStep) > lastBakeStep);
});

test("the agent's environment profile names the tooling the image bakes", () => {
  const spec = profileSpec();
  const python = spec?.runtimes?.find((r) => r.startsWith("Python")) ?? "";
  for (const pkg of pipPackages()) assert.ok(mentions(python, pkg), `profile does not mention ${pkg}`);
  const tools = spec?.tools?.join(", ") ?? "";
  for (const bin of ["soffice", "tesseract", "pdftotext", "ffmpeg"]) {
    assert.match(dockerfile, new RegExp(`\\b${bin}\\b`));
    assert.ok(mentions(tools, bin), `profile does not mention ${bin}`);
  }
});
