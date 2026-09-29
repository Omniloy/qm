import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMcpServerStore,
  mcpServerIcon,
  parseMcpIconUrl,
  singleLineName,
  type McpServer,
} from "../src/mcp/mcp-server-store.ts";
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

test("without an icon the site favicon is used, and only for public https servers", () => {
  assert.equal(mcpServerIcon({ url: "https://mcp.linear.app/mcp" }), "https://linear.app/favicon.ico");
  assert.equal(mcpServerIcon({ url: "https://tools.example.com/mcp" }), "https://tools.example.com/favicon.ico");
  assert.equal(mcpServerIcon({ url: "https://mcp.io/mcp" }), "https://mcp.io/favicon.ico");
  assert.equal(mcpServerIcon({ url: "http://tools.example.com/mcp" }), undefined);
  assert.equal(mcpServerIcon({ url: "https://localhost:8080/mcp" }), undefined);
  assert.equal(mcpServerIcon({ url: "not a url" }), undefined);
  assert.equal(
    mcpServerIcon({ url: "https://mcp.linear.app/mcp", iconUrl: "https://cdn.example.com/l.png" }),
    "https://cdn.example.com/l.png",
  );
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
