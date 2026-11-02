import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";

export interface FsUsage {
  path: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

const DU_BIN = "du";

export function dirBytes(path: string, timeoutMs = 600_000): Promise<number | null> {
  return new Promise((done) => {
    execFile(DU_BIN, ["-sk", path], { timeout: timeoutMs, killSignal: "SIGKILL" }, (_err, stdout) => {
      const first = String(stdout).trim().split(/\s+/)[0] ?? "";
      done(/^\d+$/.test(first) ? Number(first) * 1024 : null);
    });
  });
}

export async function fsUsage(path: string): Promise<FsUsage | null> {
  try {
    const s = await statfs(path);
    return {
      path,
      totalBytes: s.blocks * s.bsize,
      usedBytes: (s.blocks - s.bfree) * s.bsize,
      availableBytes: s.bavail * s.bsize,
    };
  } catch {
    return null;
  }
}
