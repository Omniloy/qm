import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec } from "../sandbox/docker-exec.ts";
import { sleep } from "../util/async.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;
const APP_READY_WINDOW_MS = 60_000;
const APP_READY_POLL_MS = 250;
const APP_READY_PROBE_TIMEOUT_MS = 2_000;
const FAILURE_LOG_LINES = "40";
const FAILURE_LOG_BYTES = 2_000;
// The snapshot is mounted read-only, so an app has nowhere to keep state unless
// it gets one. The AWS provider gives apps a writable /data; this is the local
// equivalent — a per-deployment named volume that survives redeploys.
const APP_DATA_DIR = "/data";
const dataVolume = (id: string) => `agent-deploy-data-${id.slice(0, 12)}`;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  /**
   * Container name or id core itself runs as, when core is containerised.
   *
   * Apps publish on the host's loopback, which only core-on-the-host can reach.
   * Set this and core joins the deploy network instead, addressing each app by
   * container name. See CORE_CONTAINER.
   */
  coreContainer?: string;
  readyWindowMs?: number;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";

  const dexec = spawnDockerExec(docker);

  // Docker picks the host port and is asked for it again on every read: an
  // allocator held in this process would hand out ports that surviving app
  // containers still hold the moment core restarts.
  const publishedPort = async (n: string): Promise<number | null> => {
    const r = await dexec(["port", n, `${APP_PORT}/tcp`]);
    if (r.code !== 0) return null;
    const first = r.stdout.trim().split("\n")[0] ?? "";
    const port = Number(first.slice(first.lastIndexOf(":") + 1));
    return Number.isInteger(port) && port > 0 ? port : null;
  };

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;

  const containerState = async (n: string): Promise<{ running: boolean; exitCode: number }> => {
    const r = await dexec(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", n]);
    const [running, exitCode] = r.stdout.trim().split(/\s+/);
    return { running: r.code === 0 && running === "true", exitCode: Number(exitCode) || 0 };
  };

  const listening = async (endpoint: DeployEndpoint): Promise<boolean> => {
    try {
      await fetch(`http://${endpoint.host}:${endpoint.port}/`, {
        signal: AbortSignal.timeout(APP_READY_PROBE_TIMEOUT_MS),
      });
      return true;
    } catch {
      return false;
    }
  };

  const notReady = async (n: string, why: string): Promise<Error> => {
    const logs = await dexec(["logs", "--tail", FAILURE_LOG_LINES, n]);
    const out = `${logs.stdout}${logs.stderr}`.trim().slice(-FAILURE_LOG_BYTES);
    const tail = out ? `; last output from the entrypoint:\n${out}` : "; the entrypoint produced no output";
    return new Error(`${why}${tail}`);
  };

  const waitAppReady = async (n: string, endpoint: DeployEndpoint): Promise<void> => {
    const window = opts.readyWindowMs ?? APP_READY_WINDOW_MS;
    const deadline = Date.now() + window;
    for (;;) {
      if (await listening(endpoint)) return;
      const state = await containerState(n);
      if (!state.running)
        throw await notReady(n, `the entrypoint exited (status ${state.exitCode}) without binding port ${APP_PORT}`);
      if (Date.now() >= deadline)
        throw await notReady(n, `the app never listened on port ${APP_PORT} within ${window / 1000}s`);
      await sleep(APP_READY_POLL_MS);
    }
  };

  /** Idempotent: create the deploy network and put core on it. */
  const ensureCoreOnNetwork = async (): Promise<void> => {
    await dexec(["network", "create", NETWORK]);
    if (!opts.coreContainer) return;
    const c = await dexec(["network", "connect", NETWORK, opts.coreContainer]);
    if (c.code !== 0 && !/already exists|already connected/i.test(c.stderr)) {
      throw new Error(`docker network connect ${NETWORK} ${opts.coreContainer} failed: ${c.stderr.trim()}`);
    }
  };

  return {
    profile: { managedScaleToZero: false },

    async resolveEndpoint(d: Deployment): Promise<DeployEndpoint | null> {
      // Called before every proxied request. Core loses its endpoint on the
      // deploy network whenever its own container is recreated, so rejoining
      // here is what keeps published apps reachable across a redeploy.
      await ensureCoreOnNetwork();
      if (!(await containerState(name(d))).running) return null;
      if (opts.coreContainer) return { host: name(d), port: APP_PORT };
      const port = await publishedPort(name(d));
      return port === null ? null : { host: "127.0.0.1", port };
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
      // Containerised core shares the deploy network, so it reaches the app at
      // its container name; the published host port is for humans only.
      let endpoint: DeployEndpoint;
      if (opts.coreContainer) endpoint = { host: name(d), port: APP_PORT };
      else {
        const port = await publishedPort(name(d));
        if (port === null) throw new Error(`deploy run failed: ${name(d)} published no host port for ${APP_PORT}`);
        endpoint = { host: "127.0.0.1", port };
      }
      await waitAppReady(name(d), endpoint);
      return endpoint;
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      await dexec(["volume", "rm", dataVolume(d.id)]);
    },
  };
}
