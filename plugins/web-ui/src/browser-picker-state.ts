/**
 * DOM-free decisions for the browser picker.
 *
 * One card holds every browser a person can use, so the interesting questions
 * are which tab is showing, which one is live, and what the button on each tab
 * should offer. Getting that wrong is quiet and expensive: a tab that says
 * "In use" when it is not sends someone to a browser they are not paying for,
 * and a Connect button on an already-connected provider invites a second paste
 * of a key they already gave.
 */
import { BRAND } from "../../chassis/src/brand.ts";

export const BUILT_IN_BROWSER_ID = "built-in";
export const EXTENSION_BROWSER_ID = "extension";

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
  /** True for the browser turns actually use right now. */
  active: boolean;
  /** False only for a hosted provider with no key yet. */
  connected: boolean;
}

const BUILT_IN: BrowserProvider = {
  id: BUILT_IN_BROWSER_ID,
  name: "Built-in",
  summary: `The browser ${BRAND.productName} runs inside your sandbox. No key, no per-hour cost, and sign-ins persist between sessions. Some sites refuse it.`,
  keyEnv: "",
  keyService: "",
  connected: true,
};

/** Built-in first, then the catalog in the order core sent it. */
export function browserTabs(providers: readonly BrowserProvider[], activeId: string): BrowserTab[] {
  return [BUILT_IN, ...providers].map((provider) => ({
    id: provider.id,
    name: provider.name,
    active: provider.id === activeId,
    // The built-in browser needs nothing to be usable, so it is always ready.
    connected: provider.id === BUILT_IN_BROWSER_ID ? true : Boolean(provider.connected),
  }));
}

export function browserById(providers: readonly BrowserProvider[], id: string): BrowserProvider {
  return [BUILT_IN, ...providers].find((provider) => provider.id === id) ?? BUILT_IN;
}

/**
 * Which tab to show when the card first paints.
 *
 * The live one, so the card answers "what am I using?" before it answers
 * anything else.
 */
export function initialBrowserTab(providers: readonly BrowserProvider[], activeId: string): string {
  return browserTabs(providers, activeId).some((tab) => tab.id === activeId) ? activeId : BUILT_IN_BROWSER_ID;
}

export type BrowserAction = { kind: "in-use" } | { kind: "use"; label: string } | { kind: "connect"; label: string };

/** What the primary button on a tab should do. */
export function browserAction(tab: BrowserTab): BrowserAction {
  if (tab.active) return { kind: "in-use" };
  // The extension is paired, not key-dropped: "connected" is a live socket, and
  // there is a token to reveal rather than a secret to paste. Even when it is
  // not attached right now, the person can still select it and pair later.
  if (tab.id === EXTENSION_BROWSER_ID) return { kind: "use", label: "Use my Chrome" };
  if (!tab.connected) return { kind: "connect", label: `Connect ${tab.name}` };
  return { kind: "use", label: `Use ${tab.name}` };
}

/** True for the one tab that pairs an extension rather than storing a key. */
export function isExtensionTab(id: string): boolean {
  return id === EXTENSION_BROWSER_ID;
}

export interface DropDraft {
  service: string;
  purpose: string;
  envKey?: string;
  fields?: Array<{ key: string; label: string; secret: boolean }>;
}

/**
 * The one-time page for a provider, pre-filled.
 *
 * The point of the card is that nobody has to know a provider wants service
 * `anchor` and env `ANCHOR_API_KEY` plus a second record for its profile. A
 * provider that keeps a profile gets both fields in a single paste, because
 * sending someone back for a second one is how the second one never happens.
 */
export function connectDraft(provider: BrowserProvider): DropDraft | null {
  if (provider.id === BUILT_IN_BROWSER_ID || !provider.keyService) return null;
  // The key and nothing else. A provider that keeps a profile still needs one,
  // but its name is a detail of that provider rather than a decision anybody
  // wants to make, so core names it on save.
  return {
    service: provider.keyService,
    purpose: `Browse the web with ${provider.name} when a site refuses the built-in browser`,
    envKey: provider.keyEnv,
    fields: [{ key: provider.keyEnv, label: `${provider.name} API key`, secret: true }],
  };
}

/**
 * What the card says under the tab strip.
 *
 * Naming the cost is the point: hosted browsers bill per hour and the built-in
 * one does not, and that is the whole reason someone opens this card.
 */
export function browserSummary(provider: BrowserProvider, tab: BrowserTab): string {
  if (tab.active) return provider.summary;
  if (!tab.connected) return `${provider.summary} Connect it to switch.`;
  return provider.summary;
}
