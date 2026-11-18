import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDiskAlerts, type DiskAlertDeps, type DiskAlertRecord } from "../src/disk/disk-alerts.ts";
import type { DiskFilesystem, FilesystemRole } from "../src/disk/disk-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const GB = 1024 ** 3;

function disk(roles: FilesystemRole[], usedPercent: number, totalBytes = 225 * GB): DiskFilesystem {
  const usedBytes = Math.round((totalBytes * usedPercent) / 100);
  return {
    holds: roles.map((role) => ({ role, path: role === "data" ? "/opt/qm/data" : "/var/lib/docker" })),
    totalBytes,
    usedBytes,
    availableBytes: totalBytes - usedBytes,
    usedPercent,
  };
}

function harness(over: Partial<DiskAlertDeps> = {}) {
  let current: DiskFilesystem[] = [];
  const dms: Array<{ to: string; text: string; key: string }> = [];
  const emails: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const store = createMemoryMap<DiskAlertRecord>();
  let clock = Date.UTC(2026, 10, 18, 9);
  const deps: DiskAlertDeps = {
    filesystems: async () => current,
    admins: async () => ["enrique@omniloy.test", "ENRIQUE@omniloy.test", "U0SLACK"],
    store,
    deliveries: {
      enqueue: async (input) => {
        dms.push({ to: input.destination.target, text: input.text, key: input.idempotencyKey });
        return {} as never;
      },
    },
    mailer: {
      send: async (message) => {
        emails.push(message);
        return "sent";
      },
    },
    orgId: "omniloy",
    publicWebUrl: "https://mo.example.com/",
    now: () => (clock += 60_000),
    ...over,
  };
  return {
    deps,
    dms,
    emails,
    store,
    async at(...filesystems: DiskFilesystem[]) {
      current = filesystems;
      await checkDiskAlerts(deps);
    },
  };
}

test("crossing 85% messages and emails each org admin once, naming the disk, what it holds and the Disk tab", async () => {
  const h = harness();
  await h.at(disk(["data", "docker"], 84.9));
  assert.equal(h.dms.length + h.emails.length, 0);

  await h.at(disk(["data", "docker"], 86.2));
  assert.deepEqual(
    h.dms.map((m) => m.to),
    ["enrique@omniloy.test", "U0SLACK"],
    "one message per person, with case-folded duplicates merged",
  );
  assert.deepEqual(
    h.emails.map((m) => m.to),
    ["enrique@omniloy.test"],
    "only admins known by an email address get an email",
  );
  const [email] = h.emails;
  assert.equal(email!.subject, "Disk 86% full on mo.example.com");
  assert.match(
    email!.text,
    /^Disk alert on mo\.example\.com: the disk holding QM data and Docker \(\/opt\/qm\/data, \/var\/lib\/docker\) is 86% full, with 31\.0 GB free of 225\.0 GB\./,
  );
  assert.match(
    email!.text,
    /See what is using it and free space in the Disk tab: https:\/\/mo\.example\.com\/admin\/disk$/,
  );
  assert.equal(h.dms[0]!.text, email!.text);
  assert.ok(email!.html.startsWith("<p>Disk alert on mo.example.com"));
  assert.notEqual(h.dms[0]!.key, h.dms[1]!.key);

  await h.at(disk(["data", "docker"], 88));
  assert.equal(h.dms.length, 2, "staying above 85% does not repeat the alert");
  assert.deepEqual(await h.store.get("data"), await h.store.get("docker"));
  assert.equal((await h.store.get("docker"))?.level, 85);
});

test("each higher level alerts once, and the alert re-arms only after the disk drops below 80%", async () => {
  const h = harness({ admins: async () => ["ops@omniloy.test"] });
  const subjects = () => h.emails.map((m) => m.subject);
  for (const percent of [85, 89, 90.5, 93, 96, 99]) await h.at(disk(["data"], percent));
  assert.deepEqual(subjects(), [
    "Disk 85% full on mo.example.com",
    "Disk 90% full on mo.example.com",
    "Disk 96% full on mo.example.com",
  ]);
  await h.at(disk(["data"], 82));
  await h.at(disk(["data"], 87));
  assert.equal(h.emails.length, 3, "dipping to 82% is not a new episode");
  await h.at(disk(["data"], 79));
  assert.equal(await h.store.get("data"), null);
  await h.at(disk(["data"], 86));
  assert.deepEqual(subjects().slice(3), ["Disk 86% full on mo.example.com"]);
  assert.equal(new Set(h.dms.map((m) => m.key)).size, h.dms.length, "every alert gets its own outbox key");
});

test("the alert state is durable, so another instance reading the same store does not alert again", async () => {
  const h = harness();
  await h.at(disk(["data", "docker"], 91));
  const other = harness({ store: h.store });
  await other.at(disk(["data", "docker"], 92));
  assert.equal(other.dms.length + other.emails.length, 0);
});

test("after Docker moves to its own disk, each disk is judged on its own", async () => {
  const h = harness({ admins: async () => ["ops@omniloy.test"] });
  await h.at(disk(["data", "docker"], 97));
  assert.equal(h.emails.length, 1);
  await h.at(disk(["data"], 21), disk(["docker"], 36, 455 * GB));
  assert.equal(await h.store.get("data"), null);
  assert.equal(await h.store.get("docker"), null);
  await h.at(disk(["data"], 22), disk(["docker"], 86, 455 * GB));
  assert.deepEqual(
    h.emails.map((m) => m.text.split(":")[1]!.trim().split(" (")[0]),
    ["the disk holding QM data and Docker", "the disk holding Docker"],
  );
});

test("an alert whose emails all failed is retried, reusing the queued message's outbox key", async () => {
  let fail = true;
  const h = harness({
    admins: async () => ["ops@omniloy.test"],
    mailer: {
      send: async () => {
        if (fail) throw new Error("Resend rejected the message: HTTP 500");
        return "sent";
      },
    },
  });
  await h.at(disk(["data"], 90));
  assert.equal((await h.store.get("data"))?.level, 0, "a queued Slack message alone does not count when email failed");
  fail = false;
  await h.at(disk(["data"], 90));
  assert.equal((await h.store.get("data"))?.level, 90);
  assert.equal(h.dms.length, 2);
  assert.equal(h.dms[0]!.key, h.dms[1]!.key, "the outbox drops the retried message as a duplicate");
  await h.at(disk(["data"], 91));
  assert.equal(h.dms.length, 2);
});

test("an admin known only by Slack id counts as told once the message is queued", async () => {
  const h = harness({
    admins: async () => ["ops@omniloy.test", "U0SLACK"],
    mailer: {
      send: async () => {
        throw new Error("Resend rejected the message: HTTP 500");
      },
    },
  });
  await h.at(disk(["data"], 90));
  assert.equal((await h.store.get("data"))?.level, 90);
});

test("nothing is recorded when no admin could be told at all", async () => {
  const h = harness({
    admins: async () => ["ops@omniloy.test"],
    deliveries: {
      enqueue: async () => {
        throw new Error("outbox down");
      },
    },
    mailer: {
      send: async () => {
        throw new Error("Resend rejected the message: HTTP 500");
      },
    },
  });
  await h.at(disk(["data"], 90));
  assert.equal((await h.store.get("data"))?.level, 0);
});

test("a check that misses Docker on a shared disk does not make the next full check alert again", async () => {
  const h = harness({ admins: async () => ["ops@omniloy.test"] });
  await h.at(disk(["data"], 86));
  await h.at(disk(["data", "docker"], 86));
  assert.equal(h.emails.length, 1);
  assert.equal((await h.store.get("docker"))?.level, 85, "docker inherits what was already said about its disk");
  await h.at(disk(["data", "docker"], 91));
  assert.deepEqual(
    h.emails.map((m) => m.subject),
    ["Disk 86% full on mo.example.com", "Disk 91% full on mo.example.com"],
  );
});

test("without a public URL or a mailer the alert still goes out as a message naming the org", async () => {
  const h = harness();
  await checkDiskAlerts({
    filesystems: async () => [disk(["docker"], 95)],
    admins: h.deps.admins,
    store: h.store,
    deliveries: h.deps.deliveries,
    orgId: "omniloy",
  });
  assert.equal(h.emails.length, 0);
  assert.match(h.dms[0]!.text, /^Disk alert on omniloy: the disk holding Docker \(\/var\/lib\/docker\) is 95% full/);
  assert.match(h.dms[0]!.text, /free space in the admin Disk tab\.$/);
});
