import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type {
  DuplicateAction,
  DuplicateCluster,
  DuplicateReport,
  DuplicateRow,
} from "../src/skills/skill-namespace.ts";

const USAGE = `usage: QM_ADMIN_COOKIE=<admin session cookie> node scripts/skills-dedupe.ts --base <admin origin> <command>
  (without QM_ADMIN_COOKIE the cookie is read from the first line of stdin)
  backfill [--dry-run]                record an owner on every skill that lacks one
  report                              print the duplicate report
  apply --auto [--yes]                merge every "auto" cluster; asks before purging anything
  apply --cluster <name> [--force]    merge one cluster; --force is the owner's approval for a diverged one
  downgrade-write-grants [--dry-run]  turn every skill write grant into a read grant
  unmerge <retired skill id>          undo a merge: bring the retired copy back and take back what the merge added`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    auto: { type: "boolean", default: false },
    cluster: { type: "string" },
    force: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const command = positionals[0];
if (!values.base || !command) {
  console.error(USAGE);
  process.exit(2);
}
const base = values.base.replace(/\/+$/, "");
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = rl[Symbol.asyncIterator]();
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const next = await lines.next();
  return next.done ? "" : String(next.value);
}
const rawCookie = (process.env.QM_ADMIN_COOKIE ?? (await ask("admin session cookie: "))).trim();
if (!rawCookie) {
  console.error(USAGE);
  process.exit(2);
}
const cookie = rawCookie.includes("=") ? rawCookie : `admin=${rawCookie}`;

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
  return (await ask(`${question} [y/N] `)).trim().toLowerCase() === "y";
}

const isPurge = (a: DuplicateAction) => a.path.endsWith("/purge");

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
  console.log("\nskill write grants (downgrade-write-grants turns them into read grants):");
  for (const w of r.writeGrants) {
    console.log(`  ${w.skillId} /${w.name ?? "?"} ${w.ownerScopeId} -> ${w.granteeScopeId}`);
  }
  console.log(
    `\nowners: ${r.ownerBackfill.pending} pending, ${r.ownerBackfill.personalHomeMismatch.length} personal-home mismatches`,
  );
} else if (command === "apply" && values.auto) {
  const r = await report();
  const purges: DuplicateAction[] = [];
  for (const c of r.clusters.filter((x) => x.status === "auto")) {
    printCluster(c);
    await runActions(c.actions.filter((a) => !isPurge(a)));
    purges.push(...c.actions.filter(isPurge));
  }
  for (const l of r.archivedLeftovers) {
    console.log(`  leftover ${row(l)}`);
    purges.push({ method: "POST", path: `/v1/admin/skills/${l.id}/purge` });
  }
  if (purges.length && (await confirm(`purge ${purges.length} archived skill(s)? this deletes them for good`))) {
    await runActions(purges);
  }
} else if (command === "downgrade-write-grants") {
  const { data } = await call("POST", adminPath("/v1/admin/skills/downgrade-write-grants"), {
    dryRun: values["dry-run"],
  });
  console.log(JSON.stringify(data, null, 2));
} else if (command === "unmerge" && positionals[1]) {
  const { data } = await call("POST", adminPath(`/v1/admin/skills/${encodeURIComponent(positionals[1])}/unmerge`), {});
  console.log(JSON.stringify(data, null, 2));
} else if (command === "apply" && values.cluster) {
  const c = (await report()).clusters.find((x) => x.name === values.cluster);
  if (!c) throw new Error(`no duplicate cluster named ${values.cluster}`);
  printCluster(c);
  if (c.status === "ambiguous") throw new Error("this cluster has no single source; merge it from the admin UI");
  if (c.status === "needs_approval" && !values.force) {
    throw new Error("the copies differ; rerun with --force once the owner approves");
  }
  const purges = c.actions.filter(isPurge);
  await runActions(c.actions.filter((a) => !isPurge(a)));
  if (purges.length && (await confirm(`purge ${purges.length} archived skill(s)? this deletes them for good`))) {
    await runActions(purges);
  }
} else {
  console.error(USAGE);
  process.exit(2);
}
rl.close();
