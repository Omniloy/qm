import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalSandbox,
  localContainerName,
  localNetworkName,
  localVolumeName,
} from "../src/sandbox/local-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import { FAKE_CORE_CONTAINER, installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";

const tmp = mkdtempSync(join(tmpdir(), "local-sbx-"));
const guestHome = join(tmp, "home");
let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), HOME: guestHome },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      if (res.status === 200) return;
    } catch {
      if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    }
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

function makeSandbox(fake: FakeDocker, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  return createLocalSandbox(createLocalWorkspaceStore(dir), {
    dockerExec: fake.dockerExec,
    homeDir: guestHome,
    repoRoot: tmp,
    ...opts,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];
type Reported = { category: string; code: string; scopeLabel?: string };
const collect = (into: Reported[]) => ({ onError: (e: Reported) => into.push(e) });
const inDefaultPool = (subnet: string | undefined) =>
  /^198\.18\.\d{1,3}\.\d{1,3}\/28$/.test(subnet ?? "") && Number(subnet!.split(/[./]/)[3]) % 16 === 0;
const qmNetworks = (fake: FakeDocker) => [...fake.networks].filter((n) => n.startsWith("qm-net-"));
const viaCoreNetwork =
  (fake: FakeDocker): typeof fetch =>
  (input, init) => {
    const host = String(input).match(/^http:\/\/([^/:]+):8080/)?.[1] ?? "";
    if (!fake.coreNets.has(localNetworkName(host))) return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
    return fetch(String(input).replace(/^http:\/\/[^/:]+:8080/, `http://127.0.0.1:${daemonPort}`), init);
  };

test("profile declares the local Docker substrate honestly", () => {
  const sb = makeSandbox(installFakeDocker(daemonPort));
  assert.equal(sb.profile.backend, "local-docker");
  assert.equal(sb.profile.writablePersistence, "resident_disk");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("a stopped Docker daemon fails provision with the actionable message", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.daemonDown = true;
  const sb = makeSandbox(fake);
  await assert.rejects(
    sb.provision(rw(scopeId("personal", "U0"))),
    /requires a running Docker daemon \(is Docker Desktop running\?\)/,
  );
});

test("a missing sandbox image fails provision with the build hint", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.imageMissing = true;
  const sb = makeSandbox(fake);
  await assert.rejects(sb.provision(rw(scopeId("personal", "U0"))), /not found — run `npm run sandbox:local:build`/);
});

test("cold provision creates volume + container, run() execs over the daemon, bytes round-trip", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U1");
  const h = await sb.provision(rw(scope));
  assert.equal(h.id, localContainerName(scope));
  assert.equal(h.rootDir, `${guestHome}/workspace`);
  assert.equal(h.homeDir, guestHome);
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  const c = fake.containers.get(h.id)!;
  assert.equal(c.labels["qm.sandbox"], "1");
  assert.equal(c.labels["qm.scope"], scope);
  assert.equal(c.labels["qm.org"], "default-org");
  assert.equal(c.labels["agent_env"], "dev");
  assert.equal(c.volume, localVolumeName(scope));

  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");

  const payload = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  await sb.writeFileBytes(h, "bin/blob.dat", payload);
  assert.deepEqual(Uint8Array.from((await sb.readFileBytes(h, "bin/blob.dat"))!), payload);
  assert.equal(await sb.readFileBytes(h, "bin/missing.dat"), null);
});

test("teardown parks the container and the next provision restarts it warm", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U2"));
  const h1 = await sb.provision(layers);
  await sb.teardown(h1);
  assert.equal(fake.containers.get(h1.id)!.running, false);

  const h2 = await sb.provision(layers);
  assert.equal(h2.id, h1.id, "same container reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new container run");
  assert.equal(fake.containers.get(h1.id)!.running, true, "restarted");
});

test("a stale-image container is recreated while its home volume survives", async () => {
  const fake = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "U3"));
  const h1 = await makeSandbox(fake).provision(layers);
  const volume = fake.containers.get(h1.id)!.volume!;

  fake.imageId = "sha256:image-v2";
  const h2 = await makeSandbox(fake).provision(layers);
  assert.equal(h2.id, h1.id);
  assert.equal(fake.runCount, 2, "container recreated on the new image");
  assert.equal(fake.containers.get(h2.id)!.imageId, "sha256:image-v2");
  assert.equal(fake.volumes.has(volume), true, "volume survived the recreate");
  assert.equal(h2.coldStart, false, "existing volume means a warm home");
});

test("a sandbox network pruned while parked is repaired in place: same container, pool subnet, home kept", async () => {
  const fake = installFakeDocker(daemonPort);
  const recovered: Reported[] = [];
  const sb = makeSandbox(fake, collect(recovered));
  const scope = scopeId("personal", "U_NET");
  const h1 = await sb.provision(rw(scope));
  const volume = fake.containers.get(h1.id)!.volume!;
  const net = localNetworkName(h1.id);
  await sb.teardown(h1);
  assert.equal(fake.containers.get(h1.id)!.running, false);

  fake.networks.delete(net);

  const h2 = await sb.provision(rw(scope));
  assert.equal(h2.id, h1.id, "same scope, same container id");
  assert.equal(fake.runCount, 1, "the parked container was repaired, not recreated");
  assert.equal(fake.networks.has(net), true, "a fresh network is back");
  assert.ok(inDefaultPool(fake.subnets.get(net)), `subnet ${fake.subnets.get(net)} is a /28 from the pool`);
  assert.deepEqual(fake.containers.get(h2.id)!.attached, { name: net, gen: fake.netGen.get(net) });
  assert.equal(fake.containers.get(h2.id)!.running, true);
  assert.equal(fake.volumes.has(volume), true, "the same home volume survived — no data loss");
  assert.equal(fake.containers.get(h2.id)!.volume, volume);
  assert.ok(
    recovered.some((e) => e.category === "sandbox_recover" && e.code === "network_missing"),
    "the self-heal is recorded in the durable error store",
  );
});

test("run() repairs in place when the sandbox network was pruned while the box was parked", async () => {
  const fake = installFakeDocker(daemonPort);
  const recovered: Reported[] = [];
  const sb = makeSandbox(fake, collect(recovered));
  const scope = scopeId("personal", "U_NET3");
  const h = await sb.provision(rw(scope));
  const net = localNetworkName(h.id);
  fake.containers.get(h.id)!.running = false;
  fake.networks.delete(net);
  const r = await sb.run(h, "echo ok");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "ok");
  assert.equal(fake.runCount, 1, "the same container was restarted, not recreated");
  assert.equal(fake.networks.has(net), true, "the network was restored by the run()-path self-heal");
  assert.ok(inDefaultPool(fake.subnets.get(net)));
  assert.deepEqual(fake.containers.get(h.id)!.attached, { name: net, gen: fake.netGen.get(net) });
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  assert.ok(
    recovered.some((e) => e.category === "sandbox_recover" && e.code === "network_missing"),
    "self-heal via the run() path is recorded",
  );
});

test("a network recreated under the same name still heals: the container is re-pinned to the live network", async () => {
  const fake = installFakeDocker(daemonPort);
  const recovered: Reported[] = [];
  const sb = makeSandbox(fake, collect(recovered));
  const scope = scopeId("personal", "U_NET4");
  const h1 = await sb.provision(rw(scope));
  const net = localNetworkName(h1.id);
  await sb.teardown(h1);
  fake.networks.delete(net);
  await fake.dockerExec(["network", "create", "--subnet", "198.18.255.0/28", net]);

  const h2 = await sb.provision(rw(scope));
  assert.equal(h2.id, h1.id);
  assert.equal(fake.runCount, 1, "no recreate");
  assert.equal(fake.subnets.get(net), "198.18.255.0/28", "the existing same-name network is reused");
  assert.deepEqual(fake.containers.get(h2.id)!.attached, { name: net, gen: fake.netGen.get(net) });
  assert.ok(recovered.some((e) => e.category === "sandbox_recover" && e.code === "network_missing"));
});

test("a non-network start failure still fails loudly and does not recreate the container", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U_NET2");
  const h1 = await sb.provision(rw(scope));
  await sb.teardown(h1);
  fake.startFail = "Error response from daemon: driver failed programming external connectivity";
  await assert.rejects(sb.provision(rw(scope)), /docker start .* failed/);
  assert.equal(fake.runCount, 1, "a non-network failure must not trigger a recreate");
});

test("a scratch box has no volume and is removed on teardown", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U4")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  assert.equal(fake.containers.get(h.id)!.volume, undefined);
  const net = localNetworkName(h.id);
  assert.match(net, /^qm-net-scratch-/);
  assert.equal(fake.networks.has(net), true);
  await sb.teardown(h);
  assert.equal(fake.containers.has(h.id), false, "scratch container destroyed");
  assert.equal(fake.networks.has(net), false, "scratch network removed");
});

test("teardown destroy removes both the container and its volume", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U5");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
  assert.equal(fake.networks.has(localNetworkName(h.id)), false);
});

test("concurrent provisions for one scope run a single container", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U6"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});

test("refcounted teardown: the container parks only after the last concurrent user releases", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  await sb.teardown(a);
  assert.equal(fake.containers.get(a.id)!.running, true, "still held by the sibling");
  await sb.teardown(b);
  assert.equal(fake.containers.get(b.id)!.running, false, "parked after the last release");
});

test("process sessions: start, read output, signal to exit", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  assert.ok(supportsProcessSessions(sb));
  const h = await sb.provision(rw(scopeId("personal", "U8")));
  const { processId } = await sb.startProcess!(h, "echo started; sleep 30");
  let out = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !out.includes("started")) {
    const r = await sb.readProcess!(h, processId, { waitMs: 200 });
    out += r.chunks;
  }
  assert.match(out, /started/);
  await sb.signalProcess!(h, processId, "TERM");
  let status = (await sb.readProcess!(h, processId, {})).status;
  const exitDeadline = Date.now() + 10_000;
  while (status.state !== "exited" && Date.now() < exitDeadline) {
    await sleep(200);
    status = (await sb.readProcess!(h, processId, {})).status;
  }
  assert.equal(status.state, "exited");
});

test("an aborted run returns control promptly", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U9")));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const startedAt = Date.now();
  await sb.run(h, "sleep 30", { signal: ctl.signal }).catch(() => {});
  assert.ok(Date.now() - startedAt < 5_000, "run returned promptly after abort");
});

test("read-only layers materialize into the workspace once per content fingerprint", async () => {
  const fake = installFakeDocker(daemonPort);
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const shared = scopeId("org", "default-org");
  await workspace.write(shared, "guide.md", "shared doc");
  const sb = createLocalSandbox(workspace, { dockerExec: fake.dockerExec, homeDir: guestHome, repoRoot: tmp });
  const h = await sb.provision([
    { scopeId: scopeId("personal", "U10"), mountPath: "", mode: "rw" as const },
    { scopeId: shared, mountPath: "shared", mode: "ro" as const },
  ]);
  assert.equal(await sb.readFile(h, "shared/guide.md"), "shared doc");
});

test("each container runs on its own network; destroy removes it", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scopeA = scopeId("personal", "U20");
  const scopeB = scopeId("personal", "U21");
  const ha = await sb.provision(rw(scopeA));
  const hb = await sb.provision(rw(scopeB));
  const netA = localNetworkName(ha.id);
  const netB = localNetworkName(hb.id);
  assert.notEqual(netA, netB);
  assert.equal(fake.networks.has(netA), true);
  assert.equal(fake.networks.has(netB), true);
  const subnetA = fake.subnets.get(netA);
  const subnetB = fake.subnets.get(netB);
  assert.ok(inDefaultPool(subnetA), `${subnetA} is a /28 inside 198.18.0.0/16`);
  assert.ok(inDefaultPool(subnetB), `${subnetB} is a /28 inside 198.18.0.0/16`);
  assert.notEqual(subnetA, subnetB);
  await sb.teardown(ha, { destroy: true });
  assert.equal(fake.networks.has(netA), false);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(hb);
});

test("concurrent teardown and provision for one scope serialize (no stop of a fresh user)", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U22");
  const h1 = await sb.provision(rw(scope));
  const [, h2] = await Promise.all([sb.teardown(h1), sb.provision(rw(scope))]);
  assert.equal(fake.containers.get(h2.id)!.running, true);
  const r = await sb.run(h2, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  await sb.teardown(h2);
  assert.equal(fake.containers.get(h2.id)!.running, false);
});

test("a small pool skips a foreign subnet, fails loudly when full, and never creates without --subnet", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.networks.add("foreign");
  fake.subnets.set("foreign", "198.18.0.0/28");
  const sb = makeSandbox(fake, { networkPool: "198.18.0.0/27" });
  const ha = await sb.provision(rw(scopeId("personal", "U30")));
  assert.equal(fake.subnets.get(localNetworkName(ha.id)), "198.18.0.16/28");
  await assert.rejects(
    sb.provision(rw(scopeId("personal", "U31"))),
    /no free \/28 in 198\.18\.0\.0\/27 after 2 probes/,
  );
  assert.deepEqual(qmNetworks(fake), [localNetworkName(ha.id)]);
  assert.ok(fake.networkCreates.length > 0);
  assert.ok(fake.networkCreates.every((args) => args.includes("--subnet")));
});

test("concurrent provisions in a two-slot pool get distinct subnets; one scope gets one network", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake, { networkPool: "198.18.0.0/27" });
  const [a, b] = await Promise.all([
    sb.provision(rw(scopeId("personal", "U32"))),
    sb.provision(rw(scopeId("personal", "U33"))),
  ]);
  const subnetA = fake.subnets.get(localNetworkName(a.id));
  const subnetB = fake.subnets.get(localNetworkName(b.id));
  assert.ok(subnetA && subnetB);
  assert.notEqual(subnetA, subnetB);

  const same = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "U34"));
  const results = await Promise.allSettled([makeSandbox(same).provision(layers), makeSandbox(same).provision(layers)]);
  assert.deepEqual(qmNetworks(same), [localNetworkName(localContainerName(scopeId("personal", "U34")))]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /already in use/);
  assert.equal(same.containers.has(localContainerName(scopeId("personal", "U34"))), true);
});

test("an invalid network pool fails construction; a valid one is masked to its prefix", async () => {
  const fake = installFakeDocker(daemonPort);
  for (const networkPool of ["198.18.0.0/29", "300.1.0.0/16", "nope", "198.18.0.0/7"]) {
    assert.throws(() => makeSandbox(fake, { networkPool }), /must be an IPv4 CIDR between \/8 and \/28/);
  }
  const sb = makeSandbox(fake, { networkPool: "10.201.7.9/24" });
  const h = await sb.provision(rw(scopeId("personal", "U35")));
  assert.match(fake.subnets.get(localNetworkName(h.id))!, /^10\.201\.7\.\d+\/28$/);
});

test("scratch and sbx for one scope use distinct networks; scratch teardown leaves the parked sbx intact", async () => {
  const fake = installFakeDocker(daemonPort);
  const reported: Reported[] = [];
  const sb = makeSandbox(fake, collect(reported));
  const scope = scopeId("personal", "U36");
  const box = await sb.provision(rw(scope));
  await sb.teardown(box);
  const scratch = await sb.provision(rw(scope), { scratch: { key: scope } });
  assert.notEqual(localNetworkName(scratch.id), localNetworkName(box.id));
  await sb.teardown(scratch);
  assert.equal(fake.networks.has(localNetworkName(box.id)), true);
  assert.equal(fake.networks.has(localNetworkName(scratch.id)), false);
  await sb.provision(rw(scope));
  assert.deepEqual(reported, []);
});

test("a stopped leftover scratch container is removed and run fresh", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h1 = await sb.provision(rw(scopeId("personal", "U37")), { scratch: { key: "left" } });
  const leftover = fake.containers.get(h1.id)!;
  leftover.running = false;
  leftover.networkMode = "qm-net-legacy-shared";
  const h2 = await makeSandbox(fake).provision(rw(scopeId("personal", "U37")), { scratch: { key: "left" } });
  assert.equal(h2.id, h1.id);
  assert.equal(h2.coldStart, true);
  assert.equal(fake.runCount, 2);
  assert.equal(fake.containers.get(h2.id)!.networkMode, localNetworkName(h2.id));
});

test("a running legacy scratch box on the shared network is replaced, not rejoined, by a containerised core", async () => {
  const fake = installFakeDocker(daemonPort);
  const coreOpts = () => ({ coreContainer: FAKE_CORE_CONTAINER, fetchImpl: viaCoreNetwork(fake) });
  const scope = scopeId("personal", "U43");
  const box = await makeSandbox(fake, coreOpts()).provision(rw(scope));
  const h1 = await makeSandbox(fake, coreOpts()).provision(rw(scope), { scratch: { key: "legacy" } });
  const legacyNet = localNetworkName(box.id);
  const leftover = fake.containers.get(h1.id)!;
  leftover.networkMode = legacyNet;
  fake.networks.delete(localNetworkName(h1.id));
  fake.coreNets.clear();

  const h2 = await makeSandbox(fake, coreOpts()).provision(rw(scope), { scratch: { key: "legacy" } });
  assert.equal(h2.id, h1.id);
  assert.equal(h2.coldStart, true);
  assert.equal(fake.runCount, 3);
  assert.equal(fake.containers.get(h2.id)!.networkMode, localNetworkName(h2.id));
  assert.equal(fake.coreNets.has(localNetworkName(h2.id)), true);
});

test("a failed docker run removes the created container and its network, unless the name is in use", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.runFail = "docker: Error response from daemon: failed to create task for container";
  fake.runFailLeavesCreated = true;
  const scope = scopeId("personal", "U38");
  await assert.rejects(makeSandbox(fake).provision(rw(scope)), /docker run .* failed/);
  assert.equal(fake.containers.has(localContainerName(scope)), false);
  assert.deepEqual(qmNetworks(fake), []);

  const taken = installFakeDocker(daemonPort);
  taken.runFail = `docker: Error response from daemon: Conflict. The container name "/x" is already in use`;
  taken.runFailLeavesCreated = true;
  await assert.rejects(makeSandbox(taken).provision(rw(scope)), /already in use/);
  assert.equal(taken.containers.has(localContainerName(scope)), true, "another core's container is left alone");
});

test("a core attach failure after docker run removes the container and its network", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.connectFail = { container: FAKE_CORE_CONTAINER, stderr: "Error response from daemon: boom" };
  const sb = makeSandbox(fake, { coreContainer: FAKE_CORE_CONTAINER, fetchImpl: viaCoreNetwork(fake) });
  const scope = scopeId("personal", "U39");
  await assert.rejects(sb.provision(rw(scope)), /network connect .* failed: .*boom/);
  assert.equal(fake.containers.has(localContainerName(scope)), false);
  assert.deepEqual(qmNetworks(fake), []);
});

test("a containerised core joins each sandbox network, rejoins after a restart, and leaves before rm", async () => {
  const fake = installFakeDocker(daemonPort);
  const reported: Reported[] = [];
  const sb = makeSandbox(fake, {
    coreContainer: FAKE_CORE_CONTAINER,
    fetchImpl: viaCoreNetwork(fake),
    ...collect(reported),
  });
  const scope = scopeId("personal", "U40");
  const h1 = await sb.provision(rw(scope));
  const net = localNetworkName(h1.id);
  assert.equal(fake.coreNets.has(net), true);
  await sb.teardown(h1);

  fake.coreNets.clear();
  const h2 = await sb.provision(rw(scope));
  assert.equal(fake.coreNets.has(net), true, "core rejoined after a restart");

  await sb.teardown(h2, { destroy: true });
  assert.equal(fake.networks.has(net), false, "network rm succeeded, so core was disconnected first");
  assert.equal(fake.coreNets.has(net), false);
  assert.deepEqual(reported, []);
});

test("a restarted containerised core rejoins a sandbox that stayed running and replaces an orphaned scratch box", async () => {
  const fake = installFakeDocker(daemonPort);
  const reported: Reported[] = [];
  const coreOpts = () => ({
    coreContainer: FAKE_CORE_CONTAINER,
    fetchImpl: viaCoreNetwork(fake),
    ...collect(reported),
  });
  const scope = scopeId("personal", "U42");
  const box = await makeSandbox(fake, coreOpts()).provision(rw(scope));
  await makeSandbox(fake, coreOpts()).teardown(box, { keepWarm: true });
  const scratch = await makeSandbox(fake, coreOpts()).provision(rw(scope), { scratch: { key: "warm" } });

  fake.coreNets.clear();
  const restarted = makeSandbox(fake, coreOpts());
  const box2 = await restarted.provision(rw(scope));
  const scratch2 = await restarted.provision(rw(scope), { scratch: { key: "warm" } });
  assert.equal(box2.id, box.id);
  assert.equal(scratch2.id, scratch.id);
  assert.equal(scratch2.coldStart, true, "the orphaned scratch box was replaced");
  assert.equal(fake.runCount, 3, "only the scratch box was recreated");
  assert.equal(fake.containers.get(box.id)!.running, true);
  assert.equal(fake.coreNets.has(localNetworkName(box.id)), true);
  assert.equal(fake.coreNets.has(localNetworkName(scratch.id)), true);
  assert.deepEqual(reported, []);
});

test("a heal whose container reconnect fails removes the container so the next turn recreates it", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U43");
  const h1 = await sb.provision(rw(scope));
  await sb.teardown(h1);
  fake.networks.delete(localNetworkName(h1.id));
  fake.connectFail = { container: h1.id, stderr: "Error response from daemon: boom" };
  await assert.rejects(sb.provision(rw(scope)), /network connect .* failed: .*boom/);
  assert.equal(fake.containers.has(h1.id), false, "no zero-network container is left to start into nothing");
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);

  delete fake.connectFail;
  const h2 = await sb.provision(rw(scope));
  assert.equal(h2.id, h1.id);
  assert.equal(h2.coldStart, false, "the home volume survived");
  assert.equal(fake.runCount, 2);
});

test("a network removed between create and run leaves no created container or network behind", async () => {
  const fake = installFakeDocker(daemonPort);
  const scope = scopeId("personal", "U44");
  const racing: typeof fake.dockerExec = (args, timeoutMs) => {
    if (args[0] === "run") fake.networks.delete(localNetworkName(localContainerName(scope)));
    return fake.dockerExec(args, timeoutMs);
  };
  await assert.rejects(makeSandbox(fake, { dockerExec: racing }).provision(rw(scope)), /Could not attach to network/);
  assert.equal(fake.containers.has(localContainerName(scope)), false);
  assert.deepEqual(qmNetworks(fake), []);
});

test("a failed network rm is reported; an already-missing network is not", async () => {
  const fake = installFakeDocker(daemonPort);
  const reported: Reported[] = [];
  const sb = makeSandbox(fake, collect(reported));
  const scope = scopeId("personal", "U41");
  const h = await sb.provision(rw(scope));
  fake.networkRmFail = "Error response from daemon: boom";
  await sb.teardown(h, { destroy: true });
  assert.deepEqual(
    reported.map((e) => [e.category, e.code, e.scopeLabel]),
    [["sandbox_network", "network_rm_failed", scope]],
  );

  delete fake.networkRmFail;
  reported.length = 0;
  const scratch = await sb.provision(rw(scope), { scratch: { key: "gone" } });
  fake.networks.delete(localNetworkName(scratch.id));
  await sb.teardown(scratch);
  assert.deepEqual(reported, []);
});
