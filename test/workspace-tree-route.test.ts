import "./support/auto-fake-sprites.ts";

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "workspace-tree-secret".repeat(3);

describe("workspace tree route", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = (actorId: string) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("personal", actorId),
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  const get = async (path: string, token: string) =>
    fetch(`${base}${path}`, { headers: { "x-agent-capability": token } });

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    const handle = await built.sandbox.provision([
      { scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" },
    ]);
    await built.sandbox.writeFile(handle, "licit/ted.py", "print(1)");
    await built.sandbox.writeFile(handle, "licit/hits/candidates.json", "[]");
    await built.sandbox.writeFile(handle, "notes.md", "hello");
    await built.sandbox.writeFile(handle, "global/org-policy.md", "org only");
    await built.sandbox.writeFile(handle, "team-T9/roadmap.md", "team only");
    await built.sandbox.writeFile(handle, "skills/browse/SKILL.md", "a skill");
    await built.sandbox.writeFile(handle, ".ro-layers.manifest", "deadbeef");
    await built.sandbox.writeFile(handle, "repo/.git/config", "[core]");
    await built.sandbox.writeFile(handle, "app/node_modules/left-pad/index.js", "x");
    await built.sandbox.teardown(handle, { keepWarm: true });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("lists nothing and provisions nothing until asked to wake", async () => {
    const r = await get(`/v1/workspace/tree?scope=personal:U1`, await capFor("U1"));
    assert.equal(r.status, 200);
    const body = (await r.json()) as { loaded: boolean; paths: string[] };
    assert.equal(body.loaded, false);
    assert.deepEqual(body.paths, []);
  });

  it("returns the scope's own files once woken", async () => {
    const r = await get(`/v1/workspace/tree?scope=personal:U1&wake=true`, await capFor("U1"));
    assert.equal(r.status, 200);
    const body = (await r.json()) as { loaded: boolean; paths: string[]; truncated: boolean };
    assert.equal(body.loaded, true);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.paths, ["licit/hits/candidates.json", "licit/ted.py", "notes.md"]);
  });

  it("hides machine directories that would otherwise crowd out real work", async () => {
    const r = await get(`/v1/workspace/tree?scope=personal:U1&wake=true`, await capFor("U1"));
    const { paths } = (await r.json()) as { paths: string[] };
    assert.ok(!paths.includes(".ro-layers.manifest"), "ro-layers manifest leaked into the tree");
    assert.ok(!paths.some((p) => p.includes("/.git/")), ".git leaked into the tree");
    assert.ok(!paths.some((p) => p.includes("node_modules")), "node_modules leaked into the tree");
  });

  it("names the mounted directories it hid rather than dropping them silently", async () => {
    const r = await get(`/v1/workspace/tree?scope=personal:U1&wake=true`, await capFor("U1"));
    const { hiddenDirs } = (await r.json()) as { hiddenDirs: string[] };
    assert.deepEqual(hiddenDirs, ["global", "team-T9"]);
  });

  it("hides mounted org and team layers, and skills, from the listing", async () => {
    const r = await get(`/v1/workspace/tree?scope=personal:U1&wake=true`, await capFor("U1"));
    const { paths } = (await r.json()) as { paths: string[] };
    assert.ok(!paths.some((p) => p.startsWith("global/")), "org mount leaked into the tree");
    assert.ok(!paths.some((p) => p.startsWith("team-")), "team mount leaked into the tree");
    assert.ok(!paths.some((p) => p.startsWith("skills/")), "skills leaked into the tree");
  });

  it("refuses a scope the viewer cannot act in", async () => {
    const r = await get(`/v1/workspace/tree?scope=personal:U2&wake=true`, await capFor("U1"));
    assert.equal(r.status, 403);
  });

  it("rejects a scope that is not a scope id", async () => {
    const r = await get(`/v1/workspace/tree?scope=not-a-scope&wake=true`, await capFor("U1"));
    assert.equal(r.status, 400);
  });

  it("serves a file from the workspace", async () => {
    const r = await get(`/v1/workspace/file?scope=personal:U1&path=licit/ted.py`, await capFor("U1"));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "print(1)");
  });

  it("refuses to walk out of the workspace", async () => {
    const r = await get(`/v1/workspace/file?scope=personal:U1&path=../../etc/passwd`, await capFor("U1"));
    assert.equal(r.status, 404);
  });

  it("refuses to serve a file out of a mounted layer", async () => {
    const r = await get(`/v1/workspace/file?scope=personal:U1&path=global/org-policy.md`, await capFor("U1"));
    assert.equal(r.status, 404);
  });

  it("refuses a mounted layer reached through redundant dot segments", async () => {
    for (const probe of ["././global/org-policy.md", "./team-T9/../team-T9/roadmap.md", ".//global/org-policy.md"]) {
      const r = await get(
        `/v1/workspace/file?scope=personal:U1&path=${encodeURIComponent(probe)}`,
        await capFor("U1"),
      );
      assert.equal(r.status, 404, `${probe} was served`);
    }
  });

  it("serves a file named with a redundant dot segment that is not hidden", async () => {
    const r = await get(`/v1/workspace/file?scope=personal:U1&path=${encodeURIComponent("./licit/ted.py")}`, await capFor("U1"));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "print(1)");
  });

  it("refuses a file in a scope the viewer cannot act in", async () => {
    const r = await get(`/v1/workspace/file?scope=personal:U2&path=notes.md`, await capFor("U1"));
    assert.equal(r.status, 403);
  });
});
