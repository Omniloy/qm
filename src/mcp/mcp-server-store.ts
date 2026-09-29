// Registry of admin-configured MCP servers.
//
// Admin-only by design: registering a server points every scope's agents at
// an outbound HTTP endpoint, so end users must not be able to add one (SSRF
// and exfiltration surface). Secrets live in the record like other stored
// connector credentials — reachable only through core, never injected into sandboxes.

import type { DurableMap } from "../persistence/durable-map.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials" | "oauth";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  credentialScope?: "shared" | "per-user";
  credentialHost?: string;
  credentialAccountType?: "default" | "personal" | "company";
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  oauthScopes?: string[];
  iconUrl?: string;
  readOnly: boolean;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export function isValidMcpServerId(id: string): boolean {
  return ID_PATTERN.test(id);
}

const ICON_URL_MAX = 2048;
const ICON_URL_PATTERN = /^https:\/\/[^\s"'<>\\`]+$/;

export function parseMcpIconUrl(value: unknown): string | undefined | null {
  const text = typeof value === "string" ? value.trim() : value;
  if (text === undefined || text === null || text === "") return undefined;
  if (typeof text !== "string" || text.length > ICON_URL_MAX || !ICON_URL_PATTERN.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".") ? url.href : null;
  } catch {
    return null;
  }
}

export function mcpServerIcon(server: Pick<McpServer, "url" | "iconUrl">): string | undefined {
  if (server.iconUrl) return server.iconUrl;
  try {
    const url = new URL(server.url);
    if (url.protocol !== "https:" || !url.hostname.includes(".")) return undefined;
    const site = url.hostname.replace(/^mcp\./, "");
    return parseMcpIconUrl(`https://${site.includes(".") ? site : url.hostname}/favicon.ico`) ?? undefined;
  } catch {
    return undefined;
  }
}

export function singleLineName(value: string): string {
  return Array.from(value.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim())
    .slice(0, 80)
    .join("");
}

export interface McpServerStore {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer): Promise<void>;
  delete(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

export function createMcpServerStore(backing: DurableMap<McpServer>): McpServerStore {
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const clean = (server: McpServer): McpServer => ({ ...server, name: singleLineName(server.name) || server.id });
  return {
    async list() {
      const entries = await backing.entries();
      return entries.map(([, v]) => clean(v)).sort((a, b) => a.id.localeCompare(b.id));
    },
    get: async (id) => {
      const server = await backing.get(id);
      return server ? clean(server) : null;
    },
    put: async (server) => {
      await backing.put(server.id, clean(server));
      emit();
    },
    delete: async (id) => {
      await backing.delete(id);
      emit();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
