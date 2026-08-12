import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";

// A stand-in for the `docker` binary rather than a mocked module: the provider
// builds its own exec, and what matters here is the exact argv it produces.
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
    "FAKE_CONNECT_ERR",
    "FAKE_NET_EXISTS",
  ])
    delete process.env[k];
};

test("resolving an endpoint puts core back on the deploy network", async (t) => {
  // Core joins the network in apply(), but its membership lives on the
  // container, not the image — recreating core (any redeploy) silently drops
  // it, and every published app then times out. Resolving is the one thing
  // that runs before each proxied request, so it is where the repair belongs.
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
  // The steady state: on all but the first request after a restart, the
  // connect fails because it already happened. Treating that as fatal would
  // take down every app it was meant to keep reachable.
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
  // The upstream arrangement, which must keep working: no coreContainer means
  // core is on the host, so the container name would not resolve for it.
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
  // Returning null here would tell the service the container is gone, and it
  // would tear down a perfectly healthy app to replace it. Say we could not
  // read it and let the next request ask again.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";

  const p = createDockerDeployProvider({ docker: docker.bin });
  await assert.rejects(() => p.resolveEndpoint!(deployment(), {} as never), /could not read the published port/);
});

test("the host port comes from docker, not from a counter this process keeps", async (t) => {
  // A restart used to reset the allocator to 9200 while surviving app
  // containers still held those ports, so the next publish died on
  // "port is already allocated" before the app ever ran.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, startupGraceMs: 0 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });

  const run = docker.calls().find((c) => c[0] === "run");
  assert.ok(run, "expected a docker run");
  assert.ok(run.includes("127.0.0.1::8080"), `expected docker to choose the host port: ${run.join(" ")}`);
});

test("an entrypoint that exits fails the deploy with its output", async (t) => {
  // The bug this exists for: `entrypoint: "server.js"` (no `node`) exits 127
  // the instant it starts. Reporting that as a healthy deploy left the app's
  // link answering 502 forever.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "false";
  process.env.FAKE_EXIT_CODE = "127";
  process.env.FAKE_LOGS = "sh: server.js: not found";
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin });
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

test("an app that is merely slow to bind is left alone", async (t) => {
  // Only a container that exits is a failure. Probing the port to decide
  // "ready" mistook a WebSocket-only server, a slow first boot and docker's
  // own userland proxy for signal, in both directions.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, startupGraceMs: 400 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });
  assert.ok(
    !docker.calls().some((c) => c[0] === "rm" && c.join(" ").includes("-f") && docker.calls().indexOf(c) > 1),
    "a running app must not be torn down for being slow",
  );
});

test("a docker that cannot be reached is not reported as a clean exit", async (t) => {
  // `docker inspect` failing means we do not know what happened. Calling that
  // "exited (status 0)" would blame the app for a daemon outage.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, startupGraceMs: 400 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });
});

test("a startup grace of zero skips the crash watch entirely", async (t) => {
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "false";
  process.env.FAKE_EXIT_CODE = "127";
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, startupGraceMs: 0 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });
});
