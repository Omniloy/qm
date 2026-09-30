import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DuplicateReport } from "../src/skills/skill-namespace.ts";

const SCRIPT = new URL("../scripts/skills-dedupe.ts", import.meta.url).pathname;

const cleanReport = (): DuplicateReport => ({
  clusters: [
    {
      name: "jira",
      status: "auto",
      canonical: null,
      retire: [],
      purge: [],
      evidence: [],
      diff: null,
      actions: [{ method: "POST", path: "/v1/admin/skills/s1/merge", body: { into: "s2" } }],
    },
  ],
  nameClashes: [],
  archivedLeftovers: [],
  writeGrants: [],
  ownerBackfill: { pending: 0, personalHomeMismatch: [] },
});

async function runScript(args: string[], report: DuplicateReport) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      calls.push({ method: req.method ?? "", path, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader("content-type", "application/json");
      if (path === "/api/whoami") return res.end(JSON.stringify({ org: "o", isAdmin: true }));
      if (path === "/api/skills/duplicates") return res.end(JSON.stringify(report));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const child = spawn(process.execPath, [SCRIPT, "--base", base, ...args], {
      env: { ...process.env, QM_ADMIN_COOKIE: "admin=x" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, out, posts: calls.filter((c) => c.method === "POST") };
  } finally {
    server.close();
  }
}

for (const [command, path] of [
  ["backfill", "/api/skills/backfill-owners"],
  ["downgrade-write-grants", "/api/skills/downgrade-write-grants"],
] as const) {
  test(`${command} only shows the dry run unless it is confirmed`, async () => {
    const dry = await runScript([command], cleanReport());
    assert.equal(dry.code, 0, dry.out);
    assert.deepEqual(dry.posts, [{ method: "POST", path, body: { dryRun: true } }]);
    const applied = await runScript([command, "--yes"], cleanReport());
    assert.deepEqual(
      applied.posts.map((p) => p.body),
      [{ dryRun: true }, { dryRun: false }],
    );
  });
}

test("apply refuses to merge while skill write grants remain and names the rollout order", async () => {
  const report = cleanReport();
  report.writeGrants = [{ skillId: "s1", ownerScopeId: "personal:U1", granteeScopeId: "channel:C1" }];
  for (const args of [
    ["apply", "--auto", "--yes"],
    ["apply", "--cluster", "jira"],
  ]) {
    const run = await runScript(args, report);
    assert.notEqual(run.code, 0);
    assert.deepEqual(run.posts, []);
    assert.match(run.out, /backfill -> downgrade-write-grants -> report -> apply/);
  }
  const clean = await runScript(["apply", "--auto", "--yes"], cleanReport());
  assert.equal(clean.code, 0, clean.out);
  assert.deepEqual(
    clean.posts.map((p) => p.path),
    ["/api/skills/s1/merge"],
  );
});
