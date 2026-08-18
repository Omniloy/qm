import { marked } from "marked";
import DOMPurify, { type Config } from "dompurify";

export const MARKDOWN_SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ["annotation", "semantics"],
  ADD_ATTR: ["target", "encoding"],
};

let installed = false;

export function installMarkdownSanitizer(): void {
  if (installed) return;
  // DOMPurify binds to `window` at import time. With no DOM its `sanitize` is not even a function,
  // so installing the hook in a plain-node process would make every test that renders markdown
  // throw. There is no XSS sink without a DOM either, so skipping is safe — and it deliberately
  // does NOT latch `installed`, so a later call from a real page still installs.
  if (!DOMPurify.isSupported || typeof DOMPurify.sanitize !== "function") return;
  installed = true;
  marked.use({ hooks: { postprocess: (html: string) => String(DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG)) } });
}

// Installed as a side effect of THIS module, not of chat.ts.
//
// It used to run only in chat.ts's module body. chat.ts statically imports ./shell and ./sessions,
// so the anonymous share page cannot import it — which meant every markdown renderer outside
// chat.ts (share-view.ts is the first) shipped marked's raw HTML: `marked.parse("<script>…")`
// returns the script tag verbatim with no hook installed, and `<img src=x onerror=…>` keeps its
// handler. Anything that renders markdown now gets the sanitizer by importing this module, which
// is the one thing every renderer already has to do.
installMarkdownSanitizer();
