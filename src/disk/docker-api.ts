import { request } from "node:http";

export interface DockerApi {
  get<T>(path: string): Promise<T>;
  del(path: string): Promise<number>;
}

const REQUEST_TIMEOUT_MS = 300_000;

export function createDockerApi(socketPath: string): DockerApi {
  const call = (method: string, path: string): Promise<{ status: number; body: string }> =>
    new Promise((done, fail) => {
      const req = request({ socketPath, path, method, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", fail);
      });
      req.on("timeout", () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
      req.on("error", fail);
      req.end();
    });
  return {
    async get<T>(path: string): Promise<T> {
      const r = await call("GET", path);
      if (r.status < 200 || r.status >= 300)
        throw new Error(`docker GET ${path} returned ${r.status}: ${r.body.trim()}`);
      return JSON.parse(r.body) as T;
    },
    async del(path: string): Promise<number> {
      return (await call("DELETE", path)).status;
    },
  };
}
