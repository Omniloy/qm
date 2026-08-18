import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createSessionShareStore, type SessionShareRecord } from "../src/sessions/session-share.ts";
import { createShareMethods, type ShareMethods } from "../src/api/app-shares.ts";
import { shareRoutes, shareRateKeysHeld } from "../src/api/routes/shares.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import { findRoute, run, type ApiCtx } from "../src/api/routes/route.ts";
import { isUserScoped, userScopedField } from "../src/api/user-scoped-routes.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { scopeId, type ScopeId, type Session } from "../src/types.ts";

/**
 * Authorization for public share links, exercised through the routes.
 *
 * The rig below is deliberately real where it matters — a real session store
 * with real participant windows, the real redaction module, the real share
 * store — and stubbed only at the edges (directory, file bytes). Everything
 * asserted here is a property of core, because core is the only place allowed
 * to decide any of it.
 */

const SCOPE: ScopeId = scopeId("personal", "alice");
const OTHER_SCOPE: ScopeId = scopeId("group", "project:zeta");

class FakeRes extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  private chunks: Buffer[] = [];

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.headersSent = true;
    return this;
  }

  override _write(chunk: Buffer | string, _enc: unknown, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk as Buffer));
    cb();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.text()) as Record<string, unknown>;
  }
}

interface Rig {
  sessions: SessionStore;
  shares: ShareMethods;
  /** The raw store, so a test can plant a row the mint path would never produce. */
  shareStore: ReturnType<typeof createSessionShareStore>;
  identity: ReturnType<typeof createIdentityService>;
  /** Sessions each principal is a participant of, as the real helper would compute. */
  membership: Map<string, Set<string>>;
  /** Scopes each principal currently has access to — the mint-time check. */
  scopeAccess: Map<string, Set<ScopeId>>;
  /** Directory display names. Empty by default, which is the risky case. */
  displayNames: Map<string, string>;
  /** artifactId -> which principal may read it, and its bytes. */
  artifacts: Map<string, { name: string; body: string; readableBy: Set<string> }>;
  /** Every (artifactId, principalId) pair the file opener was asked for. */
  opens: Array<{ artifactId: string; principalId: string }>;
  /**
   * How many times each re-authorization step ran.
   *
   * `sessionsForViewer` is the expensive one — it is what `liveShare` and
   * `accessFor` both call — so counting it is how a request that quietly
   * re-resolves the whole share a second time becomes visible in a test rather
   * than only in a flame graph.
   */
  calls: { sessionsForViewer: number; directoryGet: number };
}

function rig(): Rig {
  const sessions = createMemorySessionStore();
  const identity = createIdentityService();
  const membership = new Map<string, Set<string>>();
  const scopeAccess = new Map<string, Set<ScopeId>>();
  const displayNames = new Map<string, string>();
  const artifacts = new Map<string, { name: string; body: string; readableBy: Set<string> }>();
  const opens: Array<{ artifactId: string; principalId: string }> = [];
  const calls = { sessionsForViewer: 0, directoryGet: 0 };

  const shareStore = createSessionShareStore(createMemoryMap<SessionShareRecord>());

  const shares = createShareMethods(
    {
      sessions,
      identity,
      directory: {
        get: async (principalId: string) => {
          calls.directoryGet += 1;
          const displayName = displayNames.get(principalId);
          return displayName ? { principalId, displayName, type: "internal" as const } : null;
        },
      },
      sessionShares: shareStore,
    },
    {
      // Stands in for AppHelpers.sessionsForViewer: participant rows, minus any
      // session whose project membership has lapsed.
      async sessionsForViewer(principalId: string): Promise<Session[]> {
        calls.sessionsForViewer += 1;
        const ids = membership.get(principalId) ?? new Set<string>();
        const all = await sessions.listByParticipant(principalId);
        return all.filter((s) => ids.has(s.id));
      },
      async principalCanAccessCurrentScope(principalId: string, targetScope: ScopeId): Promise<boolean> {
        return (scopeAccess.get(principalId) ?? new Set<ScopeId>()).has(targetScope);
      },
    },
    {
      async openFileForViewer(id: string, principalId: string) {
        opens.push({ artifactId: id, principalId });
        const art = artifacts.get(id);
        if (!art || !art.readableBy.has(principalId)) return null;
        return { name: art.name, sizeBytes: Buffer.byteLength(art.body), stream: Readable.from([art.body]) };
      },
    },
  );

  return { sessions, shares, shareStore, identity, membership, scopeAccess, displayNames, artifacts, opens, calls };
}

/** Alice's private conversation, with a message, a reply, an attachment and dropped tool activity. */
async function seedConversation(r: Rig, opts: { scope?: ScopeId; thread?: string } = {}): Promise<string> {
  const scope = opts.scope ?? SCOPE;
  const thread = opts.thread ?? "web:alice:11111111-1111-4111-8111-111111111111";
  const session = await r.sessions.getOrCreateByThread(thread, "dm", scope, undefined, "web");
  await r.sessions.addParticipant(session.id, "alice");
  await r.sessions.updateTitle(session.id, "Quarterly rollout plan");
  const { lease } = await r.sessions.acquireLease(session.id);
  assert.ok(lease);
  await r.sessions.append(lease, { type: "user", payload: { text: "how do we roll this out?" }, scopeLabel: scope });
  await r.sessions.append(lease, {
    type: "tool_call",
    payload: { name: "execute", args: { command: "env" } },
    scopeLabel: scope,
  });
  await r.sessions.append(lease, {
    type: "assistant",
    payload: { text: "Start with the pilot team." },
    scopeLabel: scope,
  });
  await r.sessions.append(lease, {
    type: "user",
    payload: { text: "here is the deck", attachments: [{ name: "deck.pdf", artifactId: "art-deck" }] },
    scopeLabel: scope,
  });
  await r.sessions.releaseLease(lease);

  r.membership.set("alice", new Set([session.id]));
  r.scopeAccess.set("alice", new Set([scope]));
  r.artifacts.set("art-deck", { name: "deck.pdf", body: "PDF-BYTES", readableBy: new Set(["alice"]) });
  return session.id;
}

async function call(
  r: Rig,
  method: string,
  path: string,
  opts: { actor?: string | null; body?: unknown; deps?: Record<string, unknown> } = {},
): Promise<FakeRes> {
  const found = findRoute(shareRoutes, method, new URL(path, "http://core.local").pathname);
  assert.ok(found, `no share route matches ${method} ${path}`);
  const res = new FakeRes();
  const url = new URL(path, "http://core.local");
  const ctx = {
    req: {} as IncomingMessage,
    res: res as unknown as ServerResponse,
    app: r.shares,
    deps: { ...opts.deps },
    secret: undefined,
    auth: null,
    allowUnsignedSourceAuth: true,
    url,
    pathname: url.pathname,
    method,
    params: {},
    body: opts.body ?? {},
    capability: null,
    actor: opts.actor ? { p: opts.actor } : null,
  } as unknown as ApiCtx;
  await run(found.route, found.params, ctx);
  if (!res.writableEnded) await once(res, "finish");
  return res;
}

/** The same methods this rig builds, minus the share store — i.e. the flag turned off. */
function withoutShareStore(r: Rig): ShareMethods {
  return createShareMethods(
    { sessions: r.sessions, identity: r.identity, directory: { get: async () => null } },
    {
      async sessionsForViewer(principalId: string): Promise<Session[]> {
        const ids = r.membership.get(principalId) ?? new Set<string>();
        return (await r.sessions.listByParticipant(principalId)).filter((s) => ids.has(s.id));
      },
      async principalCanAccessCurrentScope(principalId: string, targetScope: ScopeId): Promise<boolean> {
        return (r.scopeAccess.get(principalId) ?? new Set<ScopeId>()).has(targetScope);
      },
    },
    {
      async openFileForViewer(id: string, principalId: string) {
        r.opens.push({ artifactId: id, principalId });
        return null;
      },
    },
  );
}

async function mint(r: Rig, sessionId: string, principalId = "alice"): Promise<string> {
  const res = await call(r, "POST", `/v1/sessions/${sessionId}/share`, {
    actor: principalId,
    body: { principalId },
  });
  assert.equal(res.status, 200, res.text());
  return String(res.json().shareId);
}

test("a stranger holding the link reads the conversation as anonymous", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  // No portal identity, no capability, no source-auth headers: exactly what an
  // anonymous browser sends.
  const res = await call(r, "GET", `/v1/shares/${shareId}`);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.access, "anonymous");
  assert.equal(body.title, "Quarterly rollout plan");
  const entries = body.entries as Array<{ role: string; text: string }>;
  assert.deepEqual(
    entries.map((e) => e.role),
    ["user", "assistant", "user"],
    "messages survive; the tool_call between them does not",
  );
  assert.equal(entries[0]!.text, "how do we roll this out?");
  assert.ok(!res.text().includes("env"), "tool activity is not in the payload at all");
});

test("the public response carries no threadRef, no scopeId and no principal id", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  for (const actor of [null, "alice", "bob"]) {
    if (actor === "bob") r.membership.set("bob", new Set());
    const res = await call(r, "GET", `/v1/shares/${shareId}`, { actor });
    assert.equal(res.status, 200);
    const raw = res.text();
    // The sharer has no directory display name here on purpose: that is the
    // fixture in which a `displayName || id` fallback would ship an email onto
    // an anonymous page, and a test written with a name would never catch it.
    assert.equal(res.json().sharerLabel, null);
    assert.ok(!raw.includes("alice"), `principal id leaked to viewer=${String(actor)}: ${raw}`);
    assert.ok(!raw.includes("web:"), "threadRef leaked");
    assert.ok(!raw.includes("personal:"), "scopeId leaked");
    assert.ok(!raw.includes(SCOPE), "scopeId leaked");
  }
});

test("access is computed by core from the portal identity alone, on one URL", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);
  r.membership.set("bob", new Set([sessionId]));
  await r.sessions.addParticipant(sessionId, "bob");
  r.membership.set("mallory", new Set());

  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).json().access, "anonymous");
  const member = (await call(r, "GET", `/v1/shares/${shareId}`, { actor: "bob" })).json();
  assert.equal(member.access, "member");
  assert.equal(member.sessionId, sessionId, "a member gets the id because they can already open it");
  const outsider = (await call(r, "GET", `/v1/shares/${shareId}`, { actor: "mallory" })).json();
  assert.equal(outsider.access, "outsider");
  assert.equal(outsider.sessionId, undefined, "an outsider never learns the session id");
});

test("a forged or edited share id is a 404, and so is a revoked one — byte for byte", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  const live = await call(r, "GET", `/v1/shares/${shareId}`);
  assert.equal(live.status, 200);

  const edited = shareId.slice(0, -1) + (shareId.endsWith("a") ? "b" : "a");
  const forged = await call(r, "GET", `/v1/shares/${edited}`);
  const invented = await call(r, "GET", "/v1/shares/00000000-0000-4000-8000-000000000000");

  const revokeRes = await call(r, "DELETE", `/v1/sessions/${sessionId}/share?principalId=alice`, { actor: "alice" });
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.json().turnedOff, 1);
  const revoked = await call(r, "GET", `/v1/shares/${shareId}`);

  for (const res of [forged, invented, revoked]) {
    assert.equal(res.status, 404);
    assert.equal(res.text(), JSON.stringify({ error: "not_found" }));
  }
  assert.equal(
    revoked.text(),
    invented.text(),
    "a revoked link and one that never existed must be indistinguishable, or the endpoint confirms which ids are real",
  );
});

test("public responses are uncacheable and vary on the identity that changes them", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  const ok = await call(r, "GET", `/v1/shares/${shareId}`);
  const missing = await call(r, "GET", "/v1/shares/nope");
  for (const res of [ok, missing]) {
    assert.equal(res.headers["cache-control"], "no-store", "a cached 200 would outlive Unshare");
    assert.equal(res.headers["vary"], "x-portal-identity", "the member body must not be served to an anonymous holder");
  }

  const file = await call(r, "GET", `/v1/shares/${shareId}/files/art-deck`);
  assert.equal(file.status, 200);
  assert.equal(file.headers["cache-control"], "no-store");
  assert.equal(file.headers["vary"], "x-portal-identity");
});

test("an attachment downloads for a link holder, forced to download and never as script", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  const res = await call(r, "GET", `/v1/shares/${shareId}/files/art-deck`);
  assert.equal(res.status, 200);
  assert.equal(res.text(), "PDF-BYTES");
  assert.equal(
    res.headers["content-type"],
    "application/octet-stream",
    "an attachment named x.js must never come back as text/javascript from the app origin",
  );
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.ok(res.headers["content-disposition"]?.startsWith("attachment;"));
  assert.deepEqual(
    r.opens,
    [{ artifactId: "art-deck", principalId: "alice" }],
    "opened as the sharer, never as the viewer",
  );
});

test("a file the share does not reference is a 404 even with a valid link", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  // A real artifact, readable by the sharer, simply not referenced by any entry
  // this share publishes. Gate two must refuse it on its own.
  r.artifacts.set("art-elsewhere", { name: "payroll.csv", body: "SECRET", readableBy: new Set(["alice"]) });

  const res = await call(r, "GET", `/v1/shares/${shareId}/files/art-elsewhere`);
  assert.equal(res.status, 404);
  assert.equal(res.text(), JSON.stringify({ error: "not_found" }));
  assert.deepEqual(r.opens, [], "the file reader is never even reached for an unreferenced id");
});

test("an attachment the sharer personally cannot read is a 404, proving the two gates are independent", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);
  // Referenced by the transcript (gate two passes) but not readable by the
  // sharer (gate three refuses).
  r.artifacts.set("art-deck", { name: "deck.pdf", body: "PDF-BYTES", readableBy: new Set(["carol"]) });

  const res = await call(r, "GET", `/v1/shares/${shareId}/files/art-deck`);
  assert.equal(res.status, 404);
  assert.deepEqual(r.opens, [{ artifactId: "art-deck", principalId: "alice" }]);
});

test("revoking the share kills the attachment route on the very next request", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}/files/art-deck`)).status, 200);

  await call(r, "DELETE", `/v1/sessions/${sessionId}/share?principalId=alice`, { actor: "alice" });
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}/files/art-deck`)).status, 404);
});

test("minting needs the read predicate AND current scope access, so it is strictly stricter than reading", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);

  // A non-participant does not learn the conversation exists.
  r.membership.set("mallory", new Set());
  r.scopeAccess.set("mallory", new Set([SCOPE]));
  const stranger = await call(r, "POST", `/v1/sessions/${sessionId}/share`, {
    actor: "mallory",
    body: { principalId: "mallory" },
  });
  assert.equal(stranger.status, 404);

  // A stale participant whose scope membership lapsed can still read the
  // conversation, but may no longer publish it.
  r.scopeAccess.set("alice", new Set());
  const lapsed = await call(r, "POST", `/v1/sessions/${sessionId}/share`, {
    actor: "alice",
    body: { principalId: "alice" },
  });
  assert.equal(lapsed.status, 403);
  assert.ok(String(lapsed.json().message).includes("member of this project"));
  assert.ok((await r.shares.listSessionShares(sessionId, "alice")) !== null, "reading is unaffected");
});

test("a link dies the moment the sharer stops being an internal principal", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).status, 200);

  await r.identity.deactivate("alice");
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).status, 404, "no restart, no cache flush");
});

test("a link dies when the sharer loses the session, or the session moves scope", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  // Trigger: the sharer is no longer entitled (removed from the participant
  // list, or from the project whose membership governs the scope).
  r.membership.set("alice", new Set());
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).status, 404);
  r.membership.set("alice", new Set([sessionId]));
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).status, 200);

  // Trigger: the conversation now belongs to a different audience than the one
  // the sharer published from. Planted directly, because the record's scope is
  // captured at mint time and only a later move can make the two disagree.
  const drifted = await r.shareStore.mint({ sessionId, scopeId: OTHER_SCOPE, sharerId: "alice" });
  assert.equal(
    (await call(r, "GET", `/v1/shares/${drifted.shareId}`)).status,
    404,
    "consent was given for one audience and does not follow the conversation to another",
  );

  const moved = rig();
  const movedId = await seedConversation(moved, {
    scope: OTHER_SCOPE,
    thread: "web:alice:22222222-2222-4222-8222-222222222222",
  });
  moved.scopeAccess.set("alice", new Set([OTHER_SCOPE]));
  const movedShare = await mint(moved, movedId);
  assert.equal((await call(moved, "GET", `/v1/shares/${movedShare}`)).status, 200);
  await moved.sessions.deleteSession(movedId);
  assert.equal(
    (await call(moved, "GET", `/v1/shares/${movedShare}`)).status,
    404,
    "a deleted session takes its links with it",
  );
});

test("losing access to the scope kills the links already minted, not just future ones", async () => {
  const r = rig();
  const scope = scopeId("channel", "C7");
  const sessionId = await seedConversation(r, { scope, thread: "ch:C7:t1" });
  const shareId = await mint(r, sessionId);
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).status, 200);

  // Alice is removed from the private channel. Her participant row is untouched
  // — `sessionsForViewer` only drops sessions whose managed project membership
  // lapsed, and a channel is not a project — so the entitlement check still
  // passes and only re-running the mint-time scope predicate catches this.
  r.scopeAccess.set("alice", new Set());
  assert.ok(
    (await r.sessions.listByParticipant("alice")).some((s) => s.id === sessionId),
    "the fixture must keep the participant row, or it proves nothing about the scope check",
  );

  const read = await call(r, "GET", `/v1/shares/${shareId}`);
  assert.equal(read.status, 404, "eviction from the channel must end the publication, not only future publishing");
  assert.equal(read.text(), JSON.stringify({ error: "not_found" }));
  assert.equal(
    (await call(r, "GET", `/v1/shares/${shareId}/files/art-deck`)).status,
    404,
    "and the attachments go with it, in the same instant",
  );
  assert.equal(
    (await call(r, "POST", `/v1/sessions/${sessionId}/share`, { actor: "alice", body: { principalId: "alice" } }))
      .status,
    403,
    "resolving is now exactly as strict as minting, which was the point",
  );

  // Re-added, the link works again: this is a live check, not a latched one.
  r.scopeAccess.set("alice", new Set([scope]));
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).status, 200);
});

test("a link never reveals more than the sharer could see — the participant window is the boundary", async () => {
  const r = rig();
  const scope = scopeId("channel", "C1");
  const session = await r.sessions.getOrCreateByThread("ch:C1:t1", "channel", scope, undefined, "slack");
  const { lease } = await r.sessions.acquireLease(session.id);
  assert.ok(lease);

  await r.sessions.append(lease, { type: "user", payload: { text: "before anyone joined" }, scopeLabel: scope });
  await r.sessions.addParticipant(session.id, "alice");
  await r.sessions.append(lease, { type: "user", payload: { text: "while alice was here" }, scopeLabel: scope });
  await r.sessions.removeParticipant(session.id, "alice");
  await r.sessions.append(lease, { type: "user", payload: { text: "after alice left" }, scopeLabel: scope });
  await r.sessions.releaseLease(lease);

  r.membership.set("alice", new Set([session.id]));
  r.scopeAccess.set("alice", new Set([scope]));
  const shareId = await mint(r, session.id);

  const body = (await call(r, "GET", `/v1/shares/${shareId}`)).json();
  const texts = (body.entries as Array<{ text: string }>).map((e) => e.text);
  assert.deepEqual(texts, ["while alice was here"], "entries outside the sharer's window are absent");
});

test("management routes refuse an actor that does not match, and refuse an agent outright", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);

  const mismatched = await call(r, "POST", `/v1/sessions/${sessionId}/share`, {
    actor: "bob",
    body: { principalId: "alice" },
  });
  assert.equal(mismatched.status, 403);
  assert.equal(mismatched.json().message, "portal identity does not match the requested actor");

  // The gate already 403s a capability token on a source route; the handler
  // says so too, so an agent can never publish a conversation.
  const found = findRoute(shareRoutes, "POST", `/v1/sessions/${sessionId}/share`);
  assert.ok(found);
  const res = new FakeRes();
  const url = new URL(`http://core.local/v1/sessions/${sessionId}/share`);
  await run(found.route, found.params, {
    req: {} as IncomingMessage,
    res: res as unknown as ServerResponse,
    app: r.shares,
    deps: {},
    url,
    pathname: url.pathname,
    method: "POST",
    params: {},
    body: { principalId: "alice" },
    capability: { actorId: "alice", scopeId: SCOPE },
    actor: null,
  } as unknown as ApiCtx);
  assert.equal(res.status, 403);
  assert.equal(res.json().message, "capability token not valid for this route");

  // And with signed portal identity required, a bare query parameter is not an
  // assertion of anything — the fail-open a missing USER_SCOPED rule would leave.
  const unsigned = await call(r, "GET", `/v1/sessions/${sessionId}/share?principalId=alice`, {
    deps: { requireSignedPortalIdentity: true },
  });
  assert.equal(unsigned.status, 401);
});

test("the public routes are declared public, and the management routes are source-authenticated", () => {
  const byPath = new Map(
    shareRoutes.map((r) => [`${"method" in r ? r.method : "?"} ${"path" in r ? r.path : "?"}`, r.auth]),
  );
  assert.equal(byPath.get("GET /v1/shares/:shareId"), "public");
  assert.equal(byPath.get("GET /v1/shares/:shareId/files/:artifactId"), "public");
  assert.equal(byPath.get("POST /v1/sessions/:id/share"), "source");
  assert.equal(byPath.get("GET /v1/sessions/:id/share"), "source");
  assert.equal(byPath.get("DELETE /v1/sessions/:id/share"), "source");
});

test("the share routes are reachable in apiRoutes, and are not raw routes", () => {
  // Raw routes dispatch before gate(), and gate() is the only thing that parses
  // x-portal-identity into ctx.actor. A raw share route would still "work" —
  // it would just quietly answer "anonymous" to every logged-in colleague,
  // which is a failure no response code would reveal.
  const ours = new Set(shareRoutes.map((r) => r.handle));
  for (const [method, pathname] of [
    ["GET", "/v1/shares/sample"],
    ["GET", "/v1/shares/sample/files/sample"],
    ["POST", "/v1/sessions/s1/share"],
    ["GET", "/v1/sessions/s1/share"],
    ["DELETE", "/v1/sessions/s1/share"],
  ] as const) {
    const found = findRoute(apiRoutes, method, pathname);
    assert.ok(found, `${method} ${pathname} is not registered in apiRoutes`);
    // Not merely "some route answers": the table is ordered, and an earlier
    // `match:` route greedy enough to swallow /v1/sessions/:id/share would give
    // a plausible response from the wrong handler.
    assert.ok(ours.has(found.route.handle), `${method} ${pathname} is answered by a different route in the table`);
    assert.equal(findRoute(rawRoutes, method, pathname), null, `${method} ${pathname} must not be a raw route`);
  }
});

test("all three management routes carry a USER_SCOPED rule — a GET without one fails open", () => {
  // isUnclassifiedWrite only inspects writes, so the POST and DELETE have a
  // backstop and the GET has none. Asserted as three separate expectations so a
  // future edit that drops or mistypes exactly one of them is named by the
  // failure rather than hidden behind a loop.
  const expected = [
    ["POST", { in: "body", name: "principalId" }],
    ["GET", { in: "query", name: "principalId" }],
    ["DELETE", { in: "query", name: "principalId" }],
  ] as const;
  for (const [method, field] of expected) {
    const path = "/v1/sessions/2f0c/share";
    assert.ok(isUserScoped(method, path), `${method} ${path} has no USER_SCOPED rule, so it requires no identity`);
    assert.deepEqual(
      userScopedField(method, path),
      field,
      `${method} ${path} must bind the asserted actor, or the gate cannot compare it to the signed identity`,
    );
  }
});

test("management responses are no-store — the body hands back the bearer secret itself", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);

  const created = await call(r, "POST", `/v1/sessions/${sessionId}/share`, {
    actor: "alice",
    body: { principalId: "alice" },
  });
  const listed = await call(r, "GET", `/v1/sessions/${sessionId}/share?principalId=alice`, { actor: "alice" });
  const refused = await call(r, "GET", `/v1/sessions/${sessionId}/share?principalId=bob`, { actor: "alice" });
  const revoked = await call(r, "DELETE", `/v1/sessions/${sessionId}/share?principalId=alice`, { actor: "alice" });

  assert.equal(created.status, 200);
  assert.equal(listed.status, 200);
  assert.equal(refused.status, 403);
  assert.equal(revoked.status, 200);
  for (const res of [created, listed, refused, revoked]) {
    assert.equal(res.headers["cache-control"], "no-store", `a cache holding ${res.text()} would be holding a live key`);
    assert.equal(res.headers["vary"], "x-portal-identity");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  }
});

test("sharerLabel is null when the directory display name is an address, not just when it equals the id", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  // The realistic shape: a Slack principal id with a synced display name that
  // is an email. An equality check clears this and ships the address to every
  // stranger holding the link.
  r.displayNames.set("alice", "alice@acme.com");
  const shareId = await mint(r, sessionId);

  const body = (await call(r, "GET", `/v1/shares/${shareId}`)).json();
  assert.equal(body.sharerLabel, null);
  assert.ok(!(await call(r, "GET", `/v1/shares/${shareId}`)).text().includes("@acme.com"));

  // A real name still comes through — the rule must not silently blank every label.
  r.displayNames.set("alice", "Alice Nguyen");
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).json().sharerLabel, "Alice Nguyen");
});

test("sinceIndex trims the response to the tail and does not count as a new view", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  const cold = (await call(r, "GET", `/v1/shares/${shareId}`)).json();
  const all = cold.entries as Array<{ i: number; text: string }>;
  assert.equal(all.length, 3);

  // Inclusive of the cursor: the page sends the highest index it has painted.
  const tail = (await call(r, "GET", `/v1/shares/${shareId}?sinceIndex=2`)).json();
  assert.deepEqual(
    (tail.entries as Array<{ i: number }>).map((e) => e.i),
    [2],
    "a poll must ship the tail, not the whole transcript, and must keep the share-local index",
  );
  // Everything outside the entry list is still recomputed and still sent, so a
  // revocation or a title change lands on the very next poll.
  assert.equal(tail.title, cold.title);
  assert.equal(tail.access, "anonymous");

  // A garbled cursor degrades to a full load rather than to a wrong answer.
  assert.equal(((await call(r, "GET", `/v1/shares/${shareId}?sinceIndex=nope`)).json().entries as unknown[]).length, 3);

  const [row] = await r.shareStore.forSession(sessionId);
  assert.equal(
    row!.rec.viewCount,
    2,
    "the two cold loads counted; the polls did not — a tab left open all day is one reader, not 8,640",
  );
});

test("a full read is always counted, so the counter cannot be polled around", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  // `?sinceIndex=0` is a full read wearing a poll's clothes: it returns every
  // entry. Deciding "is this a view" from the cursor's presence let a reader
  // take the whole conversation as often as they liked without ever showing up
  // in the count — and with no expiry, that count is the only way the sharer
  // ever notices a link is being used.
  for (let i = 0; i < 3; i++) {
    const body = (await call(r, "GET", `/v1/shares/${shareId}?sinceIndex=0`)).json();
    assert.equal((body.entries as unknown[]).length, 3, "cursor 0 is inclusive, so it returns everything");
  }

  const [row] = await r.shareStore.forSession(sessionId);
  assert.equal(row!.rec.viewCount, 3, "every full read is a read");
});

test("a download re-authorizes exactly once and leaves an audit trail of its own", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  r.calls.sessionsForViewer = 0;
  r.calls.directoryGet = 0;
  const res = await call(r, "GET", `/v1/shares/${shareId}/files/art-deck`);
  assert.equal(res.status, 200);
  assert.equal(
    r.calls.sessionsForViewer,
    1,
    "one liveShare per download — resolving the whole transcript again to build the allowed-id set cost three",
  );
  assert.equal(r.calls.directoryGet, 0, "a download needs no display name, so it must not go and fetch one");
});

test("with PUBLIC_SHARE_LINKS off there is no store, so minting is 503 and every link is a 404", async () => {
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  // Exactly what wiring builds when the flag is false: the same methods over the
  // same session store, with `sessionShares` absent. The kill switch is the
  // missing store, not a flag threaded through the routes — so it cannot be
  // half-applied to the mint path and missed on the read path.
  const off = { ...r, shares: withoutShareStore(r) } as Rig;

  const minted = await call(off, "POST", `/v1/sessions/${sessionId}/share`, {
    actor: "alice",
    body: { principalId: "alice" },
  });
  assert.equal(minted.status, 503);
  assert.equal(minted.json().error, "not_configured");

  // And an id minted while it was on stops resolving the moment it is off,
  // with the same body a forged id gets.
  const read = await call(off, "GET", `/v1/shares/${shareId}`);
  assert.equal(read.status, 404);
  assert.equal(read.text(), JSON.stringify({ error: "not_found" }));
  assert.equal((await call(off, "GET", `/v1/shares/${shareId}/files/art-deck`)).status, 404);
  assert.deepEqual(off.opens, [], "with the feature off the file reader is never reached at all");
});

test("a flood of forged ids cannot grow the rate-limit table without bound", async () => {
  // Unauthenticated callers choose the keys, because the counter is consulted
  // before any lookup. Bounded with oldest-first eviction: an expired-only sweep
  // frees nothing inside a single window while scanning everything, which turned
  // a flood into quadratic CPU on core's event loop.
  const r = rig();
  const sessionId = await seedConversation(r);
  const shareId = await mint(r, sessionId);

  for (let i = 0; i < 25_000; i++) await call(r, "GET", `/v1/shares/forged-${i}`);
  assert.ok(
    shareRateKeysHeld() <= 10_000,
    `25,000 forged ids in one window left ${shareRateKeysHeld()} rate-limit keys held`,
  );

  // The honest link still works afterwards: eviction may cost a share its
  // window, never its access.
  assert.equal((await call(r, "GET", `/v1/shares/${shareId}`)).status, 200);
});
