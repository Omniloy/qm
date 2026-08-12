import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec } from "../sandbox/docker-exec.ts";
import { sleep } from "../util/async.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;
const STARTUP_GRACE_MS = 5_000;
const STARTUP_POLL_MS = 250;
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
  /** How long to watch a freshly launched app for a crash. Zero disables it. */
  startupGraceMs?: number;
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

  // null means docker could not be asked, which is not the same as "the app
  // died": reporting a daemon hiccup as a clean exit would blame the app for
  // an exit code it never produced.
  const containerState = async (n: string): Promise<{ running: boolean; exitCode: number | null } | null> => {
    const r = await dexec(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", n]);
    if (r.code !== 0) return null;
    const [running, exitCode] = r.stdout.trim().split(/\s+/);
    const parsed = Number(exitCode);
    return { running: running === "true", exitCode: Number.isInteger(parsed) ? parsed : null };
  };

  /**
   * Fail a deploy only when the app is certainly dead — the container exited
   * on its own — and never on a guess about whether it is "ready".
   *
   * Earlier attempts probed the port. Every version of that was wrong for some
   * legitimate app: through docker's userland proxy the published port answers
   * before anything inside binds, so the check passed everything; at the
   * container's own address it is unroutable from a host-side core on Docker
   * Desktop, so it passed nothing; and either way a WebSocket-only server or a
   * slow first boot looks identical to a crash. An exit is unambiguous, and an
   * exit is what a bad entrypoint produces.
   */
  const assertStayedUp = async (n: string): Promise<void> => {
    const grace = opts.startupGraceMs ?? STARTUP_GRACE_MS;
    if (grace <= 0) return;
    const deadline = Date.now() + grace;
    for (;;) {
      const state = await containerState(n);
      if (state && !state.running) {
        const logs = await dexec(["logs", "--tail", FAILURE_LOG_LINES, n]);
        const out = `${logs.stdout}${logs.stderr}`.trim().slice(-FAILURE_LOG_BYTES);
        const status = state.exitCode === null ? "" : ` (status ${state.exitCode})`;
        throw new Error(
          `the entrypoint exited${status} instead of serving on port ${APP_PORT}` +
            (out ? `; last output from the entrypoint:\n${out}` : "; the entrypoint produced no output"),
        );
      }
      if (Date.now() >= deadline) return;
      await sleep(STARTUP_POLL_MS);
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
      const state = await containerState(name(d));
      if (!state) return null;
      if (!state.running) return null;
      // Containerised core shares the deploy network, so it reaches the app at
      // its container name; the published host port is for humans only.
      if (opts.coreContainer) return { host: name(d), port: APP_PORT };
      const port = await publishedPort(name(d));
      // A running container whose port mapping we could not read is not a
      // reason to tear it down and build another: say we cannot reach it and
      // let the next request ask again.
      if (port === null) throw new Error(`could not read the published port of ${name(d)}`);
      return { host: "127.0.0.1", port };
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
      const endpoint: DeployEndpoint = opts.coreContainer
        ? { host: name(d), port: APP_PORT }
        : { host: "127.0.0.1", port: (await publishedPort(name(d))) ?? 0 };
      try {
        await assertStayedUp(name(d));
      } catch (e) {
        // Its log tail is already in the error; leaving the corpse behind would
        // strand a name, a host port and a disk until someone prunes by hand.
        await dexec(["rm", "-f", name(d)]);
        throw e;
      }
      if (!endpoint.port) throw new Error(`${name(d)} published no host port for ${APP_PORT}`);
      return endpoint;
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      await dexec(["volume", "rm", dataVolume(d.id)]);
    },
  };
}
