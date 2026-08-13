import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec } from "../sandbox/docker-exec.ts";
import { sleep } from "../util/async.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;
const STARTUP_GRACE_MS = 2_000;
const STARTUP_POLL_MS = 200;
const FAILURE_LOG_LINES = "40";
const FAILURE_LOG_BYTES = 2_000;
const APP_DATA_DIR = "/data";
const dataVolume = (id: string) => `agent-deploy-data-${id.slice(0, 12)}`;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  coreContainer?: string;
  startupGraceMs?: number;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";

  const dexec = spawnDockerExec(docker);

  const publishedPort = async (n: string): Promise<number | null> => {
    const r = await dexec(["port", n, `${APP_PORT}/tcp`]);
    if (r.code !== 0) return null;
    const first = r.stdout.trim().split("\n")[0] ?? "";
    const port = Number(first.slice(first.lastIndexOf(":") + 1));
    return Number.isInteger(port) && port > 0 ? port : null;
  };

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;

  const containerState = async (n: string): Promise<{ running: boolean; exitCode: number | null } | null> => {
    const r = await dexec(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", n]);
    if (r.code !== 0) return null;
    const [running, exitCode] = r.stdout.trim().split(/\s+/);
    const parsed = Number(exitCode);
    return { running: running === "true", exitCode: Number.isInteger(parsed) ? parsed : null };
  };

  const exitedWithOutput = async (n: string, exitCode: number | null): Promise<Error> => {
    const logs = await dexec(["logs", "--tail", FAILURE_LOG_LINES, n]);
    const out = `${logs.stdout}${logs.stderr}`.trim().slice(-FAILURE_LOG_BYTES);
    const status = exitCode === null ? "" : ` (status ${exitCode})`;
    return new Error(
      `the entrypoint exited${status} instead of serving on port ${APP_PORT}` +
        (out ? `; last output from the entrypoint:\n${out}` : "; the entrypoint produced no output"),
    );
  };

  const assertStayedUp = async (n: string): Promise<void> => {
    const grace = opts.startupGraceMs ?? STARTUP_GRACE_MS;
    const deadline = Date.now() + grace;
    let sawRunning = false;
    for (;;) {
      const state = await containerState(n);
      if (state && !state.running) throw await exitedWithOutput(n, state.exitCode);
      if (state?.running) sawRunning = true;
      if (Date.now() >= deadline) break;
      await sleep(STARTUP_POLL_MS);
    }
    if (!sawRunning) throw new Error(`could not confirm ${n} started: docker inspect did not answer`);
  };

  const ensureCoreOnNetwork = async (): Promise<void> => {
    await dexec(["network", "create", NETWORK]);
    if (!opts.coreContainer) return;
    const c = await dexec(["network", "connect", NETWORK, opts.coreContainer]);
    if (c.code !== 0 && !/already exists|already connected/i.test(c.stderr)) {
      throw new Error(`docker network connect ${NETWORK} ${opts.coreContainer} failed: ${c.stderr.trim()}`);
    }
  };

  const endpointOf = async (d: Deployment): Promise<DeployEndpoint> => {
    if (opts.coreContainer) return { host: name(d), port: APP_PORT };
    const port = await publishedPort(name(d));
    if (port === null) throw new Error(`could not read the published port of ${name(d)}`);
    return { host: "127.0.0.1", port };
  };

  return {
    profile: { managedScaleToZero: false },

    async resolveEndpoint(d: Deployment): Promise<DeployEndpoint | null> {
      await ensureCoreOnNetwork();
      const state = await containerState(name(d));
      if (!state?.running) return null;
      return endpointOf(d);
    },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await ensureCoreOnNetwork();
      await dexec(["rm", "-f", name(d)]);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
        "--name",
        name(d),
        "--network",
        NETWORK,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "-p",
        `127.0.0.1::${APP_PORT}`,
        "-v",
        `${version.snapshotDir}:/app:ro`,
        "-v",
        `${dataVolume(d.id)}:${APP_DATA_DIR}`,
        "-w",
        "/app",
        "-e",
        `PORT=${APP_PORT}`,
        "-e",
        `DATA_DIR=${APP_DATA_DIR}`,
        ...envArgs,
        image,
        "sh",
        "-c",
        version.entrypoint,
      ]);
      if (r.code !== 0) throw new Error(`deploy run failed: ${r.stderr.trim()}`);
      try {
        await assertStayedUp(name(d));
      } catch (e) {
        await dexec(["rm", "-f", name(d)]);
        throw e;
      }
      return endpointOf(d);
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
    },
  };
}
