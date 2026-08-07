import type { DurableMap } from "../persistence/durable-map.ts";
import { encryptSecret, decryptSecret, type SecretKey } from "./connector-client-store.ts";
import { swallow } from "../util/errors.ts";

/**
 * The browser a person currently has open, and who is driving it.
 *
 * Deliberately separate from BrowserSessionStore next door, which holds the
 * durable cookie jar. This one is ephemeral: it exists only while a browser is
 * alive, and its whole job is to let the web UI find that browser and let core
 * arbitrate control of it.
 *
 * Keyed by principalId, one live browser per person. That is the same key the
 * cookie-jar store uses, and it is an authorization boundary rather than a
 * convenience — a browser is logged into someone's real accounts, so it must
 * never be addressable by anyone else.
 */

export type ControlMode = "agent" | "human_control";

export interface LiveBrowserSession {
  principalId: string;
  /** Opaque. Core never branches on this — swapping providers is config. */
  provider: string;
  sessionId: string;
  /** Where the pane renders. Taken from the capability, never from a request body. */
  threadRef: string;
  /**
   * The vendor's viewer URL. Bearer material: anyone holding it can watch and
   * drive the browser, so it is encrypted at rest and only ever returned to
   * its owner.
   */
  liveViewUrl: string;
  controlMode: ControlMode;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  /** When the person took the wheel, so the agent can be told what it missed. */
  handedOffAt?: number;
}

export interface StoredLiveBrowserSession {
  principalId: string;
  provider: string;
  sessionId: string;
  threadRef: string;
  liveViewEnc: string;
  controlMode: ControlMode;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  handedOffAt?: number;
}

export interface LiveBrowserSessionStore {
  /** Null when there is none, or when the one on record has expired. */
  get(principalId: string, nowMs: number): Promise<LiveBrowserSession | null>;
  put(session: LiveBrowserSession): Promise<LiveBrowserSession>;
  /** Null when there is no live session to hand over. */
  setControl(principalId: string, mode: ControlMode, nowMs: number): Promise<LiveBrowserSession | null>;
  clear(principalId: string): Promise<void>;
}

export function createLiveBrowserSessionStore(deps: {
  sessions: DurableMap<StoredLiveBrowserSession>;
  key: SecretKey;
}): LiveBrowserSessionStore {
  const decode = (rec: StoredLiveBrowserSession): LiveBrowserSession | null => {
    let liveViewUrl: string;
    try {
      liveViewUrl = decryptSecret(rec.liveViewEnc, deps.key);
    } catch (e) {
      // A record we cannot decrypt is a record we cannot hand to anyone.
      swallow(`live-browser decrypt ${rec.principalId}`, e);
      return null;
    }
    return {
      principalId: rec.principalId,
      provider: rec.provider,
      sessionId: rec.sessionId,
      threadRef: rec.threadRef,
      liveViewUrl,
      controlMode: rec.controlMode,
      expiresAt: rec.expiresAt,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      ...(rec.handedOffAt === undefined ? {} : { handedOffAt: rec.handedOffAt }),
    };
  };

  const encode = (s: LiveBrowserSession): StoredLiveBrowserSession => ({
    principalId: s.principalId,
    provider: s.provider,
    sessionId: s.sessionId,
    threadRef: s.threadRef,
    liveViewEnc: encryptSecret(s.liveViewUrl, deps.key),
    controlMode: s.controlMode,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(s.handedOffAt === undefined ? {} : { handedOffAt: s.handedOffAt }),
  });

  async function read(principalId: string, nowMs: number): Promise<LiveBrowserSession | null> {
    const rec = await deps.sessions.get(principalId);
    if (!rec) return null;
    // An expired browser is gone at the provider whether or not anyone told
    // us, so serving it would render a pane onto nothing. Drop it on read
    // rather than leaving a tombstone for the next caller to trip over.
    if (rec.expiresAt <= nowMs) {
      await deps.sessions.delete(principalId);
      return null;
    }
    return decode(rec);
  }

  return {
    get: read,

    async put(session) {
      await deps.sessions.put(session.principalId, encode(session));
      return session;
    },

    async setControl(principalId, mode, nowMs) {
      const current = await read(principalId, nowMs);
      if (!current) return null;
      const next: LiveBrowserSession = {
        ...current,
        controlMode: mode,
        updatedAt: nowMs,
        // Cleared on the way back to the agent, so the flag always answers
        // "is a person holding this right now" rather than "did they ever".
        ...(mode === "human_control" ? { handedOffAt: nowMs } : {}),
      };
      if (mode === "agent") delete next.handedOffAt;
      await deps.sessions.put(principalId, encode(next));
      return next;
    },

    async clear(principalId) {
      await deps.sessions.delete(principalId);
    },
  };
}
