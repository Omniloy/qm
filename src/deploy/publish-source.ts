import type { Sandbox, SandboxHandle } from "../sandbox/sandbox.ts";
import { swallow } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import type { DeploymentSource } from "./deploy-store.ts";

const GIT_SOURCE_TIMEOUT_MS = 10_000;

export function publishSourceDir(dir: string | undefined): string {
  return (dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "") || ".";
}

export function gitSourceCommand(dir: string): string {
  return [
    `cd -- ${shq(dir)}`,
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1",
    `printf 'remote=%s\\nbranch=%s\\ncommit=%s\\nchanges=%s\\n' "$(git remote get-url origin 2>/dev/null)" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git rev-parse --short HEAD 2>/dev/null)" "$(git status --porcelain -- . 2>/dev/null | wc -l)"`,
  ].join(" && ");
}

export function repoLabel(remote: string): string | undefined {
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return undefined;
    }
    if (url.protocol === "file:") return undefined;
    host = url.hostname;
    path = url.pathname;
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
    if (!scp) return undefined;
    host = scp[1]!;
    path = scp[2]!;
  }
  const repo = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !repo) return undefined;
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
    dirty: Number(fields.get("changes")) > 0,
  };
}

export async function readPublishSource(
  sandbox: Pick<Sandbox, "run">,
  handle: SandboxHandle,
  dir: string | undefined,
  signal?: AbortSignal,
): Promise<DeploymentSource> {
  const source: DeploymentSource = { dir: publishSourceDir(dir) };
  try {
    const r = await sandbox.run(handle, gitSourceCommand(source.dir), {
      timeoutMs: GIT_SOURCE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
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
    const changes = source.dirty ? " (uncommitted changes)" : "";
    if (source.repo) parts.push(`repo ${source.repo}${revision ? ` @ ${revision}` : ""}${changes}`);
    else if (revision) parts.push(`git ${revision}${changes}`);
  }
  if (entrypoint) parts.push(`entrypoint: ${entrypoint}`);
  return parts.length ? `Source: ${parts.join(" · ")}` : "";
}
