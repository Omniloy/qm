import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sep } from "node:path";
import test from "node:test";
import katexFacade from "../src/lazy-katex.ts";
import hljsFacade from "../src/lazy-hljs.ts";

test("katex facade renders math as escaped text before the real library loads", () => {
  const out = katexFacade.renderToString('x < y & "z"');
  assert.match(out, /^<span class="math-pending">/);
  assert.ok(out.includes("x &lt; y &amp; &quot;z&quot;"), "math text must be HTML-escaped");
  assert.ok(!out.includes("<y"), "no raw angle brackets survive");
});

test("hljs facade highlights as escaped plain text before the real library loads", () => {
  const out = hljsFacade.highlight('if (a < b) alert("hi");', { language: "javascript" });
  assert.equal(out.value, "if (a &lt; b) alert(&quot;hi&quot;);");
  const auto = hljsFacade.highlightAuto("<script>alert(1)</script>");
  assert.ok(!auto.value.includes("<script>"), "auto path must escape too");
});

test("hljs facade reports no language pre-load, so code-block takes the auto path", () => {
  assert.equal(hljsFacade.getLanguage("javascript"), undefined);
});

test("stub grammar registration is a safe no-op", () => {
  assert.doesNotThrow(() => hljsFacade.registerLanguage("javascript", () => ({})));
});

const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

test("vite aliases route katex and highlight.js through the lazy facades", () => {
  assert.match(vite, /find: \/\^katex\$\/, replacement: here\("src\/lazy-katex\.ts"\)/);
  assert.match(vite, /find: \/\^highlight\\\.js\\\/lib\\\/core\$\/, replacement: here\("src\/lazy-hljs\.ts"\)/);
  assert.match(
    vite,
    /find: \/\^highlight\\\.js\\\/lib\\\/languages\\\/\.\*\$\/, replacement: here\("src\/hljs-lang-stub\.ts"\)/,
  );
  const langOrder = ["javascript", "typescript", "python", "xml", "css", "json", "bash", "sql", "markdown"];
  for (const lang of langOrder) {
    assert.ok(vite.includes(`hljs-real-${lang}`), `real grammar alias for ${lang}`);
  }
});

test("the real-library aliases point INTO the packages, never back at the facades", () => {
  assert.match(vite, /find: "katex-real", replacement: here\("node_modules\/katex\/dist\/katex\.mjs"\)/);
  assert.match(vite, /find: "hljs-real", replacement: here\("node_modules\/highlight\.js\/lib\/core\.js"\)/);
});

const srcRoot = new URL("../src/", import.meta.url);
const appSources = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file: file.split(sep).join("/"), text: readFileSync(new URL(file, srcRoot), "utf8") }));

test("only the voice assistant chunk imports onnxruntime-web or vad-web", () => {
  for (const { file, text } of appSources) {
    if (file.startsWith("voice-assistant/")) continue;
    assert.doesNotMatch(text, /from "(onnxruntime-web|@ricky0123\/vad-web)/, file);
  }
  const ortImporters = appSources
    .filter(({ text }) => /^import (?!type )[^;]*from "onnxruntime-web/m.test(text))
    .map(({ file }) => file);
  assert.deepEqual(ortImporters.sort(), ["voice-assistant/speech.worker.ts", "voice-assistant/tts.worker.ts"]);
});

test("the app reaches the voice assistant lazily and statically loads only its settings, protocol and voice catalog", () => {
  const allowed = new Set(["protocol.ts", "settings-store.ts", "voice-picker.ts", "voices.ts"]);
  for (const { file, text } of appSources) {
    if (file.startsWith("voice-assistant/")) continue;
    for (const match of text.matchAll(/^import[^;]*?from "\.\/voice-assistant\/([^"]+)"/gm))
      assert.ok(allowed.has(match[1]!), `${file} statically imports voice-assistant/${match[1]}`);
  }
  const shell = appSources.find(({ file }) => file === "shell.ts")!.text;
  assert.match(shell, /import\("\.\/voice-assistant\/index\.ts"\)/);
  const settings = appSources.find(({ file }) => file === "voice-settings.ts")!.text;
  assert.match(settings, /import\("\.\/voice-assistant\/index\.ts"\)/);
  const index = appSources.find(({ file }) => file === "voice-assistant/index.ts")!.text;
  assert.match(index, /new Worker\(new URL\("\.\/speech\.worker\.ts", import\.meta\.url\)/);
  assert.match(index, /new Worker\(new URL\("\.\/tts\.worker\.ts", import\.meta\.url\)/);
});
