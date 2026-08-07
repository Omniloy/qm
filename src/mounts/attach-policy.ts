import type { ScopeId } from "../types.ts";
import { mountNameError } from "./mount-store.ts";

/**
 * Who may attach a Drive folder to a scope, and when.
 *
 * Kept apart from the route so the decision can be tested on its own: this is
 * the boundary that decides whose Google account gets lent to a room, and a
 * bug here is not a bad response, it is an authorization failure.
 */

export type MountDecision = { ok: true } | { ok: false; status: number; error: string; message: string };

const ALLOW: MountDecision = { ok: true };

export const AGENT_MAY_NOT_ATTACH = "attaching a folder is a person's decision — ask them to do it from the Files page";

export interface MutationInput {
  /** True when this call comes from an agent turn rather than a person at a keyboard. */
  triggered: boolean;
  principalId: string;
  scopeId: ScopeId;
  /**
   * The same check that governs uploading a file to this scope
   * (app-helpers.ts canUseContext). Deliberately the same function rather than
   * a parallel rule, so the two cannot drift apart.
   */
  canUseContext: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
}

/**
 * Attaching and detaching are mutations of what the agent can reach, so an
 * agent turn must never perform them — otherwise a prompt-injected document
 * inside one folder could talk the agent into attaching another.
 */
export async function decideMountMutation(input: MutationInput): Promise<MountDecision> {
  if (input.triggered) {
    return { ok: false, status: 403, error: "forbidden", message: AGENT_MAY_NOT_ATTACH };
  }
  if (!(await input.canUseContext(input.principalId, input.scopeId))) {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "you can only attach folders to a conversation you can upload files to",
    };
  }
  return ALLOW;
}

/**
 * Reading the mount list is not a mutation and is allowed on a triggered turn:
 * the prompt block already tells the agent which folders are attached, so
 * refusing the same information over the API would be theatre.
 */
export async function decideMountRead(input: Omit<MutationInput, "triggered">): Promise<MountDecision> {
  if (!(await input.canUseContext(input.principalId, input.scopeId))) {
    return { ok: false, status: 403, error: "forbidden", message: "you cannot see this conversation" };
  }
  return ALLOW;
}

export interface AttachBody {
  scopeId?: unknown;
  externalId?: unknown;
  name?: unknown;
  mode?: unknown;
  displayPath?: unknown;
}

export type ParsedAttach =
  | { ok: true; value: { scopeId: ScopeId; externalId: string; name: string; mode: "ro" | "rw"; displayPath?: string } }
  | { ok: false; message: string };

/** Validate the request body before any authorization work or Drive call. */
export function parseAttachBody(body: AttachBody): ParsedAttach {
  const { scopeId, externalId, name, mode, displayPath } = body;

  if (typeof scopeId !== "string" || !scopeId) return { ok: false, message: "scopeId is required" };
  if (typeof externalId !== "string" || !externalId) return { ok: false, message: "externalId is required" };
  if (typeof name !== "string") return { ok: false, message: "name is required" };
  if (mode !== "ro" && mode !== "rw") return { ok: false, message: 'mode must be "ro" or "rw"' };
  if (displayPath !== undefined && typeof displayPath !== "string") {
    return { ok: false, message: "displayPath must be a string when present" };
  }

  const nameError = mountNameError(name);
  if (nameError) return { ok: false, message: nameError };

  return {
    ok: true,
    value: { scopeId, externalId, name, mode, ...(displayPath ? { displayPath } : {}) },
  };
}
