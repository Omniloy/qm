import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";

const fakeDocker = (): { bin: string; calls: () => string[][] } => {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-"));
  const bin = join(dir, "docker");
  const log = join(dir, "calls.log");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${log}`,
      'case "$1 $2" in',
      '  "network create") [ "$FAKE_NET_EXISTS" = 1 ] && { echo "network with name agent-deploynet already exists" >&2; exit 1; }; exit 0 ;;',
      '  "network connect") [ -n "$FAKE_CONNECT_ERR" ] && { echo "$FAKE_CONNECT_ERR" >&2; exit 1; }; exit 0 ;;',
      '  "logs --tail") printf "%s\\n" "$FAKE_LOGS"; exit 0 ;;',
      "esac",
      'if [ "$1" = "port" ]; then [ -n "$FAKE_HOST_PORT" ] || exit 1; echo "127.0.0.1:$FAKE_HOST_PORT"; exit 0; fi',
      'if [ "$1" = "exec" ]; then',
      '  case "$FAKE_LISTENING" in',
      "    yes) exit 0 ;;",
      "    unknown) exit 126 ;;",
      "    *) exit 1 ;;",
      "  esac",
      "fi",
      'if [ "$1" = "inspect" ]; then echo "$FAKE_RUNNING $FAKE_EXIT_CODE"; [ -n "$FAKE_RUNNING" ] || exit 1; fi',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => l.split(" "))
        : [],
  };
};

const deployment = (): Deployment => ({ id: "c7574bd2282f4a1b9d0e", ownerScopeId: "s1" }) as unknown as Deployment;
const LIVE = "agent-deploy-c7574bd2282f";
const version = { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir: "/data/x" };

const clearFakes = (): void => {
  for (const k of [
    "FAKE_RUNNING",
    "FAKE_EXIT_CODE",
    "FAKE_LOGS",
    "FAKE_HOST_PORT",
    "FAKE_LISTENING",
    "FAKE_CONNECT_ERR",
    "FAKE_NET_EXISTS",
  ])
    delete process.env[k];
};

test("resolving an endpoint puts core back on the deploy network", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  assert.deepEqual(await p.resolveEndpoint!(deployment(), {} as never), { host: LIVE, port: 8080 });
  assert.ok(
    docker.calls().some((c) => c.join(" ") === "network connect agent-deploynet qm-omniloy-core"),
    "expected core to be reconnected to the deploy network",
  );
});

test("an already-connected core is not an error", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_NET_EXISTS = "1";
  process.env.FAKE_CONNECT_ERR =
    "Error response from daemon: endpoint with name qm-omniloy-core already exists in network agent-deploynet";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  assert.deepEqual(await p.resolveEndpoint!(deployment(), {} as never), { host: LIVE, port: 8080 });
});

test("a connect failure that is not 'already connected' is surfaced", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_CONNECT_ERR = "Error response from daemon: No such container: qm-omniloy-core";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  await assert.rejects(() => p.resolveEndpoint!(deployment(), {} as never), /No such container/);
});

test("a stopped app resolves to nothing rather than an unreachable address", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "false";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  assert.equal(await p.resolveEndpoint!(deployment(), {} as never), null);
});

test("a host-side core resolves through the published loopback port", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32895";

  const p = createDockerDeployProvider({ docker: docker.bin });
  assert.deepEqual(await p.resolveEndpoint!(deployment(), {} as never), { host: "127.0.0.1", port: 32895 });
  assert.ok(
    !docker.calls().some((c) => c[0] === "network" && c[1] === "connect"),
    "nothing should be connected to the deploy network when core is not a container",
  );
});

test("a running app whose port mapping cannot be read is not rebuilt", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";

  const p = createDockerDeployProvider({ docker: docker.bin });
  await assert.rejects(() => p.resolveEndpoint!(deployment(), {} as never), /could not read the published port/);
});

test("the host port comes from docker, not from a counter this process keeps", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32901";
  process.env.FAKE_LISTENING = "yes";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 0 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });

  const run = docker.calls().find((c) => c[0] === "run");
  assert.ok(run, "expected a docker run");
  assert.ok(run.includes("127.0.0.1::8080"), `expected docker to choose the host port: ${run.join(" ")}`);
});

test("an entrypoint that exits fails the deploy with its output", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "false";
  process.env.FAKE_EXIT_CODE = "127";
  process.env.FAKE_LOGS = "sh: server.js: not found";
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 500 });
  await assert.rejects(
    () => p.apply(deployment(), { ...version, entrypoint: "server.js" }),
    /exited \(status 127\)[\s\S]*server\.js: not found/,
  );
  assert.equal(
    docker.calls().filter((c) => c[0] === "rm").length,
    2,
    "the corpse should be removed as well as the container this replaced",
  );
});

test("an app that binds the port is accepted", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32901";
  process.env.FAKE_LISTENING = "yes";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 5_000 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });
});

test("an app that stays up but never listens fails the deploy", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32901";
  process.env.FAKE_LISTENING = "no";
  process.env.FAKE_LOGS = "listening on 127.0.0.1:3000";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 500 });
  await assert.rejects(() => p.apply(deployment(), version), /nothing is listening on port 8080/);
  assert.ok(
    docker.calls().some((c) => c.join(" ") === `rm -f ${LIVE}`),
    "the container that never served should be removed",
  );
});

test("an image the probe cannot run in does not block the deploy", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32901";
  process.env.FAKE_LISTENING = "unknown";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 400 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });
});

test("a docker that cannot be reached is neither a clean exit nor a successful deploy", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 400 });
  await assert.rejects(
    () => p.apply(deployment(), version),
    (e: Error) => {
      assert.match(e.message, /could not confirm/);
      assert.doesNotMatch(e.message, /exited/);
      return true;
    },
  );
});

test("a port read that keeps failing removes the container rather than orphaning it", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_LISTENING = "yes";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 0 });
  await assert.rejects(() => p.apply(deployment(), version), /could not read the published port/);
  assert.ok(
    docker.calls().filter((c) => c[0] === "port").length > 1,
    "a transient read should be retried before giving up",
  );
  assert.equal(
    docker.calls().filter((c) => c[0] === "rm").length,
    2,
    "the unreachable container should not be left running",
  );
});

test("a container that is already dead is caught without waiting out the grace", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "false";
  process.env.FAKE_EXIT_CODE = "127";
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, readyWindowMs: 0 });
  await assert.rejects(() => p.apply(deployment(), version), /exited \(status 127\)/);
});

test("destroying a deployment does not delete its durable data", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);

  const p = createDockerDeployProvider({ docker: docker.bin });
  await p.destroy(deployment());
  assert.ok(
    !docker.calls().some((c) => c[0] === "volume"),
    "no volume should be removed when a deployment is stopped or archived",
  );
});
