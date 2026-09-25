import type { DockerExec } from "../../src/sandbox/local-sandbox.ts";

export const FAKE_CORE_CONTAINER = "core";

export interface FakeContainer {
  name: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
  volume?: string;
  networkMode?: string;
  attached?: { name: string; gen: number };
}

export interface FakeDocker {
  dockerExec: DockerExec;
  containers: Map<string, FakeContainer>;
  volumes: Set<string>;
  networks: Set<string>;
  subnets: Map<string, string>;
  netGen: Map<string, number>;
  coreNets: Set<string>;
  networkCreates: string[][];
  runCount: number;
  daemonDown: boolean;
  imageMissing: boolean;
  imageId: string;
  imageFingerprint: string;
  startFail?: string;
  runFail?: string;
  runFailLeavesCreated?: boolean;
  connectFail?: { container: string; stderr: string };
  networkRmFail?: string;
}

function cidrRange(cidr: string): [number, number] {
  const [ip = "", bits = "32"] = cidr.split("/");
  const start = ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
  return [start, start + 2 ** (32 - Number(bits)) - 1];
}

function overlaps(a: string, b: string): boolean {
  const [aStart, aEnd] = cidrRange(a);
  const [bStart, bEnd] = cidrRange(b);
  return aStart <= bEnd && bStart <= aEnd;
}

export function installFakeDocker(daemonPort: number): FakeDocker {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const subnets = new Map<string, string>();
  const netGen = new Map<string, number>();
  const coreNets = new Set<string>();
  const self: FakeDocker = {
    containers,
    volumes,
    networks,
    subnets,
    netGen,
    coreNets,
    networkCreates: [],
    runCount: 0,
    daemonDown: false,
    imageMissing: false,
    imageId: "sha256:image-v1",
    imageFingerprint: "",
    dockerExec: async (args) => exec(args),
  };

  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
  const endpointExists = (ctr: string, net: string) =>
    fail(`Error response from daemon: endpoint with name ${ctr} already exists in network ${net}`);
  const liveAttach = (net: string) => ({ name: net, gen: netGen.get(net) ?? 0 });
  const isLive = (c: FakeContainer, net: string) =>
    networks.has(net) && c.attached?.name === net && c.attached.gen === netGen.get(net);

  function parseRun(args: string[]): FakeContainer {
    const c: FakeContainer = { name: "", imageId: self.imageId, running: true, labels: {} };
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--name") c.name = args[++i]!;
      else if (a === "--label") {
        const [k = "", v = ""] = args[++i]!.split("=");
        c.labels[k] = v;
      } else if (a === "-v") c.volume = args[++i]!.split(":")[0]!;
      else if (a === "--network") c.networkMode = args[++i]!;
      else if (a === "-p" || a === "--cpus" || a === "--memory") i++;
    }
    return c;
  }

  function network(sub: string, args: string[]): { code: number; stdout: string; stderr: string } {
    let subnet: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--subnet") subnet = args[++i]!;
      else if (a === "--label") i++;
      else if (a !== "-f") positional.push(a);
    }
    const name = positional[positional.length - 1]!;
    switch (sub) {
      case "inspect":
        return networks.has(name) ? ok(name) : fail(`Error: No such network: ${name}`);
      case "create": {
        self.networkCreates.push(args);
        if (networks.has(name)) return fail(`Error response from daemon: network with name ${name} already exists`);
        if (subnet && [...subnets].some(([n, s]) => networks.has(n) && overlaps(s, subnet))) {
          return fail("Error response from daemon: Pool overlaps with other one on this address space");
        }
        networks.add(name);
        if (subnet) subnets.set(name, subnet);
        netGen.set(name, (netGen.get(name) ?? 0) + 1);
        return ok(name);
      }
      case "rm": {
        if (self.networkRmFail) return fail(self.networkRmFail);
        if (!networks.has(name)) return fail(`Error: No such network: ${name}`);
        const busy = coreNets.has(name) || [...containers.values()].some((c) => c.running && isLive(c, name));
        if (busy)
          return fail(`Error response from daemon: error while removing network: network ${name} has active endpoints`);
        networks.delete(name);
        return ok(name);
      }
      case "connect": {
        const [net = "", ctr = ""] = positional;
        if (!networks.has(net)) return fail(`Error response from daemon: network ${net} not found`);
        if (self.connectFail?.container === ctr) return fail(self.connectFail.stderr);
        if (ctr === FAKE_CORE_CONTAINER) {
          if (coreNets.has(net)) return endpointExists(ctr, net);
          coreNets.add(net);
          return ok();
        }
        const c = containers.get(ctr);
        if (!c) return fail(`Error response from daemon: No such container: ${ctr}`);
        if (isLive(c, net)) return endpointExists(ctr, net);
        c.attached = liveAttach(net);
        return ok();
      }
      case "disconnect": {
        const [net = "", ctr = ""] = positional;
        const c = containers.get(ctr);
        let detached = false;
        if (ctr === FAKE_CORE_CONTAINER) detached = coreNets.delete(net);
        else if (c?.attached?.name === net) {
          delete c.attached;
          detached = true;
        }
        if (detached) return ok();
        return fail(`Error response from daemon: container ${ctr} is not connected to network ${net}`);
      }
      default:
        return fail(`unknown network subcommand ${sub}`);
    }
  }

  function exec(args: string[]): { code: number; stdout: string; stderr: string } {
    const [cmd, ...rest] = args;
    if (self.daemonDown) return fail("Cannot connect to the Docker daemon");
    switch (cmd) {
      case "version":
        return ok("Docker version fake");
      case "image": {
        if (self.imageMissing) return fail("Error: No such image");
        return ok(`${self.imageId} ${self.imageFingerprint}`);
      }
      case "inspect": {
        const name = rest[rest.length - 1]!;
        const c = containers.get(name);
        if (!c) return fail(`Error: No such object: ${name}`);
        return ok(`${c.running} ${c.imageId}`);
      }
      case "network":
        return network(rest[0]!, rest.slice(1));
      case "volume": {
        const [sub, name] = rest as [string, string];
        if (sub === "inspect") return volumes.has(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        if (sub === "create") {
          volumes.add(name);
          return ok(name);
        }
        if (sub === "rm") {
          const attached = [...containers.values()].some((c) => c.volume === name);
          if (attached) return fail(`volume is in use`);
          return volumes.delete(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        }
        return fail(`unknown volume subcommand ${sub}`);
      }
      case "run": {
        const c = parseRun(rest);
        if (self.imageMissing) return fail("Unable to find image");
        if (containers.has(c.name)) return fail(`Conflict. The container name "/${c.name}" is already in use`);
        if (c.networkMode) c.attached = liveAttach(c.networkMode);
        if (c.networkMode && !networks.has(c.networkMode)) {
          containers.set(c.name, { ...c, running: false });
          return {
            code: 125,
            stdout: "",
            stderr: `docker: Error response from daemon: Could not attach to network ${c.networkMode}: rpc error: code = NotFound desc = network ${c.networkMode} not found`,
          };
        }
        if (self.runFail) {
          if (self.runFailLeavesCreated) containers.set(c.name, { ...c, running: false });
          return fail(self.runFail);
        }
        containers.set(c.name, c);
        self.runCount++;
        return ok("deadbeef");
      }
      case "start": {
        const c = containers.get(rest[0]!);
        if (!c) return fail("Error: No such container");
        if (self.startFail) return fail(self.startFail);
        if (c.running) return ok(rest[0]!);
        if (c.attached) {
          if (c.attached.name !== c.networkMode) {
            return fail(`Error response from daemon: could not find a network matching network mode ${c.networkMode}`);
          }
          if (!isLive(c, c.attached.name)) {
            return fail(
              `Error response from daemon: Could not attach to network ${c.attached.name}#${c.attached.gen}: network ${c.attached.name} not found`,
            );
          }
        }
        c.running = true;
        return ok(rest[0]!);
      }
      case "stop": {
        const c = containers.get(rest[rest.length - 1]!);
        if (!c) return fail("Error: No such container");
        c.running = false;
        return ok();
      }
      case "rm": {
        const name = rest[rest.length - 1]!;
        containers.delete(name);
        return ok(name);
      }
      case "port": {
        const c = containers.get(rest[0]!);
        if (!c || !c.running) return fail("Error: No such container or not running");
        return ok(`127.0.0.1:${daemonPort}`);
      }
      default:
        return fail(`fake docker: unsupported command ${cmd}`);
    }
  }

  return self;
}
