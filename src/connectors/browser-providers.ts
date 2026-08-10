import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The hosted browsers a person can connect, read from the browse skill's own
 * provider docs.
 *
 * The catalog is deliberately not a list in core. The browse skill gains a
 * provider by dropping one markdown file beside the others, with no core or
 * deploy change, and that property is worth more than the few lines a hardcoded
 * list would save — so the doc carries its own front-matter and this reads it.
 */
export interface BrowserProviderSpec {
  id: string;
  name: string;
  summary: string;
  keyEnv: string;
  keyService: string;
  profileEnv?: string;
  profileService?: string;
  signupUrl?: string;
  homeUrl?: string;
}

/** The always-present option: the browser QM runs in the sandbox itself. */
export const BUILT_IN_BROWSER_ID = "built-in";

const REQUIRED = ["id", "name", "summary", "keyEnv", "keyService"] as const;

function parseFrontMatter(text: string): Record<string, string> | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const out: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function parseBrowserProviderDoc(text: string): BrowserProviderSpec | null {
  const fm = parseFrontMatter(text);
  if (!fm) return null;
  for (const field of REQUIRED) if (!fm[field]) return null;
  return {
    id: fm.id!,
    name: fm.name!,
    summary: fm.summary!,
    keyEnv: fm.keyEnv!,
    keyService: fm.keyService!,
    ...(fm.profileEnv ? { profileEnv: fm.profileEnv } : {}),
    ...(fm.profileService ? { profileService: fm.profileService } : {}),
    ...(fm.signupUrl ? { signupUrl: fm.signupUrl } : {}),
    ...(fm.homeUrl ? { homeUrl: fm.homeUrl } : {}),
  };
}

/**
 * Read every provider doc under the browse skill's `providers/` directory.
 *
 * A malformed or front-matterless doc is skipped rather than thrown: a provider
 * someone is midway through writing must not take the keychain page down with
 * it, and the page's whole job is to show what is connectable.
 */
export function loadBrowserProviders(skillsSeedDir: string): BrowserProviderSpec[] {
  const dir = join(skillsSeedDir, "browse", "providers");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const specs: BrowserProviderSpec[] = [];
  for (const name of names.sort()) {
    try {
      const spec = parseBrowserProviderDoc(readFileSync(join(dir, name), "utf8"));
      if (spec) specs.push(spec);
    } catch {
      // Unreadable file: skip this provider, keep the rest.
    }
  }
  return specs;
}

/** Every id the picker will accept, built-in first. */
export function browserProviderIds(specs: readonly BrowserProviderSpec[]): string[] {
  return [BUILT_IN_BROWSER_ID, ...specs.map((spec) => spec.id)];
}
