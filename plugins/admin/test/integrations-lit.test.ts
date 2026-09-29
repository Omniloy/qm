import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { configure, ConnectorsState, SlackSetting, SlackInstallationState } from "../ui/integrations-state.ts";
const bundle = buildSync({
  entryPoints: [new URL("../ui/integrations.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "integrationsUI",
}).outputFiles[0].text;
function setup() {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    runScripts: "outside-only",
    url: "http://localhost/admin/slack-settings",
  });
  dom.window.eval(
    bundle +
      ';window.ui=integrationsUI;ui.mountCards();ui.configure({api:async()=>({ok:true,data:{}}),orgScope:()=>"org:test",connectorName:id=>id,fmtTime:x=>x});',
  );
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}
test("Slack settings are state driven and preserve newer drafts when committing", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'ui.loadScope({externalSlackParticipants:false,internalMemberOverrides:[],channelHeaderPinDefault:false,ackEmoji:[]},"org:test")',
    );
    const doc = dom.window.document;
    const radio = doc.querySelector<HTMLInputElement>('[name="external-slack-choice"][value="on"]')!;
    radio.click();
    assert.equal(dom.window.eval('ui.collect("external-slack-participants").on'), true);
    assert.equal(doc.querySelector<HTMLButtonElement>('[data-save="external-slack-participants"]')!.disabled, false);
    dom.window.eval('ui.status("external-slack-participants","Saving","saving")');
    doc.querySelector<HTMLInputElement>('[name="external-slack-choice"][value="off"]')!.click();
    dom.window.eval('ui.commit("external-slack-participants",{on:true})');
    assert.equal(doc.getElementById("st-external-slack-participants")!.textContent, "Unsaved changes");
    assert.equal(doc.querySelector<HTMLInputElement>("#external-slack-participants")!.checked, false);
  } finally {
    dom.window.close();
  }
});
test("Slack member overrides normalize from the draft and update the count", () => {
  const s = new SlackSetting("internal-member-overrides");
  s.load([], "org:test", true);
  s.change({ text: " User@Example.com,USER@example.com\n U123 " });
  assert.deepEqual(s.collect(), { members: ["user@example.com", "u123"] });
  assert.equal(s.dirty, true);
});
test("Connector editor renders guides and keeps fields and focus stable while typing", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'ui.connectors.catalog=[{provider:"github",setupGuide:{url:"https://example.com",console:"GitHub",steps:["Create app"]},redirectPath:"github",scopes:["repo"]}];ui.connectors.render()',
    );
    const doc = dom.window.document;
    doc.getElementById("add-oauth-app")!.click();
    const input = doc.getElementById("conn-client-id") as HTMLInputElement;
    input.value = "my client";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(doc.activeElement, input);
    assert.equal(dom.window.eval("ui.connectors.draft.clientId"), "my client");
    assert.match(
      doc.getElementById("conn-guide")!.textContent!,
      /Callback URL: http:\/\/localhost\/v1\/connectors\/oauth\/github/,
    );
    assert.equal(doc.getElementById("conn-editor")!.classList.contains("hidden"), false);
    doc.getElementById("conn-reset")!.click();
    assert.equal(doc.getElementById("conn-editor")!.classList.contains("hidden"), true);
  } finally {
    dom.window.close();
  }
});
test("Connector saves use captured payloads and retain edits made during a request", async () => {
  let resolve!: (value: any) => void;
  const bodies: unknown[] = [];
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: async (method, _path, body) => {
      if (method === "PUT") {
        bodies.push(body);
        return new Promise((r) => (resolve = r));
      }
      return { ok: true, data: { catalog: [], connectors: [] } };
    },
  });
  const s = new ConnectorsState();
  s.edit({ provider: "github" });
  s.change("clientId", "first");
  s.change("clientSecret", "secret");
  const saving = s.save();
  s.change("clientId", "newer");
  resolve({ ok: true, data: {} });
  await saving;
  assert.deepEqual(bodies, [{ provider: "github", clientId: "first", clientSecret: "secret", enabled: true }]);
  assert.equal(s.draft.clientId, "newer");
  assert.equal(s.editor, true);
  assert.equal(s.saving, false);
});
test("Connector load ignores out of order responses and preserves the open editor", async () => {
  const pending: Array<(value: any) => void> = [];
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: () => new Promise((r) => pending.push(r)),
  });
  const s = new ConnectorsState();
  const old = s.load();
  const latest = s.load();
  pending[2]({ ok: true, data: { catalog: [{ provider: "new" }] } });
  pending[3]({ ok: true, data: { connectors: [] } });
  await latest;
  s.edit({ provider: "new" });
  s.change("clientId", "draft");
  pending[0]({ ok: true, data: { catalog: [{ provider: "stale" }] } });
  pending[1]({ ok: true, data: { connectors: [] } });
  await old;
  assert.equal(s.catalog[0].provider, "new");
  assert.equal(s.draft.clientId, "draft");
});
test("Slack connection validates token drafts before submitting", async () => {
  let called = false;
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: async () => {
      called = true;
      return { ok: true, data: {} };
    },
  });
  const s = new SlackInstallationState();
  s.botToken = "xoxb-example";
  await s.save();
  assert.equal(called, false);
  assert.equal(s.message, "Both Slack tokens are required.");
});
test("MCP servers and Composio are managed from the Connectors view", async () => {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const dom = setup();
  try {
    dom.window.eval(
      `ui.configure({orgScope:()=>"org:test",connectorName:x=>x,fmtTime:x=>x,api:async(method,path,body)=>{window.calls.push({method,path,body});
        if(path==="/api/mcp-servers")return{ok:true,data:{servers:[{id:"linear",name:"Linear",url:"https://mcp.linear.app/mcp",icon:"https://linear.app/favicon.ico",auth:"bearer",hasBearerToken:true,credentialScope:"shared",readOnly:false,enabled:true}],tools:[{name:"linear_list",serverId:"linear"}]}};
        if(path==="/api/connector-catalog")return{ok:true,data:{catalog:[]}};
        if(path.includes("?view=connectors"))return{ok:true,data:{connectors:[],serviceCredentials:[]}};
        return{ok:true,data:{tools:["a","b"]}};}})`,
    );
    (dom.window as any).calls = { push: (call: any) => calls.push(JSON.parse(JSON.stringify(call))) };
    await dom.window.eval("ui.loadConnectors()");
    const doc = dom.window.document;
    const view = doc.getElementById("view-connectors")!;
    assert.ok(view.querySelector("#card-mcp-servers"));
    assert.ok(view.querySelector("#card-composio"));
    assert.match(doc.getElementById("mcp-list")!.textContent!, /Linear[\s\S]*1 tool/);
    const icon = doc.querySelector<HTMLImageElement>("#mcp-list .mcp-icon img")!;
    assert.equal(icon.getAttribute("src"), "https://linear.app/favicon.ico");
    assert.equal(icon.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(icon.getAttribute("loading"), "lazy");
    assert.ok(doc.querySelector("#mcp-list .mcp-icon svg"));
    assert.equal(icon.style.background, "");
    Object.defineProperty(icon, "naturalWidth", { configurable: true, value: 32 });
    icon.dispatchEvent(new dom.window.Event("load"));
    assert.equal(icon.hidden, false);
    assert.notEqual(icon.style.background, "");
    Object.defineProperty(icon, "naturalWidth", { configurable: true, value: 0 });
    icon.dispatchEvent(new dom.window.Event("load"));
    assert.equal(icon.hidden, true);
    icon.hidden = false;
    icon.dispatchEvent(new dom.window.Event("error"));
    assert.equal(icon.hidden, true);
    assert.match(doc.getElementById("composio-state")!.textContent!, /Not configured/);

    doc.getElementById("mcp-add")!.click();
    const type = (id: string, value: string) => {
      const input = doc.getElementById(id) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    type("mcp-id", "notion");
    type("mcp-url", "https://mcp.notion.com/mcp");
    const auth = doc.getElementById("mcp-auth") as HTMLSelectElement;
    auth.value = "bearer";
    auth.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    type("mcp-bearerToken", "tok");
    assert.equal((doc.getElementById("mcp-readOnly") as HTMLInputElement).checked, true);
    type("mcp-iconUrl", 'https://cdn.example.com/"x".png');
    doc.getElementById("mcp-save")!.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
    assert.match(doc.getElementById("st-mcp-servers")!.textContent!, /Icon: an https image URL/);
    type("mcp-iconUrl", " https://cdn.example.com/notion.png ");
    doc.getElementById("mcp-save")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal(put.path, "/api/mcp-servers/notion");
    assert.deepEqual(put.body, {
      name: "notion",
      url: "https://mcp.notion.com/mcp",
      iconUrl: "https://cdn.example.com/notion.png",
      auth: "bearer",
      credentialScope: "shared",
      bearerToken: "tok",
      readOnly: true,
      enabled: true,
    });
    assert.match(doc.getElementById("st-mcp-servers")!.textContent!, /2 tools found/);

    type("composio-key", "ak_test");
    doc.getElementById("composio-save")!.click();
    await new Promise((r) => setTimeout(r, 0));
    const saved = calls.find((c) => c.path.endsWith("/service-credentials"))!;
    assert.equal(saved.path, "/api/scopes/org%3Atest/service-credentials");
    assert.deepEqual(saved.body, {
      slug: "composio",
      name: "Composio",
      delivery: "env",
      envKey: "COMPOSIO_API_KEY",
      secret: "ak_test",
      enabled: true,
      grantees: ["org:test"],
    });
  } finally {
    dom.window.close();
  }
});
test("editing an MCP server keeps its stored secret unless a new one is typed", async () => {
  const bodies: any[] = [];
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: async (method, _path, body) => {
      if (method === "PUT") bodies.push(body);
      return { ok: true, data: { servers: [] } };
    },
  });
  const { McpServersState } = await import("../ui/mcp-servers.ts");
  const s = new McpServersState();
  s.open({
    id: "tools",
    name: "Tools",
    url: "https://tools.example.com/mcp",
    iconUrl: "https://cdn.example.com/tools.png",
    auth: "client-credentials",
    clientId: "cid",
    hasClientSecret: true,
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    credentialAccountType: "company",
    readOnly: true,
    enabled: true,
  });
  await s.save();
  assert.deepEqual(bodies, [
    {
      name: "Tools",
      url: "https://tools.example.com/mcp",
      iconUrl: "https://cdn.example.com/tools.png",
      auth: "client-credentials",
      credentialScope: "per-user",
      credentialHost: "accounts.example.com",
      credentialAccountType: "company",
      clientId: "cid",
      readOnly: true,
      enabled: true,
    },
  ]);
});
test("replacing the Composio key updates the existing credential at its loaded version", async () => {
  const bodies: any[] = [];
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: async (method, _path, body) => {
      if (method === "PUT") bodies.push(body);
      return { ok: true, data: {} };
    },
  });
  const { composio } = await import("../ui/composio.ts");
  const { connectors } = await import("../ui/integrations-state.ts");
  connectors.serviceCredentials = [
    {
      slug: "composio-prod",
      delivery: "env",
      envKey: "COMPOSIO_API_KEY",
      enabled: true,
      hasSecret: true,
      updatedAt: 42,
      grantees: ["channel:C1"],
    },
  ];
  composio.key = " ak_new ";
  await composio.save();
  assert.equal(bodies[0].slug, "composio-prod");
  assert.equal(bodies[0].secret, "ak_new");
  assert.equal(bodies[0].expectedUpdatedAt, 42);
  assert.deepEqual(bodies[0].grantees, ["channel:C1", "org:test"]);
});
test("the Composio card reads Configured only when the key is granted to the whole organization", async () => {
  const dom = setup();
  try {
    const state = async (grantees: string[]) => {
      const credential = {
        slug: "composio",
        delivery: "env",
        envKey: "COMPOSIO_API_KEY",
        enabled: true,
        hasSecret: true,
        updatedAt: 1,
        grantees,
      };
      dom.window.eval(
        `ui.configure({orgScope:()=>"org:test",connectorName:x=>x,fmtTime:x=>x,api:async(method,path)=>{
          if(path==="/api/connector-catalog")return{ok:true,data:{catalog:[]}};
          if(path.includes("?view=connectors"))return{ok:true,data:{connectors:[],serviceCredentials:[${JSON.stringify(credential)}]}};
          return{ok:true,data:{}};}})`,
      );
      await dom.window.eval("ui.loadConnectors()");
      return dom.window.document.getElementById("composio-state")!.textContent!;
    };
    assert.match(await state([]), /Not shared org-wide/);
    assert.match(await state(["personal:U1"]), /Not shared org-wide/);
    assert.match(await state(["org:test"]), /Configured/);
  } finally {
    dom.window.close();
  }
});
