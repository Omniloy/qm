import type { DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";
import { hashId } from "../util/crypto.ts";

/**
 * A Drive folder attached to a scope.
 *
 * The mount records *which folder*, never *whose access*. Every turn reaches
 * Drive as its own actor, so two people in one scope see the same mount and
 * different contents — whatever their own Google account can open.
 */
export interface DriveMount {
  id: string;
  scopeId: ScopeId;
  provider: "google";
  /** Drive folder id. Not part of the key: a folder may be attached under any name. */
  externalId: string;
  /** Stable handle the agent and the UI use. Unique within the scope. */
  name: string;
  /** Human-readable Drive location, for display only — it goes stale and is never authoritative. */
  displayPath?: string;
  mode: "ro" | "rw";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

export interface AttachInput {
  scopeId: ScopeId;
  externalId: string;
  name: string;
  displayPath?: string;
  mode: "ro" | "rw";
  createdBy: string;
}

export interface MountReadOptions {
  /**
   * Include folders someone has turned off.
   *
   * Only the UI and the routes that manage mounts may ask for this: a person
   * has to see an off folder to turn it back on. Note that `forScopes` takes
   * no options at all — see below.
   */
  includeDisabled?: boolean;
}

export interface MountStore {
  forScope(scopeId: ScopeId, opts?: MountReadOptions): Promise<DriveMount[]>;
  /**
   * The agent's view, and the reason `enabled` exists.
   *
   * This feeds resolveAttachedFolders, which builds the `## Attached folders`
   * prompt block. It deliberately accepts no options: "off" means the agent
   * cannot see the folder, and a caller should not be able to ask for
   * otherwise even by mistake.
   */
  forScopes(scopeIds: readonly ScopeId[]): Promise<DriveMount[]>;
  get(id: string, opts?: MountReadOptions): Promise<DriveMount | null>;
  attach(input: AttachInput, nowMs: number): Promise<DriveMount>;
  /** Returns the updated mount, or null when there is no such mount. */
  setEnabled(id: string, enabled: boolean, nowMs: number): Promise<DriveMount | null>;
  detach(id: string): Promise<void>;
}

/**
 * Mount names become a stable handle in the prompt and in the UI, so they are
 * constrained to a lowercase DNS-ish label. Validated at the store rather than
 * only at the route: a name that reaches storage unchecked is a name every
 * later consumer has to defend against.
 */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function mountNameError(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return "use lowercase letters, numbers and hyphens, starting with a letter or number (max 32)";
  }
  return null;
}

/** Derive a candidate mount name from a Drive folder title. May return "" if nothing survives. */
export function slugFromFolderName(folderName: string): string {
  return folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/**
 * Keyed on (scopeId, name), NOT on the folder id.
 *
 * Per-scope name uniqueness is then structural: two people attaching the same
 * folder to one channel cannot produce two rows competing for one handle, and
 * re-attaching under an existing name updates that mount in place rather than
 * silently creating a second one.
 */
export const mountId = (scopeId: ScopeId, name: string): string => hashId([scopeId, name]);

export class MountNameInUseError extends Error {
  readonly mountName: string;
  constructor(name: string) {
    super(`the name "${name}" is already used by another folder in this scope`);
    this.mountName = name;
  }
}

export function createMountStore(map: DurableMap<DriveMount>): MountStore {
  const visible = (m: DriveMount): boolean => m.enabled;

  async function forScope(scopeId: ScopeId, opts?: MountReadOptions): Promise<DriveMount[]> {
    const all = await map.all();
    const wanted = (m: DriveMount): boolean => Boolean(opts?.includeDisabled) || visible(m);
    return all.filter((m) => wanted(m) && m.scopeId === scopeId).sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    forScope,

    async forScopes(scopeIds) {
      const wanted = new Set(scopeIds);
      if (!wanted.size) return [];
      const all = await map.all();
      return all
        .filter((m) => visible(m) && wanted.has(m.scopeId))
        .sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.name.localeCompare(b.name));
    },

    async get(id, opts) {
      const m = await map.get(id);
      if (!m) return null;
      return Boolean(opts?.includeDisabled) || visible(m) ? m : null;
    },

    async attach(input, nowMs) {
      const nameError = mountNameError(input.name);
      if (nameError) throw new Error(nameError);

      const id = mountId(input.scopeId, input.name);
      const prior = await map.get(id);

      // Re-attaching a name that currently points at a different folder would
      // silently repoint every reference to it, so refuse rather than surprise.
      // Deliberately not conditioned on `enabled`: turning a folder off does
      // not release its name, and treating it as free would let a re-attach
      // quietly hijack the handle the off folder still owns.
      if (prior && prior.externalId !== input.externalId) {
        throw new MountNameInUseError(input.name);
      }

      const next: DriveMount = {
        id,
        scopeId: input.scopeId,
        provider: "google",
        externalId: input.externalId,
        name: input.name,
        ...(input.displayPath ? { displayPath: input.displayPath } : {}),
        mode: input.mode,
        createdBy: prior?.createdBy ?? input.createdBy,
        createdAt: prior?.createdAt ?? nowMs,
        updatedAt: nowMs,
        enabled: true,
      };
      await map.put(id, next);
      return next;
    },

    async setEnabled(id, enabled, nowMs) {
      const prior = await map.get(id);
      if (!prior) return null;
      const next: DriveMount = { ...prior, enabled, updatedAt: nowMs };
      await map.put(id, next);
      return next;
    },

    async detach(id) {
      await map.delete(id);
    },
  };
}
