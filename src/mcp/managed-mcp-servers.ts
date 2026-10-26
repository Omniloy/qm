import type { McpServer } from "./mcp-server-store.ts";

export interface ManagedMcpServers {
  ids: ReadonlySet<string>;
  list(): Promise<McpServer[]>;
}

export const NO_MANAGED_MCP_SERVERS: ManagedMcpServers = { ids: new Set(), list: async () => [] };

export function managedMcpServers(opts: {
  ms365McpUrl?: string | undefined;
  providerConfigured: (provider: string) => Promise<boolean>;
}): ManagedMcpServers {
  const { ms365McpUrl, providerConfigured } = opts;
  if (!ms365McpUrl) return NO_MANAGED_MCP_SERVERS;
  return {
    ids: new Set(["microsoft-365"]),
    list: async () =>
      (await providerConfigured("microsoft"))
        ? [
            {
              id: "microsoft-365",
              name: "Microsoft 365",
              url: ms365McpUrl,
              auth: "none",
              credentialScope: "per-user",
              credentialHost: "graph.microsoft.com",
              credentialAccountType: "default",
              toolMode: "discovery",
              readOnly: false,
              enabled: true,
              managed: true,
              updatedAt: 0,
              updatedBy: "deployment",
            },
          ]
        : [],
  };
}
