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

const freePort = async (): Promise<number> => {
  const app = await listeningApp();
  await app.close();
  return app.port;
};

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
    reset: () => writeFileSync(log, ""),
  };
};

const deployment = (): Deployment => ({ id: "c7574bd2282f4a1b9d0e", ownerScopeId: "s1" }) as unknown as Deployment;

test("resolving an endpoint puts core back on the deploy network", async (t) => {
  // Core joins the network in apply(), but its membership lives on the
  // container, not the image — recreating core (any redeploy) silently drops
  // it, and every published app then times out. Resolving is the one thing
  // that runs before each proxied request, so it is where the repair belongs.
  const docker = fakeDocker();
  t.after(() => delete process.env.FAKE_RUNNING);
  process.env.FAKE_RUNNING = "true";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  const ep = await p.resolveEndpoint!(deployment(), {} as never);

  assert.deepEqual(ep, { host: "agent-deploy-c7574bd2282f", port: 8080 });
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
  t.after(() => {
    delete process.env.FAKE_RUNNING;
    delete process.env.FAKE_CONNECT_ERR;
    delete process.env.FAKE_NET_EXISTS;
  });
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_NET_EXISTS = "1";
  process.env.FAKE_CONNECT_ERR =
    "Error response from daemon: endpoint with name qm-omniloy-core already exists in network agent-deploynet";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  assert.deepEqual(await p.resolveEndpoint!(deployment(), {} as never), {
    host: "agent-deploy-c7574bd2282f",
    port: 8080,
  });
});

test("a connect failure that is not 'already connected' is surfaced", async (t) => {
  // Silently returning an endpoint core cannot reach would show up as a
  // gateway timeout with nothing in the logs to explain it.
  const docker = fakeDocker();
  t.after(() => {
    delete process.env.FAKE_RUNNING;
    delete process.env.FAKE_CONNECT_ERR;
  });
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_CONNECT_ERR = "Error response from daemon: No such container: qm-omniloy-core";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  await assert.rejects(() => p.resolveEndpoint!(deployment(), {} as never), /No such container/);
});

test("a stopped app resolves to nothing rather than an unreachable address", async (t) => {
  const docker = fakeDocker();
  t.after(() => delete process.env.FAKE_RUNNING);
  process.env.FAKE_RUNNING = "false";

  const p = createDockerDeployProvider({ docker: docker.bin, coreContainer: "qm-omniloy-core" });
  assert.equal(await p.resolveEndpoint!(deployment(), {} as never), null);
});

test("a host-side core still resolves through the published loopback port", async (t) => {
  // The upstream arrangement, which must keep working: no coreContainer means
  // core is on the host, so the container name would not resolve for it.
  const docker = fakeDocker();
  const app = await listeningApp();
  t.after(async () => {
    delete process.env.FAKE_RUNNING;
    await app.close();
  });
  process.env.FAKE_RUNNING = "true";

  const p = createDockerDeployProvider({ docker: docker.bin, basePort: app.port });
  const d = deployment();
  assert.equal(await p.resolveEndpoint!(d, {} as never), null, "no port is allocated until apply runs");

  await p.apply(d, { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir: "/data/x" });
  assert.deepEqual(await p.resolveEndpoint!(d, {} as never), { host: "127.0.0.1", port: app.port });
  assert.ok(
    !docker.calls().some((c) => c[0] === "network" && c[1] === "connect"),
    "nothing should be connected to the deploy network when core is not a container",
  );
});

test("an entrypoint that exits fails the deploy with its output", async (t) => {
  // The bug this guards: `entrypoint: "server.js"` (no `node`) makes the
  // container exit 127 the instant it starts. Returning an endpoint anyway
  // reported a healthy deploy and left the link answering 502 forever.
  const docker = fakeDocker();
  t.after(() => {
    delete process.env.FAKE_RUNNING;
    delete process.env.FAKE_EXIT_CODE;
    delete process.env.FAKE_LOGS;
  });
  process.env.FAKE_RUNNING = "false";
  process.env.FAKE_EXIT_CODE = "127";
  process.env.FAKE_LOGS = "sh: server.js: not found";

  const p = createDockerDeployProvider({ docker: docker.bin, basePort: await freePort() });
  await assert.rejects(
    () => p.apply(deployment(), { version: 1, createdAt: 0, entrypoint: "server.js", snapshotDir: "/data/x" }),
    /exited \(status 127\)[\s\S]*server\.js: not found/,
  );
});

test("a deploy that never binds the port is not reported as running", async (t) => {
  const docker = fakeDocker();
  t.after(() => {
    delete process.env.FAKE_RUNNING;
    delete process.env.FAKE_LOGS;
  });
  process.env.FAKE_RUNNING = "true";
  process.env.FAKE_LOGS = "";

  const p = createDockerDeployProvider({ docker: docker.bin, basePort: await freePort(), readyWindowMs: 300 });
  await assert.rejects(
    () => p.apply(deployment(), { version: 1, createdAt: 0, entrypoint: "node server.js", snapshotDir: "/data/x" }),
    /never listened on port 8080/,
  );
});
