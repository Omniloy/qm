import { test } from "node:test";
import assert from "node:assert/strict";
import { collectNamedOutbound, collectOutbound, type ArtifactRegistration } from "../src/core/attachments.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../src/core/orchestrator/surface-tools.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { scopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

function fakeSandbox(files: Record<string, Uint8Array>, outboxListing: string[]): Sandbox {
  return {
    async readFileBytes(_handle: SandboxHandle, p: string) {
      return files[p] ?? null;
    },
    async listDir(_handle: SandboxHandle, _dir: string) {
      return outboxListing;
    },
  } as unknown as Sandbox;
}

const handle = { rootDir: "/root/workspace" } as SandboxHandle;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test("collectNamedOutbound: resolves workspace-relative paths into blob-backed attachments", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "outbox/cover.png": bytes("PNGDATA"), "report.pdf": bytes("PDF") }, []);
  const r = await collectNamedOutbound(sandbox, handle, ["outbox/cover.png", "report.pdf"], transfer);
  assert.equal(r.attachments.length, 2, "both named files became attachments");
  assert.deepEqual(r.attachments.map((a) => a.name).sort(), ["cover.png", "report.pdf"]);
  assert.ok(
    r.attachments.every((a) => a.blobId && a.sizeBytes > 0),
    "each attachment is blob-backed",
  );
});

test("collectNamedOutbound: rejects parent traversal before reading outside the workspace", async () => {
  const transfer = createMemoryBlobTransferStore();
  const reads: string[] = [];
  const invalid = ["../.ssh/id_ed25519", "work/../../.ssh/id_ed25519"];
  const paths = ["report.pdf", ...invalid];
  const sandbox = {
    async readFileBytes(_handle: SandboxHandle, p: string) {
      reads.push(p);
      return bytes("secret");
    },
  } as unknown as Sandbox;
  const r = await collectNamedOutbound(sandbox, handle, paths, transfer);
  assert.deepEqual(r.missing, invalid);
  assert.deepEqual(r.attachments, []);
  assert.deepEqual(reads, []);
  assert.equal(await transfer.sweep(0), 0);
});

test("collectNamedOutbound: preserves POSIX filenames containing backslashes", async () => {
  const path = String.raw`reports\..\final.txt`;
  const r = await collectNamedOutbound(
    fakeSandbox({ [path]: bytes("report") }, []),
    handle,
    [path],
    createMemoryBlobTransferStore(),
  );
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]?.name, "final.txt");
  assert.deepEqual(r.missing, []);
});

test("surface post rejects traversal before provisioning or staging any attachment", async () => {
  const calls = { provision: 0, read: 0, put: 0, grant: 0 };
  const tools = createSurfaceToolDeps({
    deps: {
      deliveries: {},
      sandbox: {
        async readFileBytes() {
          calls.read += 1;
          return bytes("file");
        },
      },
    },
    input: { surfaceTools: true },
    defaultDestination: {},
    strictReadOnly: false,
    provision: async () => {
      calls.provision += 1;
      return handle;
    },
    blobTransfer: {
      async put() {
        calls.put += 1;
        return { blobId: "blob" };
      },
    },
    fileRegistration: {
      async onRegistered() {
        calls.grant += 1;
      },
    },
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext);
  const r = await tools!.post("hello", undefined, ["report.pdf", "../.ssh/id_ed25519"]);
  assert.equal(r.ok, false);
  assert.deepEqual(calls, { provision: 0, read: 0, put: 0, grant: 0 });
});

test("collectNamedOutbound: a missing/empty path is reported (so post can fail the WHOLE call)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "outbox/there.png": bytes("X"), "outbox/blank.txt": bytes("") }, []);
  const r = await collectNamedOutbound(
    sandbox,
    handle,
    ["outbox/there.png", "outbox/gone.png", "outbox/blank.txt"],
    transfer,
  );
  assert.deepEqual(r.missing, ["outbox/gone.png"], "the unresolvable path is surfaced");
  assert.deepEqual(r.empty, ["outbox/blank.txt"], "the empty file is surfaced");
  assert.deepEqual(r.attachments, [], "no attachment survives a doomed call");
  assert.equal(await transfer.sweep(0), 0, "no orphaned transfer blob for the good file");
});

test("collectNamedOutbound: a doomed call's rollback never deletes an artifact an earlier call created (idempotent ids under a shared seed)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const register: ArtifactRegistration = {
    store,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    seed: "run-1",
  };
  const sandbox = fakeSandbox({ "outbox/first.md": bytes("delivered earlier"), "outbox/kept.md": bytes("good") }, []);
  const ok = await collectNamedOutbound(sandbox, handle, ["outbox/first.md"], transfer, register);
  assert.equal(ok.attachments.length, 1);
  const priorArtifactId = ok.attachments[0]!.artifactId!;
  assert.ok(await store.get(priorArtifactId), "post #1's artifact is registered");
  const doomed = await collectNamedOutbound(sandbox, handle, ["outbox/kept.md", "outbox/gone.md"], transfer, register);
  assert.deepEqual(doomed.missing, ["outbox/gone.md"]);
  assert.deepEqual(doomed.attachments, [], "the doomed call stages nothing");
  assert.ok(await store.get(priorArtifactId), "post #1's artifact survives post #2's rollback");
});

test("collectOutbound: harvests every outbox file (the turn-result rail for a non-surfaceTools turn)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "outbox/cover.png": bytes("A"), "outbox/leftover.txt": bytes("B") }, [
    "outbox/cover.png",
    "outbox/leftover.txt",
  ]);
  const r = await collectOutbound(sandbox, handle, transfer);
  assert.deepEqual(r.attachments.map((a) => a.name).sort(), ["cover.png", "leftover.txt"]);
});

// --- the transcript has to record what was sent ------------------------------
// Files that ride on the turn's own result get a `delivery` entry from the
// orchestrator, and that entry is the only thing the web transcript builds an
// attachment block from. Files sent through the surface tool reached their
// destination and the file library but never the transcript, so a web
// conversation showed the message with no attachments — and no way to recover
// them on reload, because nothing recorded that they were sent.

function postingTools(recorded: Array<{ text: string; names: string[] }>) {
  return createSurfaceToolDeps({
    deps: {
      deliveries: {
        async enqueue() {
          return { id: "d1" };
        },
      },
      sandbox: {
        async readFileBytes() {
          return bytes("file");
        },
      },
    },
    input: { surfaceTools: true },
    defaultDestination: { type: "web", target: "web:u1" },
    strictReadOnly: false,
    session: { id: "s1", threadRef: "web:u1:t1" },
    scopeId: scopeId("personal", "u1"),
    postProvenance: () => ({}),
    provision: async () => handle,
    blobTransfer: {
      async put() {
        return { blobId: "blob" };
      },
    },
    fileRegistration: { async onRegistered() {} },
    recordDelivery: async (text: string, attachments: ReadonlyArray<{ name: string }>) => {
      recorded.push({ text, names: attachments.map((a) => a.name) });
    },
    spine: { surfaceOutboundCount: 0, crossConversationPosts: 0 },
  } as unknown as SurfaceToolsContext);
}

test("posting with files records a delivery entry naming each one", async () => {
  const recorded: Array<{ text: string; names: string[] }> = [];
  const r = await postingTools(recorded)!.post("here they are", undefined, ["cover.png", "report.pdf"]);
  assert.equal(r.ok, true);
  assert.equal(recorded.length, 1, "one entry for the post");
  assert.equal(recorded[0]!.text, "here they are");
  assert.deepEqual(recorded[0]!.names.sort(), ["cover.png", "report.pdf"]);
});

test("posting without files records nothing — there is no attachment block to draw", async () => {
  const recorded: Array<{ text: string; names: string[] }> = [];
  const r = await postingTools(recorded)!.post("just words");
  assert.equal(r.ok, true);
  assert.deepEqual(recorded, []);
});

test("a post that never sends records nothing either", async () => {
  const recorded: Array<{ text: string; names: string[] }> = [];
  // Traversal is refused before anything is staged, so there is nothing to note.
  const r = await postingTools(recorded)!.post("sneaky", undefined, ["../.ssh/id_ed25519"]);
  assert.equal(r.ok, false);
  assert.deepEqual(recorded, []);
});
