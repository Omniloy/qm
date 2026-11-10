import { constants as bufferLimits } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BlobTooLargeError } from "../persistence/blob-transfer.ts";
import type { ByteSource } from "../util/bytes.ts";

const execFileAsync = promisify(execFile);
const MAX_DAEMON_READ_BYTES = Math.floor((bufferLimits.MAX_STRING_LENGTH - '{"b64":""}'.length) / 4) * 3;

export type DockerExec = (
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function spawnDockerExec(dockerBin: string): DockerExec {
  return (args, timeoutMs = 60_000) =>
    new Promise((res) => {
      const child = spawn(dockerBin, args, { timeout: timeoutMs, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (r: { code: number; stdout: string; stderr: string }) => {
        if (!settled) {
          settled = true;
          res(r);
        }
      };
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => done({ code: -1, stdout, stderr: `${stderr}\n${e.message}` }));
      child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
    });
}

export type DockerFileRead = (id: string, path: string, maxBytes: number) => Promise<ByteSource | "too_large" | null>;

export function spawnDockerFileRead(dockerBin: string): DockerFileRead {
  return async (id, path, maxBytes) => {
    const limit = Math.min(maxBytes, MAX_DAEMON_READ_BYTES);
    let size: number;
    try {
      const { stdout } = await execFileAsync(
        dockerBin,
        ["exec", id, "/bin/sh", "-c", 'test -f "$1" || exit 44; exec stat -Lc %s -- "$1"', "read-workspace", path],
        { maxBuffer: 4_096, timeout: 30_000, killSignal: "SIGKILL" },
      );
      size = Number(stdout.trim());
      if (!/^\d+$/.test(stdout.trim())) throw new Error("invalid Docker file size");
    } catch (error) {
      if ((error as { code?: unknown }).code === 44) return null;
      throw new Error("cannot inspect sandbox file", { cause: error });
    }
    if (size > limit) return "too_large";
    return (async function* () {
      const child = spawn(dockerBin, ["exec", id, "head", "-c", String(limit + 1), "--", path], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 120_000,
        killSignal: "SIGKILL",
      });
      let failure: Error | undefined;
      const finished = new Promise<number | null>((resolve) => {
        child.once("error", (error) => (failure = error));
        child.once("close", resolve);
      });
      let received = 0;
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
          received += chunk.length;
          if (received > limit) throw new BlobTooLargeError();
          yield chunk;
        }
        if ((await finished) !== 0 || failure) throw new Error("cannot read sandbox workspace", { cause: failure });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await finished;
      }
    })();
  };
}
