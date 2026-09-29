import { safeFetch, type McpOAuthNet } from "./mcp-oauth.ts";
import { parseMcpIconUrl } from "./mcp-server-store.ts";

const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_LINK_TAGS = 500;
const MAX_TAG_LENGTH = 2048;
const ATTRIBUTE = /\s+|([^\s"'=<>/]{1,64})(?:\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s"'=<>`]+)))?|[^]/gy;
const ICON_RELS = new Set(["icon", "apple-touch-icon", "apple-touch-icon-precomposed"]);

interface IconLink {
  href: string;
  rank: number;
}

function* linkTags(page: string): Generator<string> {
  const open = /<link\b/gi;
  for (let count = 0, m = open.exec(page); m && count < MAX_LINK_TAGS; m = open.exec(page)) {
    const end = page.indexOf(">", m.index);
    if (end < 0) return;
    if (end - m.index < MAX_TAG_LENGTH) {
      count++;
      yield page.slice(m.index, end + 1);
    }
    open.lastIndex = end + 1;
  }
}

function attributesOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.slice(5, -1).matchAll(ATTRIBUTE)) {
    const name = m[1]?.toLowerCase();
    if (name && !attrs.has(name)) attrs.set(name, (m[2] ?? m[3] ?? m[4] ?? "").replace(/&amp;/gi, "&").trim());
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

function onSite(host: string, pageUrl: string): boolean {
  const site = new URL(pageUrl).hostname.replace(/^www\./, "");
  return host === site || host.endsWith(`.${site}`);
}

export function iconLinksFromHtml(page: string, pageUrl: string): string[] {
  const links: IconLink[] = [];
  for (const tag of linkTags(page)) {
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
    if (safe && onSite(resolved.hostname, pageUrl)) {
      links.push({ href: safe, rank: rankOf(attrs, rels, resolved.pathname.toLowerCase()) });
    }
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

export async function resolveMcpSiteIcon(serverUrl: string, net: McpOAuthNet): Promise<string | undefined> {
  const strict: McpOAuthNet = { ...net, allowLoopbackHttp: false };
  for (const homepage of homepagesOf(serverUrl)) {
    const res = await safeFetch(
      homepage,
      { method: "GET", headers: { accept: "text/html" }, truncateAt: MAX_PAGE_BYTES },
      strict,
      "site homepage",
    ).catch(() => undefined);
    if (!res?.ok) continue;
    const [best] = iconLinksFromHtml(res.body, homepage);
    return best ?? confirmedImage(new URL("/favicon.ico", homepage).href, strict).catch(() => undefined);
  }
  return undefined;
}
