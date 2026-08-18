import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { orgId as orgIdOf } from "../config.ts";
import type { ScopeId, Session } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { SessionShareRecord, SessionShareStore } from "../sessions/session-share.ts";
import { scrubSecrets, shareVisibleEntries, type SharedEntry } from "../sessions/share-redaction.ts";

/**
 * Public read links, resolved.
 *
 * Core owns authorization for this feature the same way it owns it for every
 * other route: the web-ui server and the portal carry bytes, they never decide
 * who may read them. Three rules run through this module.
 *
 *   1. A link never reveals more than the person who minted it could see. Every
 *      resolution reads `visibleEntries(sessionId, rec.sharerId)` — the sharer's
 *      own participant window — and never `getEntries`.
 *   2. Authorization is recomputed on EVERY resolve and never trusted from the
 *      stored row. The row records who shared what; whether that is still
 *      allowed is a question only the live system can answer.
 *   3. The payload carries no identifiers. `threadRef` is literally
 *      `web:<principalId>:<uuid>` and a personal scope is `personal:<principalId>`,
 *      so returning a Session envelope would publish the sharer's identity to
 *      every stranger holding the URL. We return prose, timestamps and files.
 */

/** How the person on the other end of the link stands relative to the conversation. */
type ShareAccess = "anonymous" | "member" | "outsider";

interface SharedTranscript {
  access: ShareAccess;
  entries: SharedEntry[];
  /** Regenerated title text, or null. Never the Session row. */
  title: string | null;
  /**
   * The sharer's directory display name, or null when they have none.
   *
   * Deliberately never `|| sharerId`: the house idiom for a label is
   * `displayName || id`, and for the many principals with no directory entry
   * that idiom would print `alice@company.com` onto an anonymous page.
   */
  sharerLabel: string | null;
  /** Present only for a member — it is the one field that is useless to a stranger and useful to a colleague. */
  sessionId?: string;
}

interface SharedLinkView {
  shareId: string;
  createdAt: number;
  viewCount: number;
  lastViewedAt?: number;
  /** True when the caller is the person who minted this link. */
  mine: boolean;
  sharerLabel: string | null;
}

/**
 * A file a link holder may download.
 *
 * There is deliberately no `mimetype` here. The stored mimetype comes from the
 * uploaded filename, so an attachment called `x.js` would be served as
 * `text/javascript` from the app origin — a same-origin script source that the
 * SPA's `script-src 'self'` would happily execute. Not carrying the type out of
 * core makes serving it structurally impossible rather than a matter of the
 * route remembering.
 */
interface SharedFileDownload {
  name: string;
  sizeBytes: number;
  stream: Readable;
}

type ShareDenial = "not_found" | "forbidden" | "not_configured";

type MintResult = { ok: true; shareId: string; createdAt: number } | { ok: false; reason: ShareDenial };

export interface ShareMethods {
  /**
   * Mint a link. Gated on the SAME predicate the read path uses, plus current
   * scope access — so minting is strictly stricter than reading the conversation
   * in the app: a stale participant row whose scope membership has lapsed can
   * still open the conversation but can no longer publish it. Resolution applies
   * that same scope check on every request, so a lapse also kills the links that
   * principal minted while they still had access.
   */
  createSessionShare(sessionId: string, principalId: string): Promise<MintResult>;
  /** Null when the caller cannot see the conversation at all. */
  listSessionShares(sessionId: string, principalId: string): Promise<SharedLinkView[] | null>;
  /** Null when the caller cannot see the conversation; otherwise how many links were turned off. */
  revokeSessionShare(sessionId: string, principalId: string, shareId?: string): Promise<number | null>;
  /**
   * `sinceIndex` is a poll cursor over the SHARE-LOCAL index `i`, inclusive of
   * the index given: the page sends the highest index already on screen, so a
   * duplicate tail entry is cheap and a missed one is not. It only trims the
   * response — every authorization check still runs in full on every poll.
   */
  resolveSharedTranscript(
    shareId: string,
    viewer: string | null,
    opts?: { countView?: boolean; sinceIndex?: number },
  ): Promise<SharedTranscript | null>;
  resolveSharedFile(shareId: string, artifactId: string, viewer: string | null): Promise<SharedFileDownload | null>;
}

/** The slice of AppDeps this module needs. AppDeps satisfies it structurally. */
export interface ShareAppDeps {
  sessions: SessionStore;
  identity: IdentityService;
  directory: Pick<DirectoryStore, "get">;
  auditLog?: AuditLog;
  /**
   * Present unless PUBLIC_SHARE_LINKS is explicitly disabled. The feature ships
   * ON, and the flag is the kill switch rather than the launch switch: with no
   * store every method answers "not_configured" and every public route 404s,
   * with no flag threaded through the routes.
   */
  sessionShares?: SessionShareStore;
}

/** The slice of AppHelpers this module needs. AppHelpers satisfies it structurally. */
export interface ShareHelpers {
  sessionsForViewer(principalId: string): Promise<Session[]>;
  principalCanAccessCurrentScope(principalId: string, targetScope: ScopeId): Promise<boolean>;
}

/**
 * The one file reader a share may use.
 *
 * Typed as the App method rather than a fresh reader on purpose: the share file
 * route must reuse the existing ACL check, never write a second one that can
 * drift from it.
 */
export interface ShareFileOpener {
  openFileForViewer(id: string, principalId: string): Promise<SharedFileDownload | null>;
}

const MAX_TITLE_CHARS = 200;

/**
 * A non-reversible handle for the audit log.
 *
 * The share id is a bearer secret — anyone holding it can read the
 * conversation — so writing it into an audit row would turn read access to the
 * audit log into read access to every shared transcript.
 */
function shareHandle(shareId: string): string {
  return createHash("sha256").update(shareId).digest("hex").slice(0, 12);
}

export function createShareMethods(deps: ShareAppDeps, helpers: ShareHelpers, files: ShareFileOpener): ShareMethods {
  const audit = (e: {
    principalId: string;
    action: string;
    resource: string;
    scopeLabel: ScopeId;
    status?: string;
    detail?: string;
  }): void => deps.auditLog?.record({ at: Date.now(), ...e });

  /**
   * Directory display name only — never the principal id, in any fallback.
   *
   * Equality with the principal id is not enough. Principal ids here are usually
   * Slack ids (`U0CAROL`) while display names come from a directory sync that in
   * many workspaces stores addresses, so `U5` with display name `dana@acme.com`
   * clears an equality check and lands the address in a payload any stranger can
   * `curl`. Client-side prettifying does not protect the JSON, so the shape is
   * rejected here: anything containing `@` or carrying a `scheme:` prefix is
   * treated as an identifier rather than a name.
   */
  const IDENTIFIER_SHAPED = /@|^[a-z][a-z0-9+.-]*:/i;

  async function labelFor(principalId: string): Promise<string | null> {
    const member = await deps.directory.get(principalId).catch(() => null);
    const name = member?.displayName?.trim();
    if (!name) return null;
    if (name.toLowerCase() === principalId.toLowerCase()) return null;
    if (IDENTIFIER_SHAPED.test(name)) return null;
    return name;
  }

  /**
   * Re-authorize a link from scratch, on every single request.
   *
   * Six independent ways a live link dies, none of them read from the row:
   * revoked; the sharer is no longer an internal principal; the session is gone;
   * the session moved to another scope; the sharer lost their participant row;
   * the sharer lost access to the scope the conversation lives in.
   *
   * The last two are separate checks because `sessionsForViewer` is not the same
   * predicate as the one minting uses. It filters on `managedProjectMembership`,
   * which answers `undefined` — i.e. "not my business" — for every scope that is
   * not a managed project group, so for a channel-scoped conversation it reduces
   * to "is there still a participant row". Resolution must be exactly as strict
   * as minting and never weaker: without the scope check, someone removed from a
   * private channel could no longer publish it, while every link they had
   * already published kept serving that channel's conversation to the anonymous
   * internet. Losing access has to end publication, not just future publication.
   */
  async function liveShare(
    shareId: string,
  ): Promise<{ shareId: string; rec: SessionShareRecord; session: Session } | null> {
    const store = deps.sessionShares;
    if (!store) return null;

    const found = await store.get(shareId);
    if (!found.ok) return null;
    const rec = found.rec;

    await deps.identity.refresh();
    if (!deps.identity.isInternal(deps.identity.classify(rec.sharerId))) return null;

    const session = await deps.sessions.get(rec.sessionId);
    if (!session) return null;
    // A conversation that moved scopes is a different audience than the one the
    // sharer published from, so the old consent does not carry over.
    if (session.scopeId !== rec.scopeId) return null;

    const entitled = (await helpers.sessionsForViewer(rec.sharerId)).some((s) => s.id === rec.sessionId);
    if (!entitled) return null;

    // The mint-time predicate, re-run. See the note above: this is the check
    // that makes channel eviction revoke the publication too.
    if (!(await helpers.principalCanAccessCurrentScope(rec.sharerId, rec.scopeId))) return null;

    return { shareId, rec, session };
  }

  async function accessFor(sessionId: string, viewer: string | null): Promise<ShareAccess> {
    if (!viewer) return "anonymous";
    const mine = await helpers.sessionsForViewer(viewer);
    return mine.some((s) => s.id === sessionId) ? "member" : "outsider";
  }

  async function visibleSession(sessionId: string, principalId: string): Promise<Session | null> {
    const session = (await helpers.sessionsForViewer(principalId)).find((s) => s.id === sessionId);
    return session ?? null;
  }

  /**
   * Everything this share publishes, in share-local index order.
   *
   * The one projection. The transcript route slices it for the poll cursor and
   * the file route reads artifact ids out of it, so a file that redaction
   * dropped is unreachable by its id for exactly the same reason it is absent
   * from the messages.
   */
  async function publishedEntries(rec: SessionShareRecord): Promise<SharedEntry[]> {
    // The sharer's window, always. A member who joined the conversation later
    // reads what the sharer could read, which is what a link means — and is why
    // the viewer's own principal is recorded on the view audit row.
    return shareVisibleEntries(await deps.sessions.visibleEntries(rec.sessionId, rec.sharerId));
  }

  /** Deduped per viewer per hour, so a 10s poll cannot bury the log. */
  async function auditOnce(key: string, event: Parameters<AuditLog["record"]>[0]): Promise<void> {
    if (deps.auditLog?.recordOnce) await deps.auditLog.recordOnce(key, event);
    else deps.auditLog?.record(event);
  }

  /**
   * The single resolution path. Both public routes go through this, so a change
   * to what a link may reveal cannot apply to the transcript and miss the files.
   *
   * Null is the only failure. Revoked, forged, expired-by-revocation, sharer
   * deactivated, session deleted — every one of them produces the identical
   * answer, so the endpoint never confirms that a share id exists.
   */
  async function resolveSharedTranscript(
    shareId: string,
    viewer: string | null,
    opts?: { countView?: boolean; sinceIndex?: number },
  ): Promise<SharedTranscript | null> {
    const live = await liveShare(shareId);
    if (!live) return null;
    const { rec, session } = live;

    const all = await publishedEntries(rec);
    // Inclusive of the cursor: the page sends the highest index it has painted,
    // and its reconcile is keyed on `i`, so one duplicate is free while one
    // missed entry would silently stall a live share.
    const from = typeof opts?.sinceIndex === "number" && opts.sinceIndex > 0 ? Math.floor(opts.sinceIndex) : 0;
    const entries = from > 0 ? all.filter((e) => e.i >= from) : all;
    // A response that starts at the beginning is a full read of the transcript,
    // whatever the caller passed. Deciding this from the cursor's PRESENCE let
    // `?sinceIndex=0` return everything while suppressing the counter, so a
    // reader could take the whole conversation as often as they liked and never
    // appear in it. With no expiry, that counter is the sharer's only way to
    // notice a link is being used.
    const fullRead = from === 0;
    const access = await accessFor(rec.sessionId, viewer);
    const title = session.title?.trim() ? scrubSecrets(session.title.trim()).slice(0, MAX_TITLE_CHARS) : null;

    if (fullRead || opts?.countView !== false) {
      await deps.sessionShares?.noteView(shareId);
      const now = Date.now();
      // Keyed on the viewer so an org member using a link to read outside their
      // own participant window is visible, rather than averaged into "someone
      // opened it".
      await auditOnce(`share.view:${shareHandle(shareId)}:${viewer ?? "anon"}:${Math.floor(now / 3_600_000)}`, {
        at: now,
        principalId: viewer ?? "anonymous",
        action: "session.share.view",
        resource: `session:${rec.sessionId}`,
        scopeLabel: rec.scopeId,
        detail: `${shareHandle(shareId)} ${access}`,
      });
    }

    return {
      access,
      entries,
      title,
      sharerLabel: await labelFor(rec.sharerId),
      // Only a member gets the id, and only because they can already open it.
      ...(access === "member" ? { sessionId: rec.sessionId } : {}),
    };
  }

  return {
    async createSessionShare(sessionId, principalId) {
      const store = deps.sessionShares;
      if (!store) return { ok: false, reason: "not_configured" };

      // The read predicate, verbatim. A conversation you cannot open is a
      // conversation whose existence you do not learn from this endpoint.
      const session = await visibleSession(sessionId, principalId);
      if (!session) return { ok: false, reason: "not_found" };

      // Strictly stricter than reading: current membership of the scope, the
      // same check that governs spawning a session there.
      if (!(await helpers.principalCanAccessCurrentScope(principalId, session.scopeId))) {
        return { ok: false, reason: "forbidden" };
      }

      const createdAt = Date.now();
      const org = orgIdOf();
      const { shareId } = await store.mint(
        {
          sessionId,
          scopeId: session.scopeId,
          sharerId: principalId,
          ...(org ? { orgId: org } : {}),
        },
        createdAt,
      );
      audit({
        principalId,
        action: "session.share.create",
        resource: `session:${sessionId}`,
        scopeLabel: session.scopeId,
        detail: shareHandle(shareId),
      });
      return { ok: true, shareId, createdAt };
    },

    async listSessionShares(sessionId, principalId) {
      const store = deps.sessionShares;
      if (!store) return null;
      if (!(await visibleSession(sessionId, principalId))) return null;
      const rows = await store.forSession(sessionId);
      return Promise.all(
        rows.map(async ({ shareId, rec }) => ({
          shareId,
          createdAt: rec.createdAt,
          viewCount: rec.viewCount,
          ...(rec.lastViewedAt !== undefined ? { lastViewedAt: rec.lastViewedAt } : {}),
          mine: rec.sharerId === principalId,
          sharerLabel: await labelFor(rec.sharerId),
        })),
      );
    },

    async revokeSessionShare(sessionId, principalId, shareId) {
      const store = deps.sessionShares;
      if (!store) return null;
      const session = await visibleSession(sessionId, principalId);
      if (!session) return null;

      // Any member of the conversation may turn a link off, including one they
      // did not mint — the exposure is theirs too, and "ask the sharer" is not
      // an answer when the transcript is live.
      const targets = (await store.forSession(sessionId)).filter((row) => !shareId || row.shareId === shareId);
      let turnedOff = 0;
      for (const row of targets) {
        if (!(await store.revoke(row.shareId, principalId))) continue;
        turnedOff += 1;
        audit({
          principalId,
          action: "session.share.revoke",
          resource: `session:${sessionId}`,
          scopeLabel: session.scopeId,
          detail: `${shareHandle(row.shareId)} ${row.rec.sharerId === principalId ? "self" : "participant"}`,
        });
      }
      return turnedOff;
    },

    resolveSharedTranscript,

    async resolveSharedFile(shareId, artifactId, viewer) {
      // Gate one: the SAME re-authorization the transcript goes through, so
      // every revocation trigger kills the attachments at the same instant it
      // kills the messages. Called exactly once — resolveSharedTranscript is
      // deliberately NOT reused here, because it would re-run liveShare, a
      // second sessionsForViewer for the access label, a directory lookup and a
      // title scrub, none of which a download needs.
      const live = await liveShare(shareId);
      if (!live) return null;

      // Gate two: the id must be referenced by this share's own redacted
      // entries. Built from the payload we actually publish, so a file that was
      // redacted out of the transcript is not reachable through its id either.
      const allowed = new Set<string>();
      for (const entry of await publishedEntries(live.rec))
        for (const f of entry.files ?? []) allowed.add(f.artifactId);
      if (!allowed.has(artifactId)) return null;

      // Gate three: the sharer's own ACL check, unchanged and unbypassed. Never
      // the viewer's — a stranger has no scopes — and never a fresh reader.
      const opened = await files.openFileForViewer(artifactId, live.rec.sharerId);
      if (!opened) return null;

      // Downloads get their own row. Views alone would make bulk attachment
      // exfiltration through a link invisible in the log — the transcript poll
      // is deduped per hour, so pulling twenty files would show up as one read.
      const now = Date.now();
      await auditOnce(
        `share.download:${shareHandle(shareId)}:${viewer ?? "anon"}:${artifactId}:${Math.floor(now / 3_600_000)}`,
        {
          at: now,
          principalId: viewer ?? "anonymous",
          action: "session.share.download",
          resource: `session:${live.rec.sessionId}`,
          scopeLabel: live.rec.scopeId,
          detail: `${shareHandle(shareId)} ${artifactId}`,
        },
      );
      return { name: opened.name, sizeBytes: opened.sizeBytes, stream: opened.stream };
    },
  };
}
