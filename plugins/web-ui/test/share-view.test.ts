/**
 * Behavioural tests for the anonymous share page.
 *
 * The headline case is the CRITICAL red-team finding: the sanitizer is installed by chat.ts's
 * module body, the share page must not import chat.ts, and the natural refactor therefore ships a
 * share page that renders marked's raw HTML. Every hostile vector below would be live XSS on the
 * app origin if `installMarkdownSanitizer()` were not called from share-view.ts itself.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
// Type-only, therefore fully erased: it cannot load the module before the DOM globals exist.
import type { SharedEntry, SharedTranscript } from "../src/share-view.ts";

const SHARE_ID = "a".repeat(36) + "b".repeat(32);
// No `?t=`: the share id IS the secret and core mints no capability token. A page that asked for
// one could never build a copyable link, which is exactly the bug this suite now pins shut.
const PAGE_URL = `https://app.example/share/${SHARE_ID}`;

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: PAGE_URL });
Object.assign(globalThis as Record<string, unknown>, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  DocumentFragment: dom.window.DocumentFragment,
});

// Imported after the DOM globals exist: DOMPurify binds to `window` at module load, and a
// DOMPurify that binds to nothing is a DOMPurify whose sanitize() is the identity function.
const view = await import("../src/share-view.ts");

type Entry = SharedEntry;
type Transcript = SharedTranscript;

function transcript(over: Partial<Transcript> = {}): Transcript {
  return { title: "Ship the thing", access: "anonymous", entries: [], ...over };
}

function entry(over: Partial<Entry> = {}): Entry {
  return { i: 0, role: "assistant", text: "hello", ...over };
}

function host(): HTMLElement {
  const div = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(div);
  return div as unknown as HTMLElement;
}

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

interface FakeNet {
  calls: string[];
  reply: (url: string) => Response;
  fetchImpl: typeof fetch;
}

function net(reply: (url: string) => Response): FakeNet {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return reply(url);
  }) as unknown as typeof fetch;
  return { calls, reply, fetchImpl };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ------------------------------------------------------------------ sanitizer */

const HOSTILE: Array<[string, string]> = [
  ["script tag", "hi <script>alert(1)</script>"],
  ["img onerror", '<img src=x onerror="alert(1)">'],
  ["javascript: href", "[click](javascript:alert(document.cookie))"],
  ["svg onload", "<svg onload=alert(1)></svg>"],
  ["iframe", "<iframe src=/api/files/x/content></iframe>"],
  ["a onclick", '<a href="#" onclick="alert(1)">x</a>'],
  [
    // The exact chain from the red-team finding: a same-origin <script src> pointed at the new
    // share-scoped file route, which CSP `script-src 'self'` would happily execute.
    "same-origin script src at the share file route",
    `<script src="/api/public/shares/${SHARE_ID}/files/evil"></script>`,
  ],
];

for (const role of ["assistant", "user"] as const) {
  test(`share page sanitizes hostile markdown in ${role} messages`, () => {
    for (const [name, text] of HOSTILE) {
      const row = view.messageEl(entry({ role, text }), SHARE_ID);
      const html = row.innerHTML;
      assert.equal(row.querySelector("script"), null, `${name}: <script> survived as ${html}`);
      assert.equal(row.querySelector("iframe"), null, `${name}: <iframe> survived as ${html}`);
      assert.ok(
        !/onerror=|onload=|onclick=|javascript:/i.test(html),
        `${name}: handler or javascript: url survived as ${html}`,
      );
    }
  });
}

test("the sanitizer is installed by importing share-view, not by importing chat", () => {
  // If this ever regresses, the assertion above stops proving anything about the real page — so
  // pin the fact that share-view.ts is self-sufficient about it.
  assert.ok(!/<script/i.test(view.renderMarkdown("<script>alert(1)</script>")));
  assert.match(view.renderMarkdown("**bold**"), /<strong>bold<\/strong>/);
});

test("ordinary formatting still renders — sanitizing must not mean stripping the product", () => {
  assert.match(view.renderMarkdown("```js\nconst x = 1;\n```"), /<(pre|code)/);
  assert.match(view.renderMarkdown("[docs](https://example.com/a)"), /href="https:\/\/example\.com\/a"/);
});

/* ------------------------------------------------------------------ attachments */

test("attachments render as download chips on the share-scoped path, never inline", () => {
  const row = view.messageEl(
    entry({
      role: "user",
      text: "here you go",
      files: [{ name: "shot.png", artifactId: "art-1", sizeBytes: 2048 }],
    }),
    SHARE_ID,
  );
  assert.equal(row.querySelector("img"), null, "an image attachment must not render inline");
  const chip = row.querySelector("a.file-chip");
  assert.ok(chip, "expected a download chip");
  const href = chip.getAttribute("href") ?? "";
  assert.ok(href.includes(`/api/public/shares/${SHARE_ID}/files/art-1`), href);
  assert.ok(!href.includes("/api/files/"), `attachments must never point at the ACL'd route: ${href}`);
  assert.equal(chip.getAttribute("download"), "shot.png");
  assert.ok(!href.includes("t="), `an attachment link carries no capability token: ${href}`);
  assert.match(row.textContent ?? "", /shot\.png/);
  assert.match(row.textContent ?? "", /2\.0 KB/);
});

test("no row publishes its transcript sequence number", () => {
  const row = view.messageEl(entry({ i: 417, text: "hi" }), SHARE_ID);
  assert.equal(row.getAttribute("data-index"), null, "a seq number counts what the redaction removed");
  assert.ok(!row.outerHTML.includes("417"));
});

test("an id-shaped sharer label never reaches the page, not even its local part", () => {
  // One rule, shared with the dialog (sharerName in share-state.ts). The page strangers read is
  // not the surface that should have the looser version of it.
  assert.equal(view.sharerDisplayLabel("dana.lee@corp.example"), "a member of this project");
  assert.equal(view.sharerDisplayLabel("web:dana:1"), "a member of this project");
  assert.equal(view.sharerDisplayLabel("Dana Lee"), "Dana Lee");
  assert.equal(view.sharerDisplayLabel("  "), "a member of this project");
  assert.equal(view.sharerDisplayLabel(undefined), "a member of this project");
});

/* ------------------------------------------------------------------ access states */

test("anonymous readers get a sign-in button that returns them to the share", () => {
  const strip = view.accessStripEl(transcript({ access: "anonymous" }), "/share/abc");
  assert.match(strip.textContent ?? "", /You're viewing a shared conversation/);
  const btn = strip.querySelector("a.share-signin");
  assert.ok(btn, "anonymous readers need a sign-in affordance");
  assert.equal(btn.getAttribute("href"), `/auth/login?returnTo=${encodeURIComponent("/share/abc")}`);
});

test("outsiders are told they lack access and are NOT offered sign-in", () => {
  const strip = view.accessStripEl(transcript({ access: "outsider", viewerLabel: "Dana" }), "/share/abc");
  assert.match(strip.textContent ?? "", /you don't have access to this project/);
  assert.match(strip.textContent ?? "", /signed in as Dana/);
  assert.equal(strip.querySelector("a.share-signin"), null, "a sign-in button here reads as broken");
});

test("outsiders with no viewer label still get the access sentence, never an empty name", () => {
  const strip = view.accessStripEl(transcript({ access: "outsider" }), "/share/abc");
  assert.match(strip.textContent ?? "", /You're signed in, but you don't have access to this project/);
  assert.ok(!/signed in as\s*,/.test(strip.textContent ?? ""));
});

test("members get Open in MiniOmni, and only members carry a sessionId", () => {
  const strip = view.accessStripEl(transcript({ access: "member", sessionId: "sess-9" }), "/share/abc");
  assert.match(strip.textContent ?? "", /You're a member of this project/);
  const open = strip.querySelector("a.share-open-app");
  assert.ok(open);
  assert.equal(open.getAttribute("href"), "/?session=sess-9");
  // A member payload that somehow arrives without a sessionId must not render a broken link.
  const bare = view.accessStripEl(transcript({ access: "member" }), "/share/abc");
  assert.equal(bare.querySelector("a.share-open-app"), null);
});

/* ------------------------------------------------------------------ live polling */

test("the page polls and appends new entries without re-rendering what is already there", async () => {
  let round = 0;
  const timers: Array<() => void> = [];
  const n = net(() =>
    json(
      transcript({
        access: "anonymous",
        entries:
          round++ === 0
            ? [entry({ i: 0, role: "user", text: "first" })]
            : [entry({ i: 0, role: "user", text: "first" }), entry({ i: 1, role: "assistant", text: "second" })],
      }),
    ),
  );
  const root = host();
  const handle = view.mountShareView(root, {
    shareId: SHARE_ID,
    fetchImpl: n.fetchImpl,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => false,
  });
  await flush();
  assert.equal(root.querySelectorAll("article.message-row").length, 1);
  const firstNode = root.querySelector("article.message-row");

  timers.shift()?.();
  await flush();
  const rows = root.querySelectorAll("article.message-row");
  assert.equal(rows.length, 2, "the second poll must append the new message");
  assert.equal(rows[0], firstNode, "an unchanged message must not be re-created on every poll");
  assert.match(root.textContent ?? "", /second/);
  handle.stop();
});

test("every request goes to /api/public/shares/ and nowhere else", async () => {
  const timers: Array<() => void> = [];
  const n = net(() => json(transcript({ entries: [entry()] })));
  const handle = view.mountShareView(host(), {
    shareId: SHARE_ID,
    fetchImpl: n.fetchImpl,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => false,
  });
  await flush();
  timers.shift()?.();
  await flush();
  assert.ok(n.calls.length >= 2, "expected the live poll to have fired");
  for (const url of n.calls) {
    assert.ok(url.startsWith("/api/public/shares/"), `unexpected request: ${url}`);
    assert.ok(!/\/me\b|\/api\/sessions|\/api\/runtime-config|\/api\/files|\/api\/deliveries/.test(url), url);
    assert.ok(!/[?&]t=/.test(url), `there is no capability token to forward: ${url}`);
  }
  handle.stop();
});

test("the poll carries a cursor that can only ever re-ask, never skip", async () => {
  const timers: Array<() => void> = [];
  const n = net(() =>
    json(
      transcript({
        entries: [entry({ i: 0, role: "user", text: "first" }), entry({ i: 7, role: "assistant", text: "seventh" })],
      }),
    ),
  );
  const handle = view.mountShareView(host(), {
    shareId: SHARE_ID,
    fetchImpl: n.fetchImpl,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => false,
  });
  await flush();
  assert.ok(!n.calls[0]!.includes("sinceIndex"), "the first load asks for the whole transcript");
  timers.shift()?.();
  await flush();
  // 7, not 8: an off-by-one that asks for too much costs a duplicate; one that asks for too
  // little loses a message forever on a page whose entire point is being live.
  assert.match(n.calls[1] ?? "", /sinceIndex=7\b/);
  handle.stop();
});

test("the default poll interval is ten seconds", () => {
  assert.equal(view.POLL_MS, 10_000);
});

/* ------------------------------------------------------------------ failure states */

test("a 404 mid-poll swaps to the dead-link page immediately", async () => {
  let alive = true;
  const timers: Array<() => void> = [];
  const n = net(() => (alive ? json(transcript({ entries: [entry({ text: "still here" })] })) : json({}, 404)));
  const root = host();
  const handle = view.mountShareView(root, {
    shareId: SHARE_ID,
    fetchImpl: n.fetchImpl,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => false,
  });
  await flush();
  assert.match(root.textContent ?? "", /still here/);

  alive = false;
  timers.shift()?.();
  await flush();
  assert.equal(handle.status(), "dead");
  assert.match(root.textContent ?? "", /This link isn't active/);
  assert.ok(!/still here/.test(root.textContent ?? ""), "a revoked share must not leave the transcript on screen");
  handle.stop();
});

test("a 401 leaves the transcript on screen instead of mounting an auth gate", async () => {
  let code = 200;
  const timers: Array<() => void> = [];
  const n = net(() => (code === 200 ? json(transcript({ entries: [entry({ text: "readable" })] })) : json({}, 401)));
  const root = host();
  const handle = view.mountShareView(root, {
    shareId: SHARE_ID,
    fetchImpl: n.fetchImpl,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => false,
  });
  await flush();
  code = 401;
  timers.shift()?.();
  await flush();
  assert.notEqual(handle.status(), "dead", "401 is the normal state of an anonymous reader, not a dead link");
  assert.match(root.textContent ?? "", /readable/);
  assert.equal(root.querySelector("a.share-signin") !== null, true, "the anonymous strip stays put");
  handle.stop();
});

test("a network failure on first load explains itself without erasing the page", async () => {
  const fetchImpl = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const root = host();
  const handle = view.mountShareView(root, {
    shareId: SHARE_ID,
    fetchImpl,
    setTimer: () => 0,
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => false,
  });
  await flush();
  assert.equal(handle.status(), "error");
  assert.match(root.textContent ?? "", /Couldn't reach the server/);
  handle.stop();
});

test("polling stops while the tab is hidden and never fires after stop()", async () => {
  const timers: Array<() => void> = [];
  const n = net(() => json(transcript({ entries: [entry()] })));
  const handle = view.mountShareView(host(), {
    shareId: SHARE_ID,
    fetchImpl: n.fetchImpl,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => true,
  });
  await flush();
  const afterMount = n.calls.length;
  timers.shift()?.();
  await flush();
  assert.equal(n.calls.length, afterMount, "a hidden tab must not keep polling an unauthenticated route");
  handle.stop();
  timers.shift()?.();
  await flush();
  assert.equal(n.calls.length, afterMount);
});

/* ------------------------------------------------------------------ url matching */

test("the share path matcher is anchored", () => {
  assert.equal(view.shareIdFromPath(`/share/${SHARE_ID}`), SHARE_ID);
  assert.equal(view.shareIdFromPath(`/share/${SHARE_ID}/../sessions`), null);
  assert.equal(view.shareIdFromPath(`/sharex/${SHARE_ID}`), null);
  assert.equal(view.shareIdFromPath("/share/short"), null);
  assert.equal(view.shareIdFromPath("/"), null);
});

test("the persistent footer says exactly what is and isn't shared", async () => {
  const n = net(() => json(transcript({ sharerLabel: "dana.lee@corp.example", entries: [entry()] })));
  const root = host();
  const handle = view.mountShareView(root, {
    shareId: SHARE_ID,
    fetchImpl: n.fetchImpl,
    setTimer: () => 0,
    clearTimer: () => {},
    currentPath: () => "/share/x",
    isHidden: () => false,
  });
  await flush();
  // The qualifier "in the transcript" is load-bearing: a log the agent wrote from command output
  // ships as a download chip on this very page, so the unqualified sentence would be false.
  assert.match(
    root.textContent ?? "",
    /Messages and attached files are shared\. Tool activity, command output, and thinking are not shown in the transcript\./,
  );
  assert.match(root.textContent ?? "", /Shared by a member of this project/);
  assert.ok(!(root.textContent ?? "").includes("dana.lee"), "the page must not publish the sharer's address");
  handle.stop();
});
