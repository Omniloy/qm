import { sendJson } from "../http.ts";
import { type ApiCtx, type BaseCtx, type Route } from "./route.ts";
import { connectorRawRoutes, connectorRoutes } from "./connectors.ts";
import { deploymentRawRoutes, deploymentRoutes } from "./deployments.ts";
import { blobRoutes } from "./blobs.ts";
import { sessionStateRawRoutes } from "./session-state.ts";
import { turnRoutes } from "./turns.ts";
import { credentialRoutes } from "./credentials.ts";
import { brokerGitHttp, GIT_HTTP_BROKER_PREFIX } from "../git-http-broker.ts";
import { mountRoutes } from "./mounts.ts";
import { keychainRoutes } from "./keychain.ts";
import { secretDropRoutes } from "./secret-drop.ts";
import { shareRoutes } from "./shares.ts";
import { adminRoutes } from "./admin.ts";
import { skillPackRoutes } from "./skill-packs.ts";
import { surfaceRoutes } from "./surface.ts";
import { cronRoutes } from "./crons.ts";
import { reachRoutes } from "./reach.ts";
import { workspaceRoutes } from "./workspace.ts";
import { directoryRoutes } from "./directory.ts";
import { contextRoutes } from "./context.ts";
import { surfaceCacheRoutes } from "./surface-cache.ts";
import { environmentRoutes } from "./environments.ts";
import { emojiRoutes } from "./emoji.ts";
import { browserSessionRoutes } from "./browser-sessions.ts";
import { browserRelayRoutes } from "./browser-relay.ts";
import { projectRoutes } from "./projects.ts";
import { contextPolicyRoutes } from "./context-policy.ts";
import { deploymentLayerRoutes } from "./deployment-layer.ts";
import { egressAuditRoutes } from "./egress-audit.ts";
import { authBrokerRoutes } from "./auth-broker.ts";

export const rawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "GET", path: "/healthz", auth: "public", handle: ({ res }) => sendJson(res, 200, { ok: true }) },
  {
    match: (m, p) => (m === "GET" || m === "POST") && p.startsWith(GIT_HTTP_BROKER_PREFIX),
    auth: { aud: "credential-broker" },
    handle: brokerGitHttp,
  },
  { match: (_m, p) => p.startsWith(GIT_HTTP_BROKER_PREFIX), auth: { aud: "credential-broker" }, handle: brokerGitHttp },
  ...connectorRawRoutes,
  ...deploymentRawRoutes,
  ...blobRoutes,
  ...sessionStateRawRoutes,
];

export const apiRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...deploymentLayerRoutes,
  ...turnRoutes,
  ...credentialRoutes,
  ...keychainRoutes,
  ...mountRoutes,
  ...secretDropRoutes,
  // apiRoutes, never rawRoutes: raw routes dispatch before gate(), and gate() is
  // what parses x-portal-identity into ctx.actor even on a public route. Losing
  // that parse would collapse member and outsider into anonymous.
  ...shareRoutes,
  ...connectorRoutes,
  ...adminRoutes,
  ...skillPackRoutes,
  ...surfaceRoutes,
  ...projectRoutes,
  ...contextPolicyRoutes,
  ...cronRoutes,
  ...reachRoutes,
  ...workspaceRoutes,
  ...directoryRoutes,
  ...contextRoutes,
  ...surfaceCacheRoutes,
  ...environmentRoutes,
  ...emojiRoutes,
  ...browserSessionRoutes,
  ...browserRelayRoutes,
  ...deploymentRoutes,
  ...egressAuditRoutes,
  ...authBrokerRoutes,
];
