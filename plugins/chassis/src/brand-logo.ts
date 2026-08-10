import { readFileSync } from "node:fs";

let cached: Buffer | undefined;

export function brandLogoPng(): Buffer {
  cached ??= readFileSync(new URL("./brand-logo.png", import.meta.url));
  return cached;
}
