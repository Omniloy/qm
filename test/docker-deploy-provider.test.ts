import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";

const listeningApp = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// Readiness is a TCP connect, so "not listening" needs a port nothing can be
// listening on. A released ephemeral port is racy — a parallel test can claim
// it — but port 1 is privileged, so an unprivileged test run cannot bind it.
const CLOSED_PORT = 1;

// A stand-in for the `docker` binary rather than a mocked module: the provider
// builds its own exec, and what matters here is the exact argv it produces.
const fakeDocker = (): { bin: string; calls: () => string[][]; reset: () => void } => {
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
      'if [ "$1" = "inspect" ]; then',
      '  case "$3" in',
      '    *IPAddress*) echo "$FAKE_IP"; [ -n "$FAKE_IP" ] || exit 1 ;;',
      '    *) echo "$FAKE_RUNNING $FAKE_EXIT_CODE"; [ -n "$FAKE_RUNNING" ] || exit 1 ;;',
      "  esac",
      "  exit 0",
      "fi",
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
    reset: () => writeFileSync(log, ""),
  };
};

const deployment = (): Deployment => ({ id: "c7574bd2282f4a1b9d0e", ownerScopeId: "s1" }) as unknown as Deployment;
const LIVE = "agent-deploy-c7574bd2282f";
const CANDIDATE = `${LIVE}-next`;
const version = { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir: "/data/x" };

const clearFakes = (): void => {
  for (const k of [
    "FAKE_RUNNING",
    "FAKE_EXIT_CODE",
    "FAKE_LOGS",
    "FAKE_HOST_PORT",
    "FAKE_IP",
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

test("a host-side core resolves to nothing when docker publishes no port", async (t) => {
  // The only coverage of that branch. A regression in the parse would hand
  // core a wrong loopback port and proxy signed-in user traffic to whatever
  // unrelated service happens to be listening there.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";

  const p = createDockerDeployProvider({ docker: docker.bin });
  assert.equal(await p.resolveEndpoint!(deployment(), {} as never), null);
});

test("the host port comes from docker, not from a counter this process keeps", async (t) => {
  // A restart used to reset the allocator to 9200 while surviving app
  // containers still held those ports, so the next publish died on
  // "port is already allocated" before the app ever ran.
  const docker = fakeDocker();
  const app = await listeningApp();
  t.after(async () => {
    clearFakes();
    await app.close();
  });
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_IP = "127.0.0.1";
  process.env.FAKE_HOST_PORT = String(app.port);

  const p = createDockerDeployProvider({ docker: docker.bin, appPort: app.port });
  await p.apply(deployment(), version);

  const run = docker.calls().find((c) => c[0] === "run");
  assert.ok(run, "expected a docker run");
  assert.ok(run.includes(`127.0.0.1::${app.port}`), `expected docker to choose the host port: ${run.join(" ")}`);
});

test("readiness is probed at the container, not at the published host port", async (t) => {
  // docker's userland proxy accepts connections on the published port from the
  // moment the container starts, whether or not anything inside ever binds —
  // verified against dockerd. Probing there would pass every broken app.
  const docker = fakeDocker();
  const app = await listeningApp();
  t.after(async () => {
    clearFakes();
    await app.close();
  });
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_IP = "127.0.0.1";
  process.env.FAKE_HOST_PORT = String(app.port);
  process.env.FAKE_LOGS = "";

  // The container's own address refuses; only the "published" port answers.
  const p = createDockerDeployProvider({ docker: docker.bin, appPort: CLOSED_PORT, readyWindowMs: 700 });
  await assert.rejects(() => p.apply(deployment(), version), /never listened on port 1/);
});

test("the candidate is promoted only after it answers", async (t) => {
  const docker = fakeDocker();
  const app = await listeningApp();
  t.after(async () => {
    clearFakes();
    await app.close();
  });
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_IP = "127.0.0.1";
  process.env.FAKE_HOST_PORT = String(app.port);

  const p = createDockerDeployProvider({ docker: docker.bin, appPort: app.port });
  await p.apply(deployment(), version);

  const calls = docker.calls().map((c) => c.join(" "));
  assert.ok(
    calls.some((c) => c.startsWith(`run -d --name ${CANDIDATE} `)),
    "the new version should start under the candidate name",
  );
  const promotedAt = calls.indexOf(`rename ${CANDIDATE} ${LIVE}`);
  const parkedAt = calls.indexOf(`rename ${LIVE} ${LIVE}-old`);
  assert.ok(promotedAt >= 0, "the candidate should be promoted by rename");
  assert.ok(parkedAt >= 0 && parkedAt < promotedAt, "the live container is parked, not deleted, before the swap");
});

test("a candidate that will not start never touches the live container", async (t) => {
  // The whole point: a bad entrypoint used to remove the serving container
  // first and then fail, leaving the app permanently 502 with no way back.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "false";
  process.env.FAKE_EXIT_CODE = "127";
  process.env.FAKE_LOGS = "sh: server.js: not found";
  process.env.FAKE_IP = "127.0.0.1";

  const p = createDockerDeployProvider({ docker: docker.bin, appPort: CLOSED_PORT });
  await assert.rejects(
    () => p.apply(deployment(), { ...version, entrypoint: "server.js" }),
    /exited \(status 127\)[\s\S]*server\.js: not found/,
  );

  const calls = docker.calls().map((c) => c.join(" "));
  assert.ok(calls.includes(`rm -f ${CANDIDATE}`), "the dead candidate should be removed");
  assert.ok(!calls.includes(`rm -f ${LIVE}`), "the serving container must not be touched");
  assert.ok(!calls.some((c) => c.startsWith("rename ")), "nothing should have been promoted");
});

test("a docker that cannot be reached is not reported as a clean exit", async (t) => {
  // `docker inspect` failing means we do not know what happened. Calling that
  // "exited (status 0)" blames the app for a daemon outage.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_LOGS = "Cannot connect to the Docker daemon";

  const p = createDockerDeployProvider({ docker: docker.bin, appPort: CLOSED_PORT, readyWindowMs: 700 });
  await assert.rejects(
    () => p.apply(deployment(), version),
    (e: Error) => {
      assert.match(e.message, /never listened on port 1/);
      assert.doesNotMatch(e.message, /exited/);
      return true;
    },
  );
});

test("a ready window of zero disables the gate rather than failing everything", async (t) => {
  // An operator reaching for DEPLOY_READY_WINDOW_MS=0 is turning the gate off.
  // Treating it as a zero-length deadline would fail every deploy on the host
  // and delete each healthy container on the way out.
  const docker = fakeDocker();
  t.after(clearFakes);
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_HOST_PORT = "32901";

  const p = createDockerDeployProvider({ docker: docker.bin, appPort: CLOSED_PORT, readyWindowMs: 0 });
  assert.deepEqual(await p.apply(deployment(), version), { host: "127.0.0.1", port: 32901 });
});
