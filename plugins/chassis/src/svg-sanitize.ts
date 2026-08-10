const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "defs",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
  "title",
  "desc",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "d",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "opacity",
  "transform",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "clip-path",
  "clip-rule",
  "id",
  "class",
  "role",
  "aria-label",
  "aria-hidden",
  "xmlns",
  "preserveaspectratio",
]);

export const MAX_LOGO_SVG_BYTES = 64 * 1024;

export class InvalidLogoSvgError extends Error {}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const HIDDEN_MARKUP = /<!--|<!\[CDATA\[|<\?/;
const EXTERNAL_SCHEME = /^(javascript|data|vbscript):/;

function reject(reason: string): never {
  throw new InvalidLogoSvgError(reason);
}

function rejectExternalReference(name: string, rawValue: string): void {
  const flattened = rawValue.replace(/^["']|["']$/g, "").replace(/[\s\-]/g, "").toLowerCase();
  if (EXTERNAL_SCHEME.test(flattened) || flattened.includes("url(http") || flattened.includes("url(//")) {
    reject(`the value of "${name}" references something outside the logo`);
  }
}

export function sanitizeLogoSvg(input: string): string {
  const svg = input.trim();
  if (!svg) reject("the logo is empty");
  if (Buffer.byteLength(svg, "utf8") > MAX_LOGO_SVG_BYTES) {
    reject(`the logo is larger than ${MAX_LOGO_SVG_BYTES / 1024} KB`);
  }
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) reject("the logo must be a single <svg> element");
  if (HIDDEN_MARKUP.test(svg)) reject("the logo must not contain comments, CDATA, or processing instructions");

  let depth = 0;
  let sawRoot = false;
  let tagCount = 0;

  for (const tag of svg.matchAll(TAG)) {
    const raw = tag[0];
    const name = (tag[1] ?? "").toLowerCase();
    const attributes = tag[2] ?? "";
    const isClosing = raw.startsWith("</");
    const isSelfClosing = attributes.trimEnd().endsWith("/");
    tagCount += 1;

    if (!ALLOWED_ELEMENTS.has(name)) reject(`<${name}> is not allowed in a logo`);
    if (name === "svg" && !isClosing) {
      if (sawRoot) reject("the logo must be a single <svg> element");
      sawRoot = true;
    } else if (!sawRoot) {
      reject("the logo must be a single <svg> element");
    }

    if (isClosing) {
      depth -= 1;
      if (depth < 0) reject("the logo has unbalanced tags");
      continue;
    }
    if (!isSelfClosing) depth += 1;

    for (const attribute of attributes.matchAll(ATTR)) {
      const attributeName = (attribute[1] ?? "").toLowerCase();
      if (!attributeName || attributeName === "/") continue;
      if (!ALLOWED_ATTRIBUTES.has(attributeName)) {
        reject(`the attribute "${attributeName}" is not allowed in a logo`);
      }
      rejectExternalReference(attributeName, attribute[2] ?? "");
    }
  }

  if (depth !== 0) reject("the logo has unbalanced tags");
  if (!sawRoot || tagCount === 0) reject("the logo must be a single <svg> element");

  const betweenTags = svg.replace(TAG, "");
  if (betweenTags.includes("<") || betweenTags.includes(">")) {
    reject("the logo contains markup that could not be read");
  }

  return svg;
}
