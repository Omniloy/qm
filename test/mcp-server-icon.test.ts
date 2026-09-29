import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpServerStore,
  mcpServerIcon,
  parseMcpIconUrl,
  singleLineName,
  type McpServer,
} from "../src/mcp/mcp-server-store.ts";
import { iconLinksFromHtml, resolveMcpSiteIcon } from "../src/mcp/mcp-icon.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

test("icon URLs must be plain https image links", () => {
  assert.equal(parseMcpIconUrl(undefined), undefined);
  assert.equal(parseMcpIconUrl(""), undefined);
  assert.equal(parseMcpIconUrl("  "), undefined);
  assert.equal(parseMcpIconUrl(" https://cdn.example.com/a.png "), "https://cdn.example.com/a.png");
  for (const bad of [
    "http://cdn.example.com/a.png",
    "data:image/png;base64,AAAA",
    "https://cdn.example.com/a'b.png",
    "https://cdn.example.com/a<b.png",
    "https://cdn.example.com/a\\b.png",
    "https://cdn.example.com/a\tb.png",
    "https://localhost/a.png",
    "https://u:p@cdn.example.com/a.png",
    `https://cdn.example.com/${"x".repeat(2048)}`,
    {},
  ])
    assert.equal(parseMcpIconUrl(bad), null, String(bad));
});

test("an explicit icon wins over the resolved one, and nothing is guessed without either", () => {
  assert.equal(mcpServerIcon({}), undefined);
  assert.equal(
    mcpServerIcon({ resolvedIconUrl: "https://www.granola.ai/favicon/favicon.svg" }),
    "https://www.granola.ai/favicon/favicon.svg",
  );
  assert.equal(
    mcpServerIcon({ iconUrl: "https://cdn.example.com/l.png", resolvedIconUrl: "https://linear.app/icon.svg" }),
    "https://cdn.example.com/l.png",
  );
});

const GRANOLA_HOME = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="/_next/static/css/app.css"/></head><body>${"x".repeat(300_000)}
<link rel="manifest" href="/favicon/site.webmanifest"/>
<link rel="icon" href="/favicon/favicon.ico" sizes="any"/>
<link rel="icon" href="/favicon/favicon-96x96.png" sizes="96x96" type="image/png"/>
<link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml"/>
<link rel="apple-touch-icon" href="/favicon/apple-touch-icon.png" sizes="180x180"/>
</body></html>`;

test("icon links are ranked svg, then raster of at least 32px, then ico, and only safe https links survive", () => {
  assert.deepEqual(iconLinksFromHtml(GRANOLA_HOME, "https://www.granola.ai/"), [
    "https://www.granola.ai/favicon/favicon.svg",
    "https://www.granola.ai/favicon/favicon-96x96.png",
    "https://www.granola.ai/favicon/apple-touch-icon.png",
    "https://www.granola.ai/favicon/favicon.ico",
  ]);
  const page = `<head>
    <LINK REL='Shortcut Icon' HREF='/s.ico?v=1&amp;x=2'>
    <link rel="icon" sizes="16x16" href="/tiny.png">
    <link rel="mask-icon" href="/mask.svg">
    <link rel="icon" href="data:image/png;base64,AAAA">
    <link rel="icon" href="http://cdn.example.com/plain.svg">
    <link rel="icon" href="//static.tools.example.com/proto.png" sizes="48x48">
    <link rel="icon" href='/a"b.svg'>
  </head>`;
  assert.deepEqual(iconLinksFromHtml(page, "https://tools.example.com/"), [
    "https://tools.example.com/a%22b.svg",
    "https://static.tools.example.com/proto.png",
    "https://tools.example.com/s.ico?v=1&x=2",
    "https://tools.example.com/tiny.png",
  ]);
  assert.deepEqual(iconLinksFromHtml("<html><body>no icons</body></html>", "https://tools.example.com/"), []);
});

test("only icons on the homepage's own site or its subdomains are accepted", () => {
  const page = [
    "https://granola.ai/apex.svg",
    "https://cdn.granola.ai/cdn.svg",
    "https://www.granola.ai/www.svg",
    "https://evil.example.com/tracker.svg",
    "https://notgranola.ai/x.svg",
    "https://granola.ai.evil.com/x.svg",
  ]
    .map((href) => `<link rel="icon" href="${href}">`)
    .join("");
  assert.deepEqual(iconLinksFromHtml(page, "https://www.granola.ai/"), [
    "https://granola.ai/apex.svg",
    "https://cdn.granola.ai/cdn.svg",
    "https://www.granola.ai/www.svg",
  ]);
  assert.deepEqual(iconLinksFromHtml(page, "https://granola.ai/"), [
    "https://granola.ai/apex.svg",
    "https://cdn.granola.ai/cdn.svg",
    "https://www.granola.ai/www.svg",
  ]);
});

test("hostile pages parse in linear time", () => {
  const size = 1024 * 1024;
  for (const page of [
    "<link ".repeat(size / 6),
    "<link ".repeat(size / 6) + ">",
    `<link ${"a".repeat(size)}>`,
    `<link ${"a".repeat(2000)}>`.repeat(size / 2007),
    `<link${" ".repeat(2000)}>`.repeat(size / 2006),
    `<link ${'a="'.repeat(660)}>`.repeat(size / 1987),
    `<link ${"a = ".repeat(500)}>`.repeat(size / 2007),
  ]) {
    const start = performance.now();
    assert.deepEqual(iconLinksFromHtml(page, "https://tools.example.com/"), []);
    assert.ok(performance.now() - start < 100, `${page.slice(0, 20)} took ${performance.now() - start}ms`);
  }
});

function siteNet(routes: Record<string, () => Response>, lookup = async () => ["34.1.2.3"]) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requested.push(String(input));
    assert.equal(init.redirect, "error");
    const route = routes[String(input)];
    return route ? route() : new Response("", { status: 404 });
  }) as typeof fetch;
  return { net: { fetchImpl, lookup }, requested };
}

test("the site icon comes from the homepage, trying www when the bare domain redirects", async () => {
  const { net, requested } = siteNet({
    "https://granola.ai/": () => new Response("", { status: 308, headers: { location: "https://www.granola.ai/" } }),
    "https://www.granola.ai/": () => new Response(GRANOLA_HOME, { headers: { "content-type": "text/html" } }),
  });
  assert.equal(
    await resolveMcpSiteIcon("https://mcp.granola.ai/mcp", net),
    "https://www.granola.ai/favicon/favicon.svg",
  );
  assert.deepEqual(requested, ["https://granola.ai/", "https://www.granola.ai/"]);
});

test("without icon links only a favicon.ico confirmed as an image is used, and www is skipped once the apex answers", async () => {
  const bare = () => new Response("<html><head></head></html>");
  const image = siteNet({
    "https://tools.example.com/": bare,
    "https://tools.example.com/favicon.ico": () => new Response("ico", { headers: { "content-type": "image/x-icon" } }),
  });
  assert.equal(
    await resolveMcpSiteIcon("https://mcp.tools.example.com/mcp", image.net),
    "https://tools.example.com/favicon.ico",
  );
  const html = siteNet({
    "https://tools.example.com/": bare,
    "https://tools.example.com/favicon.ico": () => new Response("<html>", { headers: { "content-type": "text/html" } }),
  });
  assert.equal(await resolveMcpSiteIcon("https://mcp.tools.example.com/mcp", html.net), undefined);
  assert.deepEqual(html.requested, ["https://tools.example.com/", "https://tools.example.com/favicon.ico"]);
});

test("site icon resolution never leaves https or the public network", async () => {
  const home = { "https://tools.example.com/": () => new Response(GRANOLA_HOME) };
  const privateNet = siteNet(home, async () => ["10.0.0.1"]);
  assert.equal(await resolveMcpSiteIcon("https://mcp.tools.example.com/mcp", privateNet.net), undefined);
  assert.deepEqual(privateNet.requested, []);
  const loopback = siteNet(home);
  assert.equal(
    await resolveMcpSiteIcon("https://127.0.0.1/mcp", {
      ...loopback.net,
      lookup: async () => ["127.0.0.1"],
      allowLoopbackHttp: true,
    }),
    undefined,
  );
  for (const url of ["http://tools.example.com/mcp", "https://localhost:8080/mcp", "not a url"]) {
    const plain = siteNet(home);
    assert.equal(await resolveMcpSiteIcon(url, plain.net), undefined, url);
    assert.deepEqual(plain.requested, [], url);
  }
});

test("the store serves every server name on one line, including names saved before the rule", async () => {
  assert.equal(singleLineName("  A\n\tB​ C\u0007 "), "A B C");
  assert.equal(singleLineName(`${"a".repeat(79)}😀tail`), `${"a".repeat(79)}😀`);
  const backing = createMemoryMap<McpServer>();
  const legacy: McpServer = {
    id: "crm",
    name: "CRM\n## Injected",
    url: "https://tools.example.com/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "admin",
  };
  await backing.put("crm", legacy);
  await backing.put("blank", { ...legacy, id: "blank", name: "\n\t" });
  const store = createMcpServerStore(backing);
  assert.equal((await store.get("crm"))?.name, "CRM ## Injected");
  assert.deepEqual(
    (await store.list()).map((s) => s.name),
    ["blank", "CRM ## Injected"],
  );
  await store.put({ ...legacy, name: "New\r\nName" });
  assert.equal((await backing.get("crm"))?.name, "New Name");
});

test("updateIf never resurrects a deleted server and skips a server changed since it was read", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const base: McpServer = {
    id: "crm",
    name: "CRM",
    url: "https://mcp.tools.example.com/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 1,
    updatedBy: "admin",
  };
  await store.put(base);
  await store.delete("crm");
  await store.updateIf("crm", (current) => ({ ...current, resolvedIconUrl: "https://tools.example.com/a.svg" }));
  assert.equal(await store.get("crm"), null);

  await store.put({ ...base, updatedAt: 2, name: "Newer" });
  await store.updateIf("crm", (current) =>
    current.updatedAt !== 1 ? null : { ...current, resolvedIconUrl: "https://tools.example.com/a.svg" },
  );
  const kept = await store.get("crm");
  assert.equal(kept?.name, "Newer");
  assert.equal(kept?.resolvedIconUrl, undefined);
});
