import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { json, sendBuffered } from "../../chassis/src/http.ts";
import { MODEL_PROXY_PREFIX, type ModelFile } from "../src/voice-assistant/protocol.ts";

interface VoiceCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: string;
}

type VoiceRoute = { handle: (c: VoiceCtx) => unknown } & (
  { method: string; path: string } | { match: (method: string, pathname: string) => boolean }
);

export interface ModelUpstream {
  origin: string;
  allowRedirect: (target: URL) => boolean;
}

export interface VoiceAssistantDeps {
  models: ReadonlyMap<string, ModelFile>;
  coreFetch: (method: "GET", pathWithQuery: string) => Promise<{ status: number; text: string }>;
  coreStream: (method: "POST", path: string, rawBody: string, signal: AbortSignal) => Promise<Response>;
  readJson: (req: IncomingMessage, res: ServerResponse) => Promise<object | null>;
  modelUpstream?: ModelUpstream;
  hfToken?: string;
  localModelDir?: string;
}

const MAX_MODEL_REDIRECTS = 5;
const MODEL_CACHE_CONTROL = "public, max-age=31536000, immutable";
const GATED_MODEL_CACHE_CONTROL = "private, max-age=31536000, immutable";
const FORWARDED_MODEL_HEADERS = ["content-length", "content-range", "accept-ranges", "etag"] as const;

export function isModelHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ["huggingface.co", "hf.co"].some((root) => host === root || host.endsWith(`.${root}`));
}

export const HUGGING_FACE_UPSTREAM: ModelUpstream = {
  origin: "https://huggingface.co",
  allowRedirect: (target) => target.protocol === "https:" && target.port === "" && isModelHost(target.hostname),
};

export function voiceAccessPath(user: string): string {
  return `/v1/voice/access?principalId=${encodeURIComponent(user)}`;
}

function voiceTranscriptPath(user: string): string {
  return `/v1/voice/transcript?principalId=${encodeURIComponent(user)}`;
}

const VOICE_TRANSCRIPT_PATH = "/v1/voice/transcript";
const VOICE_ACTIVITY_PATH = "/v1/voice/transcript/activity";

export function modelUpstreamUrl(file: ModelFile, origin: string): URL {
  const segments = (parts: string) => parts.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `${origin}/${segments(file.repo)}/resolve/${encodeURIComponent(file.revision)}/${segments(file.path)}`,
  );
}

function relayText(res: ServerResponse, status: number, text: string): void {
  sendBuffered(res, status, { "content-type": "application/json", "x-content-type-options": "nosniff" }, text);
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hfToken(deps: VoiceAssistantDeps): string | undefined {
  return deps.hfToken?.trim() || undefined;
}

function gatedModelsServable(deps: VoiceAssistantDeps): boolean {
  return Boolean(hfToken(deps) || deps.localModelDir);
}

async function relayAccess(c: VoiceCtx, deps: VoiceAssistantDeps): Promise<void> {
  const r = await deps.coreFetch("GET", voiceAccessPath(c.user));
  const access = r.status === 200 ? jsonObject(r.text) : null;
  relayText(c.res, r.status, access ? JSON.stringify({ ...access, gatedModels: gatedModelsServable(deps) }) : r.text);
}

async function relayTranscript(c: VoiceCtx, deps: VoiceAssistantDeps): Promise<void> {
  const r = await deps.coreFetch("GET", voiceTranscriptPath(c.user));
  relayText(c.res, r.status, r.text);
}

async function relayTranscriptPost(
  c: VoiceCtx,
  deps: VoiceAssistantDeps,
  path: string,
  fields: readonly string[],
): Promise<void> {
  const body = await deps.readJson(c.req, c.res);
  if (!body) return;
  if (Array.isArray(body)) return json(c.res, 400, { error: "bad_request" });
  const picked = Object.fromEntries(fields.map((field) => [field, (body as Record<string, unknown>)[field]]));
  const controller = abortOnClose(c.res);
  try {
    const upstream = await deps.coreStream(
      "POST",
      path,
      JSON.stringify({ ...picked, principalId: c.user }),
      controller.signal,
    );
    const text = await upstream.text();
    if (!controller.signal.aborted)
      relayText(c.res, upstream.status, jsonObject(text) ? text : JSON.stringify({ error: "upstream_error" }));
  } catch {
    if (!controller.signal.aborted) json(c.res, 502, { error: "upstream_error" });
  }
}

function pipeBody(body: ReadableStream<Uint8Array>, res: ServerResponse): void {
  const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  res.on("close", () => source.destroy());
  source.on("error", () => res.destroy());
  source.pipe(res);
}

function abortOnClose(res: ServerResponse): AbortController {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  return controller;
}

async function fetchModelUpstream(
  start: URL,
  range: string | undefined,
  token: string | undefined,
  upstream: ModelUpstream,
  signal: AbortSignal,
): Promise<Response | null> {
  let target = start;
  for (let hop = 0; hop <= MAX_MODEL_REDIRECTS; hop++) {
    const authorized = token !== undefined && hop === 0 && target.origin === upstream.origin;
    const response = await fetch(target, {
      headers: {
        "accept-encoding": "identity",
        ...(range ? { range } : {}),
        ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: "manual",
      signal,
    });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) return null;
    const next = new URL(location, target);
    if (!upstream.allowRedirect(next)) return null;
    target = next;
  }
  return null;
}

function modelHeaders(file: ModelFile): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    "cache-control": file.gated ? GATED_MODEL_CACHE_CONTROL : MODEL_CACHE_CONTROL,
    "x-content-type-options": "nosniff",
  };
}

async function serveLocalModel(res: ServerResponse, file: ModelFile, dir: string): Promise<boolean> {
  const path = join(dir, file.repo, file.revision, file.path);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== file.bytes) return false;
  res.writeHead(200, { ...modelHeaders(file), "content-length": String(info.size) });
  const source = createReadStream(path);
  res.on("close", () => source.destroy());
  source.on("error", () => res.destroy());
  source.pipe(res);
  return true;
}

async function serveModel(c: VoiceCtx, deps: VoiceAssistantDeps): Promise<void> {
  const { req, res, url } = c;
  const file = deps.models.get(url.pathname.slice(MODEL_PROXY_PREFIX.length));
  if (!file) return json(res, 404, { error: "not_found" });
  if (deps.localModelDir && (await serveLocalModel(res, file, deps.localModelDir))) return;
  const token = file.gated ? hfToken(deps) : undefined;
  if (file.gated && !token) {
    return json(res, 503, {
      error: "model_unavailable",
      message: "This voice model is gated and the server has no HF_TOKEN configured.",
    });
  }
  const upstream = deps.modelUpstream ?? HUGGING_FACE_UPSTREAM;
  const rawRange = req.headers.range;
  const range = /^bytes=\d*-\d*$/.test(rawRange ?? "") ? rawRange : undefined;
  const controller = abortOnClose(res);
  try {
    const response = await fetchModelUpstream(
      modelUpstreamUrl(file, upstream.origin),
      range,
      token,
      upstream,
      controller.signal,
    );
    if (controller.signal.aborted) {
      await response?.body?.cancel();
      return;
    }
    const encoded = (response?.headers.get("content-encoding") ?? "identity") !== "identity";
    const length = response?.headers.get("content-length") ?? null;
    const sizeMismatch = response?.status === 200 && length !== null && Number(length) !== file.bytes;
    if (response?.status === 416) {
      await response.body?.cancel();
      res.writeHead(416, {
        "content-range": response.headers.get("content-range") ?? `bytes */${file.bytes}`,
        "cache-control": "no-store",
      });
      return void res.end();
    }
    if (
      !response ||
      !response.body ||
      (response.status !== 200 && response.status !== 206) ||
      encoded ||
      sizeMismatch
    ) {
      await response?.body?.cancel();
      return json(res, 502, { error: "upstream_error" });
    }
    const headers = modelHeaders(file);
    for (const name of FORWARDED_MODEL_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(response.status, headers);
    pipeBody(response.body, res);
  } catch {
    if (controller.signal.aborted) return;
    if (res.headersSent) res.destroy();
    else json(res, 502, { error: "upstream_error" });
  }
}

async function relayReply(c: VoiceCtx, deps: VoiceAssistantDeps): Promise<void> {
  const { req, res, user } = c;
  const body = await deps.readJson(req, res);
  if (!body) return;
  if (Array.isArray(body)) return json(res, 400, { error: "bad_request" });
  const controller = abortOnClose(res);
  try {
    const upstream = await deps.coreStream(
      "POST",
      "/v1/voice/reply",
      JSON.stringify({ ...body, principalId: user }),
      controller.signal,
    );
    if (controller.signal.aborted) {
      await upstream.body?.cancel();
      return;
    }
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return relayText(
        res,
        upstream.ok ? 502 : upstream.status,
        jsonObject(text) ? text : JSON.stringify({ error: "upstream_error" }),
      );
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    pipeBody(upstream.body, res);
  } catch {
    if (controller.signal.aborted) return;
    if (res.headersSent) res.destroy();
    else json(res, 502, { error: "stream_unavailable" });
  }
}

export function voiceAssistantRoutes(deps: VoiceAssistantDeps): VoiceRoute[] {
  return [
    {
      method: "GET",
      path: "/api/voice/access",
      handle: (c) => relayAccess(c, deps),
    },
    {
      method: "GET",
      path: "/api/voice/transcript",
      handle: (c) => relayTranscript(c, deps),
    },
    {
      method: "POST",
      path: "/api/voice/transcript",
      handle: (c) => relayTranscriptPost(c, deps, VOICE_TRANSCRIPT_PATH, ["entries"]),
    },
    {
      method: "POST",
      path: "/api/voice/transcript/activity",
      handle: (c) => relayTranscriptPost(c, deps, VOICE_ACTIVITY_PATH, ["entryId", "activity"]),
    },
    {
      method: "POST",
      path: "/api/voice/reply",
      handle: (c) => relayReply(c, deps),
    },
    {
      match: (method, pathname) => method === "GET" && pathname.startsWith(MODEL_PROXY_PREFIX),
      handle: (c) => serveModel(c, deps),
    },
  ];
}
