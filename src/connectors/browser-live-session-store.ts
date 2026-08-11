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

/**
 * How the pane shows this browser.
 *
 * `iframe` embeds a vendor's own viewer, reached with a URL that is bearer
 * material. `stream` means the browser is one of ours: the pane asks MiniOmni for
 * frames over MiniOmni's own authenticated endpoint, so there is no URL, nothing to
 * encrypt, and nothing that could leak into a transcript.
 *
 * A discriminator rather than a nullable URL, so a record cannot be half of
 * each — and so core still never has to branch on which provider it is.
 */
export type ViewerKind = "iframe" | "stream";

export interface LiveBrowserSession {
  principalId: string;
  /** Opaque. Core never branches on this — swapping providers is config. */
  provider: string;
  sessionId: string;
  /** Where the pane renders. Taken from the capability, never from a request body. */
  threadRef: string;
  viewer: ViewerKind;
  /**
   * The vendor's viewer URL, for `iframe` viewers only. Bearer material:
   * anyone holding it can watch and drive the browser, so it is encrypted at
   * rest and only ever returned to its owner. Absent for `stream`, which has
   * no such secret to hold.
   */
  liveViewUrl?: string;
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
  /** Absent on records written before streamed browsers existed. */
  viewer?: ViewerKind;
  /** Only ever set for an `iframe` viewer. */
  liveViewEnc?: string;
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
  /**
   * How many browsers are open right now, across everyone.
   *
   * A browser costs about 1.25 GB, so this is the number that decides whether
   * another one fits on the host. Expired records do not count — they describe
   * browsers that are already gone.
   */
  countLive(nowMs: number): Promise<number>;
}

export function createLiveBrowserSessionStore(deps: {
  sessions: DurableMap<StoredLiveBrowserSession>;
  key: SecretKey;
}): LiveBrowserSessionStore {
  const decode = (rec: StoredLiveBrowserSession): LiveBrowserSession | null => {
    // Records written before streamed browsers existed carry a URL and no
    // discriminator, and they are all iframes.
    const viewer: ViewerKind = rec.viewer ?? "iframe";
    let liveViewUrl: string | undefined;
    if (viewer === "iframe") {
      try {
        liveViewUrl = decryptSecret(rec.liveViewEnc ?? "", deps.key);
      } catch (e) {
        // A record we cannot decrypt is a record we cannot hand to anyone.
        swallow(`live-browser decrypt ${rec.principalId}`, e);
        return null;
      }
    }
    return {
      principalId: rec.principalId,
      provider: rec.provider,
      sessionId: rec.sessionId,
      threadRef: rec.threadRef,
      viewer,
      ...(liveViewUrl === undefined ? {} : { liveViewUrl }),
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
    viewer: s.viewer,
    // Nothing to encrypt for a streamed browser, and writing an empty
    // ciphertext would only invite a later reader to trust it.
    ...(s.viewer === "iframe" ? { liveViewEnc: encryptSecret(s.liveViewUrl ?? "", deps.key) } : {}),
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

    async countLive(nowMs) {
      const all = await deps.sessions.all();
      return all.filter((rec) => rec.expiresAt > nowMs).length;
    },
  };
}
