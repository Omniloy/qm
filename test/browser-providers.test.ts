import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILT_IN_BROWSER_ID,
  browserProviderIds,
  loadBrowserProviders,
  parseBrowserProviderDoc,
} from "../src/connectors/browser-providers.ts";

const GOOD = `---
id: anchor
name: Anchor
summary: Hosted Chrome with stealth.
keyEnv: ANCHOR_API_KEY
keyService: anchor
profileEnv: ANCHOR_PROFILE
profileService: anchor-profile
signupUrl: https://app.anchorbrowser.io/api-keys
---

# Browse provider: Anchor
`;

function seedDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "browser-providers-"));
  const dir = join(root, "browse", "providers");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return root;
}

test("a provider doc describes itself", () => {
  const spec = parseBrowserProviderDoc(GOOD);
  assert.deepEqual(spec, {
    id: "anchor",
    name: "Anchor",
    summary: "Hosted Chrome with stealth.",
    keyEnv: "ANCHOR_API_KEY",
    keyService: "anchor",
    profileEnv: "ANCHOR_PROFILE",
    profileService: "anchor-profile",
    signupUrl: "https://app.anchorbrowser.io/api-keys",
  });
});

test("a doc without front-matter or missing a required field is not a provider", () => {
  assert.equal(parseBrowserProviderDoc("# Just prose\n"), null);
  assert.equal(parseBrowserProviderDoc("---\nid: x\nname: X\n---\n"), null);
});

test("a half-written provider is skipped rather than taking the page down", () => {
  const root = seedDir({ "anchor.md": GOOD, "wip.md": "# still writing this\n" });
  const specs = loadBrowserProviders(root);
  assert.deepEqual(
    specs.map((spec) => spec.id),
    ["anchor"],
  );
});

test("no providers directory yields no providers, not a throw", () => {
  assert.deepEqual(loadBrowserProviders(mkdtempSync(join(tmpdir(), "empty-"))), []);
});

test("the built-in browser is always an option and always comes first", () => {
  const specs = loadBrowserProviders(seedDir({ "anchor.md": GOOD }));
  assert.deepEqual(browserProviderIds(specs), [BUILT_IN_BROWSER_ID, "anchor"]);
});

test("the shipped provider docs each describe themselves", () => {
  const specs = loadBrowserProviders("skills-seed");
  // The catalog is the docs. If one stops parsing, the picker silently loses a
  // provider, so this asserts the shipped set rather than the parser alone.
  assert.deepEqual(specs.map((spec) => spec.id).sort(), ["anchor", "browserbase", "kernel"]);
  for (const spec of specs) {
    assert.ok(spec.keyEnv.endsWith("_API_KEY"), `${spec.id} key env`);
    assert.ok(spec.signupUrl?.startsWith("https://"), `${spec.id} signup url`);
  }
});
