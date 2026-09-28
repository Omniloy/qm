import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployApplyOptions, DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
import { sleep } from "../util/async.ts";
import { errMessage } from "../util/errors.ts";

const APP_PORT = 8080;
const LEGACY_NETWORK = "agent-deploynet";
const DAEMON_PROBE_TIMEOUT_MS = 10_000;
const READY_WINDOW_MS = 30_000;
const READY_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 1_500;
const PROBE_CALL_TIMEOUT_MS = 3_000;
const PORT_READ_ATTEMPTS = 3;
const FAILURE_LOG_LINES = "40";
const FAILURE_LOG_BYTES = 2_000;
const APP_DATA_DIR = "/data";
const dataVolume = (id: string) => `agent-deploy-data-${id.slice(0, 12)}`;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  dockerExec?: DockerExec;
  coreContainer?: string;
  readyWindowMs?: number;
}

export interface DockerDaemonProbeOptions {
  docker?: string;
  dockerExec?: DockerExec;
}

export async function dockerDaemonFailure(opts: DockerDaemonProbeOptions = {}): Promise<string | null> {
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.docker ?? "docker");
  try {
    const r = await dexec(["version", "-f", "{{.Server.Version}}"], DAEMON_PROBE_TIMEOUT_MS);
    if (r.code === 0) return null;
    const stderr = r.stderr.trim();
    if (stderr) return stderr;
    return r.code < 0 ? `no response within ${DAEMON_PROBE_TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
  } catch (e) {
    return errMessage(e);
  }
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";

  const dexec = opts.dockerExec ?? spawnDockerExec(docker);

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const network = (d: Deployment) => `${name(d)}-net`;
  const ensureNetwork = async (net: string): Promise<string> => {
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec(["network", "create", net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    return net;
  };

  const connectCore = async (net: string): Promise<void> => {
    if (!opts.coreContainer) return;
    const c = await dexec(["network", "connect", net, opts.coreContainer]);
    if (c.code !== 0 && !/already exists|already connected/i.test(c.stderr)) {
      throw new Error(`docker network connect ${net} ${opts.coreContainer} failed: ${c.stderr.trim()}`);
    }
  };

  const removeNetwork = async (net: string): Promise<void> => {
    if (opts.coreContainer) await dexec(["network", "disconnect", "-f", net, opts.coreContainer]);
    await dexec(["network", "rm", net]);
  };

  const migrateContainer = async (container: string): Promise<boolean> => {
    const inspected = await dexec(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
    if (inspected.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(inspected.stderr)) return false;
      throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
    }
    let attached: Record<string, unknown>;
    try {
      attached = JSON.parse(inspected.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`docker inspect ${container} returned invalid network state`);
    }
    const target = `${container}-net`;
    await ensureNetwork(target);
    if (!(target in attached)) {
      const connected = await dexec(["network", "connect", target, container]);
      if (connected.code !== 0) throw new Error(`docker network connect ${target} failed: ${connected.stderr.trim()}`);
    }
    if (LEGACY_NETWORK in attached) {
      const disconnected = await dexec(["network", "disconnect", LEGACY_NETWORK, container]);
      if (disconnected.code !== 0)
        throw new Error(`docker network disconnect ${LEGACY_NETWORK} failed: ${disconnected.stderr.trim()}`);
    }
    return true;
  };
  const migrateTarget = async (container: string): Promise<boolean> => {
    try {
      return await migrateContainer(container);
    } catch {
      return migrateContainer(container);
    }
  };

  const publishedPort = async (n: string): Promise<number | null> => {
    const r = await dexec(["port", n, `${APP_PORT}/tcp`]);
    if (r.code !== 0) return null;
    const first = r.stdout.trim().split("\n")[0] ?? "";
    const port = Number(first.slice(first.lastIndexOf(":") + 1));
    return Number.isInteger(port) && port > 0 ? port : null;
  };

  const containerState = async (
    n: string,
    timeoutMs?: number,
  ): Promise<{ running: boolean; exitCode: number | null } | null> => {
    const r = await dexec(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", n], timeoutMs);
    if (r.code !== 0) return null;
    const [running, exitCode] = r.stdout.trim().split(/\s+/);
    const parsed = Number(exitCode);
    return { running: running === "true", exitCode: Number.isInteger(parsed) ? parsed : null };
  };

  const exitedWithOutput = async (n: string, exitCode: number | null, why?: string): Promise<Error> => {
    const logs = await dexec(["logs", "--tail", FAILURE_LOG_LINES, n]);
    const out = `${logs.stdout}${logs.stderr}`.trim().slice(-FAILURE_LOG_BYTES);
    const status = exitCode === null ? "" : ` (status ${exitCode})`;
    const headline = why ?? `the entrypoint exited${status} instead of serving on port ${APP_PORT}`;
    return new Error(
      headline + (out ? `; last output from the entrypoint:\n${out}` : "; the entrypoint produced no output"),
    );
  };

  const listeningInside = async (n: string): Promise<"yes" | "no" | "unknown"> => {
    const script =
      `const n=require("os").networkInterfaces();` +
      `const a=Object.values(n).flat().filter(i=>i&&i.family==="IPv4"&&!i.internal).map(i=>i.address);` +
      `const s=require("net").connect({host:a[0]||"127.0.0.1",port:${APP_PORT}});` +
      `s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));` +
      `setTimeout(()=>process.exit(1),${PROBE_TIMEOUT_MS});`;
    const r = await dexec(["exec", n, "node", "-e", script], PROBE_CALL_TIMEOUT_MS);
    if (r.code === 0) return "yes";
    return r.code === 1 ? "no" : "unknown";
  };

  const waitAppReady = async (n: string, windowMs: number): Promise<void> => {
    const deadline = Date.now() + windowMs;
    let sawRunning = false;
    let couldNotProbe = false;
    for (;;) {
      const state = await containerState(n, PROBE_CALL_TIMEOUT_MS);
      if (state && !state.running) throw await exitedWithOutput(n, state.exitCode);
      if (state?.running) {
        sawRunning = true;
        const listening = await listeningInside(n);
        if (listening === "yes") return;
        couldNotProbe = listening === "unknown";
      }
      if (Date.now() >= deadline) break;
      await sleep(READY_POLL_MS);
    }
    if (!sawRunning) throw new Error(`could not confirm ${n} started: docker inspect did not answer`);
    if (couldNotProbe) return;
    throw await exitedWithOutput(
      n,
      null,
      `nothing is serving port ${APP_PORT} on ${n}'s network address — bind 0.0.0.0, not 127.0.0.1`,
    );
  };

  const endpointOf = async (d: Deployment, attempts = 1): Promise<DeployEndpoint> => {
    if (opts.coreContainer) return { host: name(d), port: APP_PORT };
    for (let attempt = 1; ; attempt++) {
      const port = await publishedPort(name(d));
      if (port !== null) return { host: "127.0.0.1", port };
      if (attempt >= attempts) throw new Error(`could not read the published port of ${name(d)}`);
      await sleep(READY_POLL_MS);
    }
  };

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion, applyOpts?: DeployApplyOptions): Promise<DeployEndpoint> {
      const net = await ensureNetwork(network(d));
      await connectCore(net);
      await dexec(["rm", "-f", name(d)]);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
        "--name",
        name(d),
        "--network",
        net,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        ...(opts.coreContainer ? [] : ["-p", `127.0.0.1::${APP_PORT}`]),
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
      if (r.code !== 0) {
        await dexec(["rm", "-f", name(d)]);
        await removeNetwork(net);
        throw new Error(`deploy run failed: ${r.stderr.trim()}`);
      }
      try {
        await waitAppReady(name(d), applyOpts?.readyWindowMs ?? opts.readyWindowMs ?? READY_WINDOW_MS);
      } catch (e) {
        await dexec(["rm", "-f", name(d)]);
        throw e;
      }
      return endpointOf(d, PORT_READ_ATTEMPTS);
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      if (!(await migrateTarget(name(d)))) return null;
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), name(d)]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      await removeNetwork(network(d));
    },

    async resolveEndpoint(d: Deployment): Promise<DeployEndpoint | null> {
      if (!(await migrateTarget(name(d)))) return null;
      await connectCore(network(d));
      const state = await containerState(name(d));
      if (!state?.running) return null;
      return endpointOf(d);
    },
  };
}
