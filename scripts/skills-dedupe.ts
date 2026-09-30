import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type {
  DuplicateAction,
  DuplicateCluster,
  DuplicateReport,
  DuplicateRow,
} from "../src/skills/skill-namespace.ts";

const USAGE = `usage: node scripts/skills-dedupe.ts --base <admin origin> --cookie <admin session cookie> <command>
  backfill [--dry-run]              record an owner on every skill that lacks one
  report                            print the duplicate report
  apply --auto [--yes]              merge every "auto" cluster, then purge archived leftovers (asks first)
  apply --cluster <name> [--force]  merge one cluster; --force is the owner's approval for a diverged one`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    cookie: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    auto: { type: "boolean", default: false },
    cluster: { type: "string" },
    force: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const command = positionals[0];
if (!values.base || !values.cookie || !command) {
  console.error(USAGE);
  process.exit(2);
}
const base = values.base.replace(/\/+$/, "");
const cookie = values.cookie.includes("=") ? values.cookie : `admin=${values.cookie}`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error ?? ""} ${data?.message ?? text}`);
  return { status: res.status, data };
}

const who = (await call("GET", "/api/whoami")).data as { org?: string; isAdmin?: boolean };
if (!who.isAdmin || !who.org) throw new Error("this cookie does not belong to an org admin");
const scope = `?scope=${encodeURIComponent(`org:${who.org}`)}`;
const adminPath = (corePath: string) => corePath.replace(/^\/v1\/admin\//, "/api/") + scope;

const row = (r: DuplicateRow) => `${r.id} ${r.scopeId} ${r.status} v${r.version} grants=${r.grants}`;

function printCluster(c: DuplicateCluster): void {
  console.log(`\n/${c.name}  [${c.status}]`);
  if (c.canonical) console.log(`  keep    ${row(c.canonical)}`);
  for (const r of c.retire) console.log(`  retire  ${row(r)}`);
  for (const r of c.purge) console.log(`  purge   ${row(r)}`);
  for (const e of c.evidence) console.log(`  why     ${e}`);
  if (c.diff) {
    console.log(
      `  diff    description ${c.diff.description ? "changed" : "same"}, body ${c.diff.bodyDeltaChars} chars, files [${c.diff.files.join(", ")}]`,
    );
  }
}

async function runActions(actions: readonly DuplicateAction[]): Promise<void> {
  for (const a of actions) {
    const { data } = await call(a.method, adminPath(a.path), a.body ?? {});
    console.log(`  ${a.path} → ${JSON.stringify(data)}`);
  }
}

async function confirm(question: string): Promise<boolean> {
  if (values.yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

const report = async () => (await call("GET", adminPath("/v1/admin/skills/duplicates"))).data as DuplicateReport;

if (command === "backfill") {
  const { data } = await call("POST", adminPath("/v1/admin/skills/backfill-owners"), { dryRun: values["dry-run"] });
  console.log(JSON.stringify(data, null, 2));
} else if (command === "report") {
  const r = await report();
  r.clusters.forEach(printCluster);
  console.log("\nname clashes (report only):");
  for (const n of r.nameClashes)
    console.log(`  /${n.name}${n.note ? ` (${n.note})` : ""}: ${n.rows.map(row).join(" | ")}`);
  console.log("\narchived leftovers:");
  for (const l of r.archivedLeftovers) console.log(`  ${row(l)}`);
  console.log(
    `\nowners: ${r.ownerBackfill.pending} pending, ${r.ownerBackfill.personalHomeMismatch.length} personal-home mismatches`,
  );
} else if (command === "apply" && values.auto) {
  const r = await report();
  for (const c of r.clusters.filter((x) => x.status === "auto")) {
    printCluster(c);
    await runActions(c.actions);
  }
  if (r.archivedLeftovers.length) {
    for (const l of r.archivedLeftovers) console.log(`  leftover ${row(l)}`);
    if (await confirm(`purge ${r.archivedLeftovers.length} archived leftover skill(s)?`)) {
      await runActions(
        r.archivedLeftovers.map((l) => ({ method: "POST" as const, path: `/v1/admin/skills/${l.id}/purge` })),
      );
    }
  }
} else if (command === "apply" && values.cluster) {
  const c = (await report()).clusters.find((x) => x.name === values.cluster);
  if (!c) throw new Error(`no duplicate cluster named ${values.cluster}`);
  printCluster(c);
  if (c.status === "ambiguous") throw new Error("this cluster has no single source; merge it from the admin UI");
  if (c.status === "needs_approval" && !values.force) {
    throw new Error("the copies differ; rerun with --force once the owner approves");
  }
  await runActions(c.actions);
} else {
  console.error(USAGE);
  process.exit(2);
}
