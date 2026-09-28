import type { DockerExec } from "./docker-exec.ts";
import { shortHash } from "../util/crypto.ts";

const DEFAULT_NETWORK_POOL = "198.18.0.0/16";
const MAX_SUBNET_PROBES = 64;

function parseNetworkPool(cidr: string): { base: number; slots: number } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  const octets = m ? m.slice(1, 5).map(Number) : [];
  const prefix = Number(m?.[5]);
  if (!m || octets.some((o) => o > 255) || prefix < 8 || prefix > 28) {
    throw new Error(`docker network pool ${cidr} must be an IPv4 CIDR between /8 and /28`);
  }
  const addr = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (32 - prefix);
  return { base: addr - (addr % size), slots: 2 ** (28 - prefix) };
}

const dottedQuad = (n: number): string => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");

export type EnsurePooledNetwork = (net: string, labels: Record<string, string>) => Promise<string>;

export function createDockerNetworkPool(dexec: DockerExec, cidr = DEFAULT_NETWORK_POOL): EnsurePooledNetwork {
  const { base, slots } = parseNetworkPool(cidr);
  return async (net, labels) => {
    if ((await dexec(["network", "inspect", net])).code === 0) return net;
    const start = parseInt(shortHash(net), 16) % slots;
    const probes = Math.min(slots, MAX_SUBNET_PROBES);
    const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    for (let i = 0; i < probes; i++) {
      const subnet = `${dottedQuad(base + ((start + i) % slots) * 16)}/28`;
      const r = await dexec(["network", "create", "--subnet", subnet, ...labelArgs, net]);
      if (r.code === 0 || /already exists/i.test(r.stderr)) return net;
      if (!/overlap/i.test(r.stderr)) throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
    }
    throw new Error(`docker network create ${net}: no free /28 in ${cidr} after ${probes} probes`);
  };
}
