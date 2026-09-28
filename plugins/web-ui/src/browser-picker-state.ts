const EXTENSION_BROWSER_ID = "extension";

export interface BrowserProvider {
  id: string;
  name: string;
  summary: string;
  keyEnv: string;
  keyService: string;
  profileEnv?: string;
  profileService?: string;
  signupUrl?: string;
  connected?: boolean;
  sharing?: boolean;
  sharedTabTitle?: string;
}

export type ExtensionState = { kind: "absent" } | { kind: "idle" } | { kind: "sharing"; tab: string };

export function extensionState(provider: BrowserProvider): ExtensionState {
  if (!provider.connected) return { kind: "absent" };
  if (!provider.sharing) return { kind: "idle" };
  return { kind: "sharing", tab: provider.sharedTabTitle ?? "a tab" };
}

export function extensionLabel(state: ExtensionState): string {
  if (state.kind === "sharing") return "Sharing";
  return state.kind === "idle" ? "No tab shared" : "Not connected";
}

export function extensionNote(state: ExtensionState): { tone: "ok" | "warning" | "neutral"; text: string } {
  if (state.kind === "sharing") return { tone: "ok", text: `${state.tab} — the agent can act on that tab as you.` };
  if (state.kind === "idle") {
    return {
      tone: "warning",
      text: "The extension is connected, but no tab is shared — open it and press Share this tab.",
    };
  }
  return { tone: "neutral", text: "Install the extension, then paste the pairing token into it." };
}

export interface BrowserTab {
  id: string;
  name: string;
  active: boolean;
  connected: boolean;
}

export function browserTabs(providers: readonly BrowserProvider[], activeId: string | null): BrowserTab[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    active: provider.id === activeId,
    connected: Boolean(provider.connected),
  }));
}

export function browserById(providers: readonly BrowserProvider[], id: string): BrowserProvider | undefined {
  return providers.find((provider) => provider.id === id);
}

export function initialBrowserTab(providers: readonly BrowserProvider[], activeId: string | null): string | null {
  const tabs = browserTabs(providers, activeId);
  if (activeId && tabs.some((tab) => tab.id === activeId)) return activeId;
  return tabs[0]?.id ?? null;
}

export type BrowserAction = { kind: "in-use" } | { kind: "use"; label: string } | { kind: "connect"; label: string };

export function browserAction(tab: BrowserTab): BrowserAction {
  if (tab.active) return { kind: "in-use" };
  if (tab.id === EXTENSION_BROWSER_ID) return { kind: "use", label: "Use my Chrome" };
  if (!tab.connected) return { kind: "connect", label: `Connect ${tab.name}` };
  return { kind: "use", label: `Use ${tab.name}` };
}

export function isExtensionTab(id: string): boolean {
  return id === EXTENSION_BROWSER_ID;
}

export interface DropDraft {
  service: string;
  purpose: string;
  envKey?: string;
  fields?: Array<{ key: string; label: string; secret: boolean }>;
}

export function connectDraft(provider: BrowserProvider | undefined): DropDraft | null {
  if (!provider || !provider.keyService) return null;
  return {
    service: provider.keyService,
    purpose: `Browse the web with ${provider.name}`,
    envKey: provider.keyEnv,
    fields: [{ key: provider.keyEnv, label: `${provider.name} API key`, secret: true }],
  };
}

export function browserSummary(provider: BrowserProvider, tab: BrowserTab): string {
  if (tab.active) return provider.summary;
  if (!tab.connected) return `${provider.summary} Connect it to switch.`;
  return provider.summary;
}
