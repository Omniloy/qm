import { readFileSync } from "node:fs";

export const CORE_API_URL = (process.env.CORE_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
export const CORE_ORG_ID = process.env.CORE_ORG_ID ?? "acme";
const secret = (raw: string | undefined): string | undefined => (raw?.trim() ? raw : undefined);

export const CORE_SIGNING_SECRET = secret(process.env.CORE_SIGNING_SECRET);
export const PORTAL_IDENTITY_SECRET = secret(process.env.PORTAL_IDENTITY_SECRET) ?? CORE_SIGNING_SECRET;
if (!secret(process.env.PORTAL_IDENTITY_SECRET) && CORE_SIGNING_SECRET) {
  console.warn(
    "[chassis] PORTAL_IDENTITY_SECRET unset, signing portal identity with CORE_SIGNING_SECRET (dev fallback)",
  );
}

export function portFromEnv(fallback: number): number {
  return Number(process.env.PORT ?? fallback);
}

const fileContents = new Map<string, string>();

function readOnce(file: string): string {
  let content = fileContents.get(file);
  if (content === undefined) {
    content = readFileSync(file, "utf8");
    fileContents.set(file, content);
  }
  return content;
}

export function envOrFile(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`]?.trim();
  return env[name] || (file ? readOnce(file) : undefined);
}
