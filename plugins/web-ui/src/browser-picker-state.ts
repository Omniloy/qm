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
  browsers?: BridgeBrowser[];
}

export interface BridgeBrowser {
  id: string;
  name: string;
  version?: string;
  connected: boolean;
  active: boolean;
  sharing: boolean;
  title?: string;
  lastSeenAt?: number;
}

export type ExtensionState =
  { kind: "absent" } | { kind: "unchosen" } | { kind: "offline" } | { kind: "idle" } | { kind: "sharing"; tab: string };

export function extensionState(provider: BrowserProvider): ExtensionState {
  if (!provider.connected) {
    const browsers = provider.browsers ?? [];
    if (browsers.some((b) => b.active)) return { kind: "offline" };
    return browsers.some((b) => b.connected) ? { kind: "unchosen" } : { kind: "absent" };
  }
  if (!provider.sharing) return { kind: "idle" };
  return { kind: "sharing", tab: provider.sharedTabTitle ?? "a tab" };
}

export function extensionLabel(state: ExtensionState): string {
  if (state.kind === "sharing") return "In use";
  if (state.kind === "unchosen") return "No browser chosen";
  if (state.kind === "offline") return "Offline";
  return state.kind === "idle" ? "Ready" : "Not connected";
}

export function extensionNote(state: ExtensionState): { tone: "ok" | "warning" | "neutral"; text: string } {
  if (state.kind === "sharing") return { tone: "ok", text: `${state.tab} — the agent is working in that tab as you.` };
  if (state.kind === "idle") {
    return {
      tone: "ok",
      text: "Connected — the agent opens a tab when it needs one, and can use any tab you have open.",
    };
  }
  if (state.kind === "offline") {
    return { tone: "warning", text: "The browser the agent uses is offline. Open it, or pick another below." };
  }
  if (state.kind === "unchosen") {
    return { tone: "warning", text: "Your browsers are connected, but none is active for the agent. Pick one below." };
  }
  return { tone: "neutral", text: "Install the extension, then paste the pairing token into it." };
}

export interface BridgeBrowserRow {
  id: string;
  name: string;
  status: string;
  active: boolean;
  canUse: boolean;
  canForget: boolean;
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function presenceOf(b: BridgeBrowser, now: number): string {
  if (b.connected) return b.sharing && b.title ? `Connected · working in ${b.title}` : "Connected";
  return b.lastSeenAt ? `Offline · last seen ${ago(b.lastSeenAt, now)}` : "Offline";
}

export function bridgeBrowserRows(browsers: readonly BridgeBrowser[], now = Date.now()): BridgeBrowserRow[] {
  return browsers.map((b) => {
    const presence = presenceOf(b, now);
    return {
      id: b.id,
      name: b.version ? `${b.name} · ${b.version}` : b.name,
      status: `${b.active ? "Active" : "Inactive"} · ${presence}`,
      active: b.active,
      canUse: !b.active,
      canForget: !b.connected,
    };
  });
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
