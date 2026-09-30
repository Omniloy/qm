const RESOURCE_KINDS = ["file", "skill", "deploy", "cron", "service-cred"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
}

const PREFIX: Record<Exclude<ResourceKind, "file">, string> = {
  skill: "skill:",
  deploy: "deployment:",
  cron: "cron:",
  "service-cred": "service-cred:",
};

export const fileRef = (path: string): ResourceRef => ({ kind: "file", id: path });
export const skillRef = (id: string): ResourceRef => ({ kind: "skill", id });
export const deployRef = (id: string): ResourceRef => ({ kind: "deploy", id });
export const cronRef = (id: string): ResourceRef => ({ kind: "cron", id });
export const serviceCredRef = (slug: string): ResourceRef => ({ kind: "service-cred", id: slug });

export function encodeRef(r: ResourceRef): string {
  if (r.kind !== "file") return PREFIX[r.kind] + r.id;
  if (parseRef(r.id).kind !== "file") throw new Error(`"${r.id}" can't be shared as a file — rename it first`);
  return r.id;
}

export function parseRef(s: string): ResourceRef {
  for (const kind of RESOURCE_KINDS) {
    if (kind === "file") continue;
    const p = PREFIX[kind];
    if (s.startsWith(p)) return { kind, id: s.slice(p.length) };
  }
  return { kind: "file", id: s };
}

export const refPrefix = (kind: Exclude<ResourceKind, "file">): string => PREFIX[kind];
