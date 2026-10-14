const NON_SECRET_ENV_KEYS = new Set([
  "AGENT_API_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "BROWSE_LAB_MAX_STEPS",
  "BROWSE_LAB_MODEL",
  "BROWSE_LAB_MODEL_PROVIDER",
  "PYTHONUNBUFFERED",
  "NO_PROXY",
  "no_proxy",
]);

const MIN_MASKABLE_LENGTH = 8;

export function createSecretValueMasker(env: Record<string, string> | undefined): (text: string) => string {
  const variants: Array<{ needle: string; label: string }> = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (NON_SECRET_ENV_KEYS.has(key) || value.length < MIN_MASKABLE_LENGTH) continue;
    variants.push({ needle: value, label: key });
    const uri = encodeURIComponent(value);
    if (uri !== value) variants.push({ needle: uri, label: key });
    variants.push({ needle: Buffer.from(value, "utf8").toString("base64").replace(/=+$/, ""), label: key });
    variants.push({ needle: Buffer.from(value, "utf8").toString("base64url"), label: key });
  }
  if (!variants.length) return (text) => text;
  variants.sort((a, b) => b.needle.length - a.needle.length);
  return (text) => {
    for (const { needle, label } of variants) {
      if (text.includes(needle)) text = text.split(needle).join(`<redacted:${label}>`);
    }
    return text;
  };
}

export class MaskedExecutionError extends Error {}

export function createExactSecretValueMasker(values: Iterable<string>): (text: string) => string {
  const secrets = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!secrets.length) return (text) => text;
  const pattern = new RegExp(secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => text.replace(pattern, () => "<redacted:credential>");
}

export function executionSecretEnv(
  env: Record<string, string> | undefined,
  fields: readonly { key: string; value: string; secret?: boolean }[] = [],
): Record<string, string> {
  const secrets = Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !NON_SECRET_ENV_KEYS.has(key)));
  const injected = fields.filter((field) => env?.[field.key] === field.value);
  for (const field of injected) if (field.secret === false) delete secrets[field.key];
  for (const field of injected) if (field.secret !== false) secrets[field.key] = field.value;
  return secrets;
}

function redactPipedIntoWithToken(command: string): string {
  const segments = command.split("|");
  let sink = segments.length - 1;
  while (sink > 0 && !/--with-token\b/i.test(segments[sink]!)) sink--;
  if (sink === 0) return command;
  const upstream = segments.slice(0, sink).join("|");
  const producer = /(?:printf|echo)\s/i.exec(upstream);
  if (!producer || !upstream.slice(producer.index + producer[0].length).trim()) return command;
  const consumed = /^[\s\S]*--with-token\b/i.exec(segments[sink]!)![0];
  const rest = command.slice(upstream.length + 1 + consumed.length);
  return `${upstream.slice(0, producer.index)}echo <redacted>${upstream.slice(upstream.trimEnd().length)}|${consumed}${rest}`;
}

const NOT_REDACTED = "(?!['\"]?<redacted)";

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [
    new RegExp(`(--?(?:token|password|passwd|secret|client[-_]?secret|api[-_]?key)[ =])${NOT_REDACTED}\\S+`, "gi"),
    "$1<redacted>",
  ],
  [
    new RegExp(`((?:proxy-)?authorization:\\s*(?:bearer|basic|token)\\s+)${NOT_REDACTED}[^\\s'"]+`, "gi"),
    "$1<redacted>",
  ],
  [new RegExp(`((?:x-api-key|x-auth-token|cookie):\\s*)${NOT_REDACTED}[^'"\\r\\n]+`, "gi"), "$1<redacted>"],
  [new RegExp(`((?:^|\\s)(?:-u|--user)[ =]?['"]?[^\\s:'"]{1,200}:)${NOT_REDACTED}[^\\s'"]+`, "g"), "$1<redacted>"],
  [new RegExp(`(\\bmysql(?:dump|admin)?\\b[^\\n|;&]{0,200}?\\s-p)${NOT_REDACTED}\\S+`, "g"), "$1<redacted>"],
  [
    new RegExp(`(\\b[a-z][a-z0-9+.-]{0,30}:\\/\\/[^\\s:@/'"]{1,200}:)${NOT_REDACTED}[^\\s@/'"]{1,500}@`, "gi"),
    "$1<redacted>@",
  ],
  [
    new RegExp(
      `([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|sig|signature)=)${NOT_REDACTED}[^&\\s'"#]+`,
      "gi",
    ),
    "$1<redacted>",
  ],
  [
    new RegExp(
      `(\\b[A-Z][A-Z0-9_]{0,60}(?:PASS|PASSWORD|PASSWD|SECRET|TOKEN|KEY|IDENTIFIER|CREDENTIAL|PROXY_USER)[A-Z0-9_]{0,60}=)${NOT_REDACTED}('[^']*'|"[^"]*"|[^\\s'";&|]+)`,
      "g",
    ),
    "$1<redacted>",
  ],
];

export function redactSecretText(text: string, mask: (text: string) => string = (t) => t): string {
  let out = mask(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redactCommand(command: string, env?: Record<string, string>): string {
  return redactPipedIntoWithToken(redactSecretText(command, createSecretValueMasker(env))).slice(0, 500);
}
