import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { connect } from "node:net";
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
  /** Zero or less disables the readiness gate. */
  readyWindowMs?: number;
  appPort?: number;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  const appPort = opts.appPort ?? APP_PORT;

  const dexec = spawnDockerExec(docker);

  // Docker picks the host port and is asked for it again on every read: an
  // allocator held in this process would hand out ports that surviving app
  // containers still hold the moment core restarts.
  const publishedPort = async (n: string): Promise<number | null> => {
    const r = await dexec(["port", n, `${appPort}/tcp`]);
    if (r.code !== 0) return null;
    const first = r.stdout.trim().split("\n")[0] ?? "";
    const port = Number(first.slice(first.lastIndexOf(":") + 1));
    return Number.isInteger(port) && port > 0 ? port : null;
  };

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const candidateName = (d: Deployment) => `${name(d)}-next`;
  const supersededName = (d: Deployment) => `${name(d)}-old`;

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

  // Readiness is probed at the container's own address, never at the published
  // host port: with docker's userland proxy in front of it, that port accepts
  // connections from the moment the container starts, so an app that never
  // binds would pass. Verified against dockerd — the proxy answers, the app
  // does not.
  const containerIp = async (n: string): Promise<string | null> => {
    const r = await dexec(["inspect", "-f", `{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}`, n]);
    if (r.code !== 0) return null;
    const ip = r.stdout.trim();
    return ip && ip !== "<no value>" ? ip : null;
  };

  // "Something accepted a connection on the port", not "something answered
  // GET / with HTTP". A WebSocket-only server, or one whose index does slow
  // work on a cold start, is up — asking it for a prompt HTTP response would
  // call a healthy app dead.
  const listening = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host, port: appPort });
      const done = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(APP_READY_PROBE_TIMEOUT_MS, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });

  const notReady = async (n: string, why: string): Promise<Error> => {
    const logs = await dexec(["logs", "--tail", FAILURE_LOG_LINES, n]);
    const out = `${logs.stdout}${logs.stderr}`.trim().slice(-FAILURE_LOG_BYTES);
    const tail = out ? `; last output from the entrypoint:\n${out}` : "; the entrypoint produced no output";
    return new Error(`${why}${tail}`);
  };

  const waitAppReady = async (n: string, window: number): Promise<void> => {
    const deadline = Date.now() + window;
    for (;;) {
      const ip = await containerIp(n);
      if (ip && (await listening(ip))) return;
      const state = await containerState(n);
      if (state && !state.running) {
        const status = state.exitCode === null ? "" : ` (status ${state.exitCode})`;
        throw await notReady(n, `the entrypoint exited${status} without binding port ${appPort}`);
      }
      if (Date.now() >= deadline)
        throw await notReady(n, `the app never listened on port ${appPort} within ${Math.round(window / 1000)}s`);
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

  const endpointOf = async (d: Deployment): Promise<DeployEndpoint> => {
    // Containerised core shares the deploy network, so it reaches the app at
    // its container name; the published host port is for humans only.
    if (opts.coreContainer) return { host: name(d), port: appPort };
    const port = await publishedPort(name(d));
    if (port === null) throw new Error(`${name(d)} published no host port for ${appPort}`);
    return { host: "127.0.0.1", port };
  };

  /**
   * Put the candidate in front only once it answers. The version already
   * serving is never touched until then, so a version that will not start
   * fails the deploy without taking the app down — which is what let a bad
   * entrypoint turn into a permanent 502 before.
   */
  const promote = async (d: Deployment): Promise<void> => {
    const [live, candidate, superseded] = [name(d), candidateName(d), supersededName(d)];
    await dexec(["rm", "-f", superseded]);
    const hadLive = (await containerState(live)) !== null;
    if (hadLive) {
      const parked = await dexec(["rename", live, superseded]);
      if (parked.code !== 0) throw new Error(`deploy swap failed: ${parked.stderr.trim()}`);
    }
    const renamed = await dexec(["rename", candidate, live]);
    if (renamed.code !== 0) {
      if (hadLive) await dexec(["rename", superseded, live]);
      throw new Error(`deploy swap failed: ${renamed.stderr.trim()}`);
    }
    await dexec(["rm", "-f", superseded]);
  };

  return {
    profile: { managedScaleToZero: false },

    async resolveEndpoint(d: Deployment): Promise<DeployEndpoint | null> {
      // Called before every proxied request. Core loses its endpoint on the
      // deploy network whenever its own container is recreated, so rejoining
      // here is what keeps published apps reachable across a redeploy.
      await ensureCoreOnNetwork();
      if (!(await containerState(name(d)))?.running) return null;
      return endpointOf(d).catch(() => null);
    },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await ensureCoreOnNetwork();
      const candidate = candidateName(d);
      await dexec(["rm", "-f", candidate]);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
        "--name",
        candidate,
        "--network",
        NETWORK,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "-p",
        `127.0.0.1::${appPort}`,
        "-v",
        `${version.snapshotDir}:/app:ro`,
        "-v",
        `${dataVolume(d.id)}:${APP_DATA_DIR}`,
        "-w",
        "/app",
        "-e",
        `PORT=${appPort}`,
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
        const window = opts.readyWindowMs ?? APP_READY_WINDOW_MS;
        if (window > 0) await waitAppReady(candidate, window);
        await promote(d);
      } catch (e) {
        // The candidate's log tail is already in the error; leaving it behind
        // would strand a name, a host port and a disk until someone prunes the
        // host by hand.
        await dexec(["rm", "-f", candidate]);
        throw e;
      }
      return endpointOf(d);
    },

    async destroy(d: Deployment): Promise<void> {
      for (const n of [name(d), candidateName(d), supersededName(d)]) await dexec(["rm", "-f", n]);
      await dexec(["volume", "rm", dataVolume(d.id)]);
    },
  };
}
