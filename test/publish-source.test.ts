import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describePublishSource,
  gitSourceCommand,
  parseGitSource,
  publishSourceDir,
  readPublishSource,
  repoLabel,
} from "../src/deploy/publish-source.ts";
import type { SandboxHandle } from "../src/sandbox/sandbox.ts";

test("repo labels strip credentials and render GitHub as owner/repo", () => {
  assert.equal(repoLabel("https://x-access-token:abc@github.com/o/r.git"), "o/r");
  assert.equal(repoLabel("git@github.com:o/r.git"), "o/r");
  assert.equal(repoLabel("https://github.com/o/r"), "o/r");
  assert.equal(
    repoLabel("https://oauth2:glpat-xyz@gitlab.example.com/group/sub/r.git?token=t#frag"),
    "gitlab.example.com/group/sub/r",
  );
  assert.equal(repoLabel("ssh://git@git.example.com:2222/team/r.git"), "git.example.com/team/r");
  assert.equal(repoLabel("/srv/git/r.git"), undefined);
  assert.equal(repoLabel("file:///srv/git/r.git"), undefined);
  assert.equal(repoLabel(""), undefined);
});

test("git probe output parses into the version's source fields", () => {
  assert.deepEqual(
    parseGitSource("remote=git@github.com:Omniloy/maria-demo.git\nbranch=main\ncommit=1a2b3c4\nchanges=0\n"),
    { repo: "Omniloy/maria-demo", branch: "main", commit: "1a2b3c4", dirty: false },
  );
  assert.deepEqual(parseGitSource("remote=\nbranch=HEAD\ncommit=abcdef1\nchanges=  3\n"), {
    commit: "abcdef1",
    dirty: true,
  });
  assert.equal(parseGitSource("remote=\nbranch=HEAD\ncommit=\nchanges=0\n"), undefined, "a repo with no commit");
  assert.equal(parseGitSource(""), undefined);
});

test("the probe runs in the published directory, quoted", () => {
  assert.equal(publishSourceDir(undefined), ".");
  assert.equal(publishSourceDir("./app/"), "app");
  assert.match(gitSourceCommand("it's"), /^cd -- 'it'\\''s' && git rev-parse/);
});

test("a failed or non-git probe leaves only the directory", async () => {
  const handle = {} as SandboxHandle;
  const nonGit = { run: async () => ({ stdout: "", stderr: "fatal", code: 128, timedOut: false }) };
  assert.deepEqual(await readPublishSource(nonGit, handle, "app"), { dir: "app" });
  const broken = {
    run: async (): Promise<never> => {
      throw new Error("sandbox gone");
    },
  };
  assert.deepEqual(await readPublishSource(broken, handle, undefined), { dir: "." });
});

test("the publish message names the directory, repository revision and entrypoint", () => {
  assert.equal(
    describePublishSource(
      { dir: "app", repo: "Omniloy/maria-demo", branch: "main", commit: "1a2b3c4", dirty: true },
      "node server/index.js",
    ),
    "Source: app/ · repo Omniloy/maria-demo @ main 1a2b3c4 (uncommitted changes) · entrypoint: node server/index.js",
  );
  assert.equal(
    describePublishSource({ dir: ".", commit: "abcdef1", dirty: false }, "node s.js"),
    "Source: whole workspace · git abcdef1 · entrypoint: node s.js",
  );
  assert.equal(describePublishSource(undefined, undefined), "");
});
