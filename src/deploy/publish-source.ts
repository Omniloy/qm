import type { ExecOptions, ExecResult } from "../sandbox/sandbox.ts";
import { swallow } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { trimRelDir } from "./deploy-fs.ts";
import type { DeploymentSource } from "./deploy-store.ts";

const GIT_SOURCE_TIMEOUT_MS = 10_000;
const GIT = "git --no-pager -c safe.directory='*' -c core.fsmonitor=false";

export function gitSourceCommand(dir: string): string {
  return [
    `cd -- ${shq(dir)}`,
    "export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat",
    `${GIT} rev-parse --is-inside-work-tree >/dev/null 2>&1`,
    `printf 'remote=%s\\nbranch=%s\\ncommit=%s\\n' "$(${GIT} config --get remote.origin.url 2>/dev/null)" "$(${GIT} rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(${GIT} rev-parse --short HEAD 2>/dev/null)"`,
  ].join(" && ");
}

export function repoLabel(remote: string): string | undefined {
  if (/^[a-z0-9+.-]+::/i.test(remote)) return undefined;
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const url = new URL(remote);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
      host = url.hostname;
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
    if (!scp) return undefined;
    host = scp[1]!;
    path = scp[2]!;
  }
  const repo = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (host.length < 2 || !repo || /[@:\s\\]/.test(host) || /[@:\s\\]/.test(repo)) return undefined;
  return host.toLowerCase() === "github.com" ? repo : `${host.toLowerCase()}/${repo}`;
}

export function parseGitSource(stdout: string): Omit<DeploymentSource, "dir"> | undefined {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const commit = fields.get("commit");
  if (!commit || !/^[0-9a-f]{4,40}$/i.test(commit)) return undefined;
  const repo = repoLabel(fields.get("remote") ?? "");
  const branch = fields.get("branch");
  return {
    ...(repo ? { repo } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    commit,
  };
}

export async function readPublishSource(
  run: (command: string, opts: ExecOptions) => Promise<ExecResult>,
  dir: string | undefined,
): Promise<DeploymentSource> {
  const source: DeploymentSource = { dir: trimRelDir(dir) || "." };
  try {
    const r = await run(gitSourceCommand(source.dir), { timeoutMs: GIT_SOURCE_TIMEOUT_MS });
    const git = r.code === 0 ? parseGitSource(r.stdout) : undefined;
    return git ? { ...source, ...git } : source;
  } catch (e) {
    swallow("publish: read git source", e);
    return source;
  }
}

export function describePublishSource(source: DeploymentSource | undefined, entrypoint: string | undefined): string {
  const parts: string[] = [];
  if (source) {
    parts.push(source.dir === "." ? "whole workspace" : `${source.dir}/`);
    const revision = [source.branch, source.commit].filter(Boolean).join(" ");
    if (source.repo) parts.push(`repo ${source.repo}${revision ? ` @ ${revision}` : ""}`);
    else if (revision) parts.push(`git ${revision}`);
  }
  if (entrypoint) parts.push(`entrypoint: ${entrypoint}`);
  return parts.length ? `Source: ${parts.join(" · ")}` : "";
}
