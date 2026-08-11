import assert from "node:assert/strict";
import test from "node:test";
import { InvalidLogoSvgError, sanitizeLogoSvg } from "../plugins/chassis/src/svg-sanitize.ts";
import { injectBranding, logoCssUrl } from "../plugins/chassis/src/branding.ts";
import { BRAND } from "../plugins/chassis/src/brand.ts";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const ok = `<svg ${NS} viewBox="0 0 10 10"><path fill="#003B7A" d="M0 0h10v10H0z"/></svg>`;

function rejects(svg: string, why: string): void {
  assert.throws(() => sanitizeLogoSvg(svg), InvalidLogoSvgError, why);
}

test("a logo that would not parse as XML is refused rather than silently blanked", () => {
  rejects(`<svg ${NS}><title>Tom & Jerry</title><path d="M0 0"/></svg>`, "bare ampersand");
  rejects(`<svg ${NS}><g id=a/></svg>`, "unquoted attribute value");
  rejects(`<svg ${NS}><g id="a><script>x</script>"></g></svg>`, "unescaped < inside an attribute value");
  assert.equal(sanitizeLogoSvg(`<svg ${NS}><title>Tom &amp; Jerry</title><path d="M0 0"/></svg>`).length > 0, true);
});

test("a logo outside the SVG namespace is refused, because nothing would render it", () => {
  rejects('<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>', "no xmlns at all");
  rejects('<svg xmlns="http://example.com/evil"><path d="M0 0"/></svg>', "wrong namespace");
  assert.equal(sanitizeLogoSvg(ok), ok);
});

test("an external reference hidden behind character references is still caught", () => {
  rejects(`<svg ${NS}><path fill="url(&#104;ttp://evil.example/x)" d="M0 0"/></svg>`, "decimal entity");
  rejects(`<svg ${NS}><path fill="url(&#47;/evil.example/x)" d="M0 0"/></svg>`, "protocol-relative");
  rejects(`<svg ${NS}><path fill="url(http://evil.example/x)" d="M0 0"/></svg>`, "plain");
});

test("script-bearing markup stays refused", () => {
  for (const bad of [
    `<svg ${NS}><script>alert(1)</script></svg>`,
    `<svg ${NS}><path d="M0 0" onload="alert(1)"/></svg>`,
    `<svg ${NS}><image href="https://evil.test/x.png"/></svg>`,
    `<svg ${NS}><foreignObject><b>hi</b></foreignObject></svg>`,
    `<svg ${NS}><!--<script>alert(1)</script>--></svg>`,
    "<div>not a logo</div>",
  ]) {
    rejects(bad, bad.slice(0, 40));
  }
});

test("the logo cannot escape the CSS url() it is inlined into", () => {
  const url = logoCssUrl(`<svg ${NS}><title>a&quot;)}&lt;/style&gt;&lt;b&gt;</title><path d="M0 0"/></svg>`);
  assert.ok(url.startsWith('url("data:image/svg+xml;charset=utf-8,'));
  const payload = url.slice('url("data:image/svg+xml;charset=utf-8,'.length, -2);
  for (const forbidden of ['"', "'", "<", ">", "\\"]) {
    assert.ok(!payload.includes(forbidden), `${forbidden} must be percent-encoded`);
  }
});

test("a shell with no branding still gets the shipped product name in its title", () => {
  const html = injectBranding("<html><head><title>__BRAND__ Admin</title></head><body></body></html>", {});
  assert.match(html, new RegExp(`<title>${BRAND.productName} Admin</title>`));
  assert.doesNotMatch(html, /<title>\s*Admin<\/title>/);
});

test("branding drives the badge: a logo replaces the letter, and its absence keeps it", () => {
  const withLogo = injectBranding("<html><head></head><body></body></html>", { logoSvg: ok, mark: "M" });
  assert.match(withLogo, /--brand-logo:url\("data:image\/svg\+xml/);
  assert.match(withLogo, /--brand-mark:""/);
  assert.match(withLogo, /--brand-mark-bg:transparent/);

  const withoutLogo = injectBranding("<html><head></head><body></body></html>", { mark: "M" });
  assert.match(withoutLogo, /--brand-mark:"M"/);
  assert.doesNotMatch(withoutLogo, /--brand-logo/);
});
