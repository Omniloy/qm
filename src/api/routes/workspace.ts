import { sendJson } from "../http.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { parseScopeId, type ScopeId } from "../../types.ts";

function viewerOf(ctx: ApiCtx): string | null {
  return ctx.capability?.actorId ?? ctx.actor?.p ?? null;
}

function scopeParam(ctx: ApiCtx): ScopeId | null {
  const raw = ctx.url.searchParams.get("scope");
  if (!raw) return null;
  return parseScopeId(raw as ScopeId).kind === null ? null : (raw as ScopeId);
}

async function getWorkspaceTree(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const viewer = viewerOf(ctx);
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const scope = scopeParam(ctx);
  if (!scope) return sendJson(res, 400, { error: "bad_request", message: "a valid scope is required" });
  const result = await app.workspaceTreeForViewer(viewer, scope, { wake: url.searchParams.get("wake") === "true" });
  if (result === "unavailable") {
    return sendJson(res, 501, { error: "not_configured", message: "no agent computer is wired on this instance" });
  }
  if (result === "forbidden") {
    return sendJson(res, 403, { error: "forbidden", message: "you can only browse contexts you can act in" });
  }
  if (result === "not_loaded") return sendJson(res, 200, { scopeId: scope, paths: [], loaded: false });
  return sendJson(res, 200, { ...result, loaded: true });
}

async function getWorkspaceFile(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const viewer = viewerOf(ctx);
  if (!viewer) return sendJson(res, 401, { error: "capability_required" });
  const scope = scopeParam(ctx);
  const path = url.searchParams.get("path");
  if (!scope || !path) return sendJson(res, 400, { error: "bad_request", message: "scope and path are required" });
  const opened = await app.openWorkspaceFileForViewer(viewer, scope, path);
  if (opened === "unavailable") {
    return sendJson(res, 501, { error: "not_configured", message: "no agent computer is wired on this instance" });
  }
  if (opened === "forbidden") {
    return sendJson(res, 403, { error: "forbidden", message: "you can only browse contexts you can act in" });
  }
  if (opened === "too_large") {
    return sendJson(res, 413, {
      error: "payload_too_large",
      message: "this file is too large to open here — ask the agent to summarize or split it",
    });
  }
  if (opened === "not_found") return sendJson(res, 404, { error: "not_found" });
  res.writeHead(200, {
    "content-type": opened.mimetype || "application/octet-stream",
    "content-length": String(opened.bytes.byteLength),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(opened.name)}`,
  });
  res.end(Buffer.from(opened.bytes));
  return;
}

export const workspaceRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/workspace/tree", auth: "either", handle: getWorkspaceTree },
  { method: "GET", path: "/v1/workspace/file", auth: "either", handle: getWorkspaceFile },
];
