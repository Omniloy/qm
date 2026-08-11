import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BRAND } from "../plugins/chassis/src/brand.ts";
import { BRAND as CLI_BRAND } from "../cli/src/brand.ts";

test("the CLI's brand copy agrees with the chassis brand", () => {
  for (const key of Object.keys(CLI_BRAND) as (keyof typeof CLI_BRAND)[]) {
    assert.equal(CLI_BRAND[key], BRAND[key], `cli/src/brand.ts ${key} drifted from plugins/chassis/src/brand.ts`);
  }
});

test("the shipped Slack manifests carry the brand", () => {
  for (const path of ["src/slack/manifest.json", "cli/templates/slack-manifest.json"]) {
    const manifest = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as {
      display_information: { name: string; background_color: string };
      features: { bot_user: { display_name: string } };
    };
    assert.equal(manifest.display_information.name, BRAND.slackAppName, path);
    assert.equal(manifest.display_information.background_color, BRAND.slackBackgroundColor, path);
    assert.equal(manifest.features.bot_user.display_name, BRAND.slackBotHandle, path);
  }
});

test("the Slack bot handle is spelled the way Slack accepts", () => {
  assert.match(BRAND.slackBotHandle, /^[a-z0-9._-]{1,80}$/);
  assert.ok(BRAND.slackAppName.length <= 35, "Slack caps display_information.name at 35 characters");
  assert.ok(BRAND.slackAppDescription.length <= 140, "Slack caps display_information.description at 140 characters");
});

test("the extension manifest carries the brand and every icon it declares", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")) as {
    name: string;
    description: string;
    icons: Record<string, string>;
    action: { default_title: string; default_icon: Record<string, string> };
  };
  assert.equal(manifest.name, BRAND.extensionName);
  assert.equal(manifest.action.default_title, BRAND.extensionName);
  assert.ok(manifest.description.includes(BRAND.productName));
  for (const file of [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) {
    const bytes = readFileSync(new URL(`../extension/${file}`, import.meta.url));
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), file);
  }
});

test("the favicon is linked absolutely, so it survives a nested route", () => {
  const server = readFileSync(join(process.cwd(), "plugins/web-ui/server/index.ts"), "utf8");
  const rewrites = server.match(/"%BASE_URL%favicon\.svg",\s*"([^"]+)"/g) ?? [];
  assert.ok(rewrites.length > 0, "the shell rewrites the favicon placeholder");
  for (const r of rewrites) {
    assert.match(r, /"\/favicon\.svg"/, `a relative href resolves against the current path: ${r}`);
  }
});

test("the sidebar mark is the brand logo, not an upstream letter", () => {
  const css = readFileSync(join(process.cwd(), "plugins/web-ui/src/shell.css"), "utf8");
  assert.doesNotMatch(css, /--brand-mark:\s*"A"/, "upstream's letter mark");
  assert.doesNotMatch(css, /--brand-accent:\s*#4f46e5/i, "upstream's indigo");
  assert.match(css, /--brand-logo,\s*url\("\/favicon\.svg"\)/, "the mark falls back to the brand logo");
});

test("a deployed app carries an icon", () => {
  const shell = readFileSync(join(process.cwd(), "src/deploy/app-shell.ts"), "utf8");
  assert.match(shell, /<link rel="icon" href="\/favicon\.svg">/);
});
