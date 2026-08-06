import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec } from "../sandbox/docker-exec.ts";

const NETWORK = "agent-deploynet";
const APP_PORT = 8080;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  /**
   * Container name or id core itself runs as, when core is containerised.
   *
   * Apps publish on the host's loopback, which only core-on-the-host can reach.
   * Set this and core joins the deploy network instead, addressing each app by
   * container name. See CORE_CONTAINER.
   */
  coreContainer?: string;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  let nextPort = opts.basePort ?? 9200;
  const ports = new Map<string, number>();
  const freed: number[] = [];
  const allocPort = (n: string): number => {
    const existing = ports.get(n);
    if (existing !== undefined) return existing;
    const port = freed.pop() ?? nextPort++;
    ports.set(n, port);
    return port;
  };
  const freePort = (n: string): void => {
    const p = ports.get(n);
    if (p !== undefined) {
      freed.push(p);
      ports.delete(n);
    }
  };

  const dexec = spawnDockerExec(docker);

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await dexec(["network", "create", NETWORK]);
      if (opts.coreContainer) {
        const c = await dexec(["network", "connect", NETWORK, opts.coreContainer]);
        if (c.code !== 0 && !/already exists|already connected/i.test(c.stderr)) {
          throw new Error(`docker network connect ${NETWORK} ${opts.coreContainer} failed: ${c.stderr.trim()}`);
        }
      }
      await dexec(["rm", "-f", name(d)]);
      const hostPort = allocPort(name(d));
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
        `127.0.0.1:${hostPort}:${APP_PORT}`,
        "-v",
        `${version.snapshotDir}:/app:ro`,
        "-w",
        "/app",
        "-e",
        `PORT=${APP_PORT}`,
        ...envArgs,
        image,
        "sh",
        "-c",
        version.entrypoint,
      ]);
      if (r.code !== 0) {
        freePort(name(d));
        throw new Error(`deploy run failed: ${r.stderr.trim()}`);
      }
      // Containerised core shares the deploy network, so it reaches the app at
      // its container name; the published host port is for humans only.
      if (opts.coreContainer) return { host: name(d), port: APP_PORT };
      return { host: "127.0.0.1", port: hostPort };
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      freePort(name(d));
    },
  };
}
