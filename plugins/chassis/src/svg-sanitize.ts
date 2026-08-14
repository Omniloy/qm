const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

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

const MAX_LOGO_SVG_BYTES = 64 * 1024;

export class InvalidLogoSvgError extends Error {}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const HIDDEN_MARKUP = /<!--|<!\[CDATA\[|<\?/;
const EXTERNAL_SCHEME = /^(javascript|data|vbscript):/;
const VALID_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#[xX][0-9a-fA-F]+);/g;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function reject(reason: string): never {
  throw new InvalidLogoSvgError(reason);
}

function decodeEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function rejectExternalReference(name: string, rawValue: string): void {
  const unquoted = rawValue.replace(/^["']|["']$/g, "");
  const flattened = decodeEntities(unquoted).replace(/[\s]/g, "").toLowerCase();
  if (EXTERNAL_SCHEME.test(flattened) || flattened.includes("url(http") || flattened.includes("url(//")) {
    reject(`the value of "${name}" references something outside the logo`);
  }
}

function rejectLooseAmpersands(svg: string): void {
  const withoutEntities = svg.replace(VALID_ENTITY, "");
  if (withoutEntities.includes("&")) {
    reject("the logo contains a bare & — write it as &amp; so the SVG parses");
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
  rejectLooseAmpersands(svg);

  let depth = 0;
  let sawRoot = false;
  let rootNamespace: string | undefined;
  let tagCount = 0;

  for (const tag of svg.matchAll(TAG)) {
    const raw = tag[0];
    const name = (tag[1] ?? "").toLowerCase();
    const attributes = tag[2] ?? "";
    const isClosing = raw.startsWith("</");
    const isSelfClosing = attributes.trimEnd().endsWith("/");
    const isRoot = name === "svg" && !isClosing;
    tagCount += 1;

    if (!ALLOWED_ELEMENTS.has(name)) reject(`<${name}> is not allowed in a logo`);
    if (isRoot) {
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
      const rawValue = attribute[2];
      if (rawValue === undefined || !/^["']/.test(rawValue)) {
        reject(`the value of "${attributeName}" must be quoted so the SVG parses`);
      }
      if (/[<>]/.test(rawValue.slice(1, -1))) {
        reject(`the value of "${attributeName}" contains markup — write < and > as &lt; and &gt;`);
      }
      if (isRoot && attributeName === "xmlns") rootNamespace = decodeEntities(rawValue.slice(1, -1)).trim();
      rejectExternalReference(attributeName, rawValue);
    }
  }

  if (depth !== 0) reject("the logo has unbalanced tags");
  if (!sawRoot || tagCount === 0) reject("the logo must be a single <svg> element");
  if (rootNamespace !== SVG_NAMESPACE) {
    reject(`the root <svg> needs xmlns="${SVG_NAMESPACE}", or nothing will render it`);
  }

  const betweenTags = svg.replace(TAG, "");
  if (betweenTags.includes("<") || betweenTags.includes(">")) {
    reject("the logo contains markup that could not be read");
  }

  return svg;
}
