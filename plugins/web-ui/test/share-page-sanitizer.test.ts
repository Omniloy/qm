/**
 * The share page's markdown sanitizer, proved on the import path the page actually has.
 *
 * This file deliberately imports NOTHING from share-view.ts. The red-team finding it closes was
 * that the only DOMPurify install in the client lived in chat.ts's module body — and the share
 * page cannot import chat.ts, because chat.ts statically imports ./shell, whose module body
 * installs the sign-in handler. So the sanitizer's install site had to move to a module every
 * markdown renderer already imports, and the only honest way to test that is to import that one
 * module and nothing else, exactly as a fresh page would.
 *
 * Every payload below is live XSS on the app origin if `marked` ships its raw HTML: a shared
 * conversation is attacker-influenced text rendered on the same origin as the signed-in app.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.example/share/x" });
Object.assign(globalThis as Record<string, unknown>, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  DocumentFragment: dom.window.DocumentFragment,
});

// After the DOM globals exist, and — the point of the file — with no other module in the graph.
// DOMPurify binds to `window` at import time, so a DOMPurify that binds to nothing sanitizes
// nothing; importing later is not a nicety.
await import("../src/markdown-sanitize.ts");
const { marked } = await import("marked");

const render = (text: string): string => String(marked.parse(text, { async: false }));

const HOSTILE: Array<[string, string]> = [
  ["script tag", "hi <script>alert(1)</script>"],
  ["img onerror", '<img src=x onerror="alert(1)">'],
  ["javascript: href", "[click](javascript:alert(document.cookie))"],
  ["svg onload", "<svg onload=alert(1)></svg>"],
  ["iframe", "<iframe src=/api/files/x/content></iframe>"],
  ["a onclick", '<a href="#" onclick="alert(1)">x</a>'],
  ["object data", '<object data="data:text/html,<script>alert(1)</script>"></object>'],
];

test("importing markdown-sanitize is what installs the hook — no other module is involved", () => {
  for (const [name, text] of HOSTILE) {
    const html = render(text);
    assert.ok(!/<script/i.test(html), `${name}: <script> survived as ${html}`);
    assert.ok(!/<iframe/i.test(html), `${name}: <iframe> survived as ${html}`);
    assert.ok(!/<object/i.test(html), `${name}: <object> survived as ${html}`);
    assert.ok(!/on(error|load|click)\s*=/i.test(html), `${name}: an event handler survived as ${html}`);
    assert.ok(!/javascript:/i.test(html), `${name}: a javascript: url survived as ${html}`);
  }
});

test("sanitizing is not stripping — the product still renders", () => {
  assert.match(render("**bold**"), /<strong>bold<\/strong>/);
  assert.match(render("```js\nconst x = 1;\n```"), /<(pre|code)/);
  assert.match(render("[docs](https://example.com/a)"), /href="https:\/\/example\.com\/a"/);
});

test("the install is idempotent, so a second caller cannot double-sanitize", async () => {
  const { installMarkdownSanitizer } = await import("../src/markdown-sanitize.ts");
  installMarkdownSanitizer();
  installMarkdownSanitizer();
  assert.equal(render("**bold**").match(/<strong>/g)?.length, 1);
  assert.ok(!/<script/i.test(render("<script>alert(1)</script>")));
});
