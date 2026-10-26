import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describePublishSource,
  gitSourceCommand,
  parseGitSource,
  readPublishSource,
  repoLabel,
} from "../src/deploy/publish-source.ts";

test("repo labels strip credentials and render GitHub as owner/repo", () => {
  assert.equal(repoLabel("https://x-access-token:abc@github.com/o/r.git"), "o/r");
  assert.equal(repoLabel("git@github.com:o/r.git"), "o/r");
  assert.equal(repoLabel("https://github.com/o/r"), "o/r");
  assert.equal(
    repoLabel("https://oauth2:glpat-xyz@gitlab.example.com/group/sub/r.git?token=t#frag"),
    "gitlab.example.com/group/sub/r",
  );
  assert.equal(repoLabel("ssh://git@git.example.com:2222/team/r.git"), "git.example.com/team/r");
});

test("repo labels refuse anything that could carry a secret or is not a network remote", () => {
  for (const remote of [
    "github.com:ghp_TOKEN@github.com/o/r",
    "git@github.com:ghp_TOKEN@o/r.git",
    "https://github.com/o/ghp%40TOKEN/r",
    "https://github.com/o/r :token",
    "ext::ssh -i key example.com %S 'repo'",
    "fd::7,8",
    "C:\\work\\repo",
    "C:/work/repo",
    "/srv/git/r.git",
    "file:///srv/git/r.git",
    "",
  ]) {
    assert.equal(repoLabel(remote), undefined, remote);
  }
});

test("git probe output parses into the version's source fields", () => {
  assert.deepEqual(parseGitSource("remote=git@github.com:Omniloy/maria-demo.git\nbranch=main\ncommit=1a2b3c4\n"), {
    repo: "Omniloy/maria-demo",
    branch: "main",
    commit: "1a2b3c4",
  });
  assert.deepEqual(parseGitSource("remote=\nbranch=HEAD\ncommit=abcdef1\n"), { commit: "abcdef1" });
  assert.equal(parseGitSource("remote=\nbranch=HEAD\ncommit=\n"), undefined, "a repo with no commit");
  assert.equal(parseGitSource(""), undefined);
});

test("the probe runs in the published directory, quoted, and never asks git for the working-tree status", () => {
  const command = gitSourceCommand("it's");
  assert.match(command, /^cd -- 'it'\\''s' && /);
  assert.doesNotMatch(command, /\bstatus\b|\bdiff\b/);
});

function sh(cwd: string, command: string): string {
  return execFileSync("sh", ["-c", command], { cwd, encoding: "utf8", env: { ...process.env, HOME: cwd } });
}

test("a checkout's own config cannot make the probe run programs", () => {
  const root = mkdtempSync(join(tmpdir(), "publish-source-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "app"), { recursive: true });
  const marker = join(root, "PWNED");
  const git = (args: string) => sh(repo, `git -c user.email=t@example.com -c user.name=t ${args}`);
  git("init -q -b main");
  writeFileSync(join(repo, "app", "server.js"), "listen");
  writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
  git("add -A");
  git("commit -q -m init");
  git("remote add origin https://x-access-token:abc@github.com/o/r.git");
  const payload = `echo PWNED >> '${marker}'; false #`;
  for (const [key, value] of [
    ["core.fsmonitor", payload],
    ["filter.evil.clean", payload],
    ["filter.evil.smudge", payload],
    ["filter.evil.process", payload],
    ["core.pager", payload],
    ["core.sshCommand", payload],
    ["diff.external", payload],
  ]) {
    git(`config ${key} "${value}"`);
  }
  writeFileSync(join(repo, "app", "server.js"), "listen again");
  sh(repo, "git status --porcelain >/dev/null 2>&1 || true");
  assert.ok(existsSync(marker), "the hostile config is live: a plain git status runs it");
  execFileSync("rm", [marker]);

  const out = sh(repo, gitSourceCommand("app"));
  assert.equal(existsSync(marker), false, "the probe ran none of the repository's configured programs");
  const parsed = parseGitSource(out);
  assert.equal(parsed?.repo, "o/r");
  assert.equal(parsed?.branch, "main");
  assert.match(parsed?.commit ?? "", /^[0-9a-f]{7,}$/);
});

test("a failed or non-git probe leaves only the directory", async () => {
  const nonGit = async () => ({ stdout: "", stderr: "fatal", code: 128, timedOut: false });
  assert.deepEqual(await readPublishSource(nonGit, "./app/"), { dir: "app" });
  const broken = async (): Promise<never> => {
    throw new Error("sandbox gone");
  };
  assert.deepEqual(await readPublishSource(broken, undefined), { dir: "." });
});

test("the publish message names the directory, repository revision and entrypoint", () => {
  assert.equal(
    describePublishSource(
      { dir: "app", repo: "Omniloy/maria-demo", branch: "main", commit: "1a2b3c4" },
      "node server/index.js",
    ),
    "Source: app/ · repo Omniloy/maria-demo @ main 1a2b3c4 · entrypoint: node server/index.js",
  );
  assert.equal(
    describePublishSource({ dir: ".", commit: "abcdef1" }, "node s.js"),
    "Source: whole workspace · git abcdef1 · entrypoint: node s.js",
  );
  assert.equal(describePublishSource(undefined, undefined), "");
});
