import { safeFetch, type McpOAuthNet } from "./mcp-oauth.ts";
import { parseMcpIconUrl } from "./mcp-server-store.ts";

const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_LINK_TAGS = 500;
const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const ICON_RELS = new Set(["icon", "apple-touch-icon", "apple-touch-icon-precomposed"]);

interface IconLink {
  href: string;
  rank: number;
}

function attributesOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(ATTRIBUTE)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, (m[2] ?? m[3] ?? m[4] ?? "").replace(/&amp;/gi, "&").trim());
  }
  return attrs;
}

function rankOf(attrs: Map<string, string>, rels: string[], path: string): number {
  const type = attrs.get("type")?.toLowerCase() ?? "";
  if (type === "image/svg+xml" || path.endsWith(".svg")) return 4;
  if (type.includes("icon") || path.endsWith(".ico")) return 2;
  const sizes = (attrs.get("sizes") ?? "").match(/\d+/g)?.map(Number) ?? [];
  const appleTouch = rels.some((r) => r.startsWith("apple-touch-icon"));
  return (sizes.length ? Math.max(...sizes) >= 32 : appleTouch) ? 3 : 1;
}

export function iconLinksFromHtml(page: string, pageUrl: string): string[] {
  const links: IconLink[] = [];
  for (const [tag] of [...page.matchAll(LINK_TAG)].slice(0, MAX_LINK_TAGS)) {
    const attrs = attributesOf(tag);
    const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attrs.get("href");
    if (!href || !rels.some((r) => ICON_RELS.has(r))) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      continue;
    }
    const safe = parseMcpIconUrl(resolved.href);
    if (safe) links.push({ href: safe, rank: rankOf(attrs, rels, resolved.pathname.toLowerCase()) });
  }
  return links.sort((a, b) => b.rank - a.rank).map((l) => l.href);
}

function homepagesOf(serverUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return [];
  }
  if (url.protocol !== "https:" || !url.hostname.includes(".")) return [];
  const stripped = url.hostname.replace(/^mcp\./, "");
  const site = stripped.includes(".") ? stripped : url.hostname;
  return [site, ...(site.startsWith("www.") ? [] : [`www.${site}`])].map((host) => `https://${host}/`);
}

async function confirmedImage(href: string, net: McpOAuthNet): Promise<string | undefined> {
  const res = await safeFetch(href, { method: "GET", headers: { accept: "image/*" }, truncateAt: 1 }, net, "icon");
  return res.ok && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/") ? href : undefined;
}

async function iconFromHomepage(homepage: string, net: McpOAuthNet): Promise<string | undefined> {
  const res = await safeFetch(
    homepage,
    { method: "GET", headers: { accept: "text/html" }, truncateAt: MAX_PAGE_BYTES },
    net,
    "site homepage",
  );
  if (!res.ok) return undefined;
  const [best] = iconLinksFromHtml(res.body, homepage);
  return best ?? confirmedImage(new URL("/favicon.ico", homepage).href, net);
}

export async function resolveMcpSiteIcon(serverUrl: string, net: McpOAuthNet): Promise<string | undefined> {
  const strict: McpOAuthNet = { ...net, allowLoopbackHttp: false };
  for (const homepage of homepagesOf(serverUrl)) {
    const icon = await iconFromHomepage(homepage, strict).catch(() => undefined);
    if (icon) return icon;
  }
  return undefined;
}
