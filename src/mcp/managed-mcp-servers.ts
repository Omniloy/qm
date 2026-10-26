import type { McpServer } from "./mcp-server-store.ts";

export function managedMcpServers(opts: {
  ms365McpUrl?: string | undefined;
  providerConfigured: (provider: string) => Promise<boolean>;
}): () => Promise<McpServer[]> {
  const { ms365McpUrl, providerConfigured } = opts;
  if (!ms365McpUrl) return async () => [];
  return async () =>
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
      : [];
}
