export const HUGGING_FACE_ORIGIN = "https://huggingface.co";
export const GATED_MODEL_PROBE_PATH =
  "/gradium/phonon-40m-multilingual/resolve/1537ce46c64f42903e0d608b132ccb073dac46d2/tokenizer.json";
const PROBE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;

export type GatedModelAccess = "servable" | "no_token" | "token_refused" | "unchecked";

export function sendableToken(token: string): boolean {
  return /^[\x21-\x7E]+$/.test(token);
}

let lastProbe: { key: string; expires: number; access: Promise<GatedModelAccess> } | undefined;

async function probeToken(token: string, origin: string): Promise<GatedModelAccess> {
  try {
    const { status } = await fetch(new URL(GATED_MODEL_PROBE_PATH, origin), {
      method: "HEAD",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (status === 401 || status === 403) return "token_refused";
    return status < 400 ? "servable" : "unchecked";
  } catch {
    return "unchecked";
  }
}

export function gatedModelAccess(
  token: string | undefined,
  localModelDir: string | undefined,
  origin = HUGGING_FACE_ORIGIN,
): Promise<GatedModelAccess> {
  if (localModelDir?.trim()) return Promise.resolve("servable");
  const bearer = token?.trim();
  if (!bearer) return Promise.resolve("no_token");
  if (!sendableToken(bearer)) return Promise.resolve("token_refused");
  const key = `${origin} ${bearer}`;
  if (lastProbe?.key !== key || lastProbe.expires <= Date.now())
    lastProbe = { key, expires: Date.now() + PROBE_TTL_MS, access: probeToken(bearer, origin) };
  return lastProbe.access;
}
