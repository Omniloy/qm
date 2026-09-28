import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type HostLookup = (host: string) => Promise<string[]>;

const PRIVATE_NETWORKS = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv6");

function normalizedIp(raw: string): string | null {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/%.*$/, "");
  return isIP(value) ? value : null;
}

export function isPrivateNetworkIp(raw: string): boolean {
  const value = normalizedIp(raw);
  if (!value) return false;
  return PRIVATE_NETWORKS.check(value, isIP(value) === 4 ? "ipv4" : "ipv6");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function bareHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

export const lookupAddresses: HostLookup = (host) =>
  isIP(host)
    ? Promise.resolve([host])
    : dnsLookup(host, { all: true, verbatim: true }).then((results) => results.map((r) => r.address));

export async function publicAddresses(
  host: string,
  lookup: HostLookup = lookupAddresses,
): Promise<string[] | "unresolvable" | "private"> {
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookup(host);
  } catch {
    return "unresolvable";
  }
  return addresses.length && !addresses.some((a) => isPrivateNetworkIp(a)) ? addresses : "private";
}
