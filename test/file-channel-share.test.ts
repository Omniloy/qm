import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOutbound, materializeInbound, type ArtifactRegistration } from "../src/core/attachments.ts";
import { defaultPublishAudience } from "../src/resolution/publish-audience.ts";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createMemoryFileArtifactStore, type FileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId, type Principal } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { principalEntitledToScope } from "../src/resolution/context-filter.ts";

const ORG = "default-org";
const initiator = "U1";
const CHANNEL = scopeId("channel", "C1");
const HANDLE = { id: "h", rootDir: "/workspace" } as SandboxHandle;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

const person = (id: string): Principal => ({ id, type: "internal" });

function memSandbox(files: Record<string, Uint8Array>): Sandbox {
  const map = new Map(Object.entries(files));
  return {
    async listDir(_h: SandboxHandle, dir: string) {
      return [...map.keys()].filter((k) => k === dir || k.startsWith(`${dir}/`));
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return map.get(rel) ?? null;
    },
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array) {
      map.set(rel, data);
    },
  } as unknown as Sandbox;
}

function registration(
  store: FileArtifactStore,
  acl: ReturnType<typeof createAclStore>,
  isPrivate: boolean | undefined,
  kind: "dm" | "channel",
): ArtifactRegistration {
  const grantees = defaultPublishAudience({
    kind,
    ...(isPrivate !== undefined ? { isPrivate } : {}),
    orgScopeId: scopeId("org", ORG),
    ownerId: initiator,
  }).grantees;
  return {
    store,
    acl,
    ownerScopeId: scopeId("personal", initiator),
    createdBy: initiator,
    createdInScope: kind === "channel" ? CHANNEL : scopeId("personal", initiator),
    seed: "run-1",
    ...(grantees.length
      ? {
          onRegistered: async ({ ownerScopeId, path }) => {
            for (const granteeScopeId of grantees) {
              await acl.grant({ ownerScopeId, ref: path, granteeScopeId, permission: "read", grantedBy: initiator });
            }
          },
        }
      : {}),
  };
}

function channelApp(files: FileArtifactStore, acl: ReturnType<typeof createAclStore>) {
  const identity = {
    classify: (id: string) => ({ id, type: "internal" }),
    isInternal: (p: { type: string }) => p.type === "internal",
  };
  const directory = {
    listChannelsFor: async (principalId: string) =>
      principalId === "U1" || principalId === "U2" ? [{ channelId: "C1", name: "eng", isPrivate: true }] : [],
    channelMember: async (channelId: string, principalId: string) =>
      channelId === "C1" && (principalId === "U1" || principalId === "U2"),
  };
  return createApp({
    acl,
    files,
    identity,
    directory,
    sessions: { listByParticipant: async () => [] },
    auditLog: { record: () => undefined },
  } as unknown as AppDeps);
}

function makeApp(files: FileArtifactStore, acl: ReturnType<typeof createAclStore>) {
  return createApp({ acl, files, identity: createIdentityService() } as unknown as AppDeps);
}

test("a file delivered in a PUBLIC channel is auto-shared (read) with the org — visible to other members", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  await collectOutbound(
    memSandbox({ "outbox/flag.png": PNG }),
    HANDLE,
    createMemoryBlobTransferStore(),
    registration(files, acl, false, "channel"),
  );

  const u1 = await makeApp(files, acl).listFilesForViewer(initiator);
  assert.equal(u1.owned.length, 1);
  assert.equal(u1.owned[0]!.name, "flag.png");

  const app = makeApp(files, acl);
  const u2 = await app.listFilesForViewer("U2");
  assert.equal(u2.owned.length, 0, "U2 doesn't own it");
  assert.equal(u2.shared.length, 1, "the org read grant surfaces it to U2");
  const opened = await app.openFileForViewer(u2.shared[0]!.id, "U2");
  assert.ok(opened, "the org grant authorizes the bytes");
});

test("a file delivered in a DM stays owner-only — no auto-share", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  await collectOutbound(
    memSandbox({ "outbox/note.txt": Buffer.from("private") }),
    HANDLE,
    createMemoryBlobTransferStore(),
    registration(files, acl, undefined, "dm"),
  );

  assert.equal((await makeApp(files, acl).listFilesForViewer(initiator)).owned.length, 1, "owner sees it");
  const u2 = await makeApp(files, acl).listFilesForViewer("U2");
  assert.equal(u2.owned.length + u2.shared.length, 0, "nobody else sees a DM file");
});

test("a file attached on a channel turn is readable by the channel's own agent (outbound, isPrivate undefined)", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  await collectOutbound(
    memSandbox({ "outbox/plan.png": PNG }),
    HANDLE,
    createMemoryBlobTransferStore(),
    registration(files, acl, undefined, "channel"),
  );

  const handles = await acl.handlesForAudience(
    [person("U1"), person("U2")],
    CHANNEL,
    scopeId("org", ORG),
    principalEntitledToScope,
  );
  assert.equal(handles.length, 1, "the createdInScope grant surfaces the file to the channel agent");
  assert.equal(handles[0]!.handlePath, "shared/plan.png");
  assert.equal(handles[0]!.ownerScopeId, scopeId("personal", initiator));
});

test("a file attached on a channel turn is readable by the channel's own agent (inbound)", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  const transfer = createMemoryBlobTransferStore();
  const { blobId } = await transfer.put(PNG);
  await materializeInbound(
    memSandbox({}),
    HANDLE,
    [{ name: "shared.png", mimetype: "image/png", sizeBytes: PNG.length, blobId }],
    transfer,
    registration(files, acl, undefined, "channel"),
  );

  const handles = await acl.handlesForAudience(
    [person("U1"), person("U2")],
    CHANNEL,
    scopeId("org", ORG),
    principalEntitledToScope,
  );
  assert.equal(handles.length, 1, "an inbound channel attachment is granted to the channel scope too");
  assert.equal(handles[0]!.handlePath, "shared/shared.png");
});

test("a DM attachment gets no channel/group grant", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  await collectOutbound(
    memSandbox({ "outbox/note.txt": Buffer.from("private") }),
    HANDLE,
    createMemoryBlobTransferStore(),
    registration(files, acl, undefined, "dm"),
  );

  const shared = (await acl.list()).filter((g) => {
    const kind = g.granteeScopeId.split(":")[0];
    return kind === "channel" || kind === "group";
  });
  assert.equal(shared.length, 0, "a DM attachment never grants to a channel or group scope");
});

test("the turn-attachment path and the Files-view upload produce the same channel grant", async () => {
  const turnFiles = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const turnAcl = createAclStore();
  await collectOutbound(
    memSandbox({ "outbox/brief.pdf": PNG }),
    HANDLE,
    createMemoryBlobTransferStore(),
    registration(turnFiles, turnAcl, undefined, "channel"),
  );
  const turnGrants = (await turnAcl.list()).filter((g) => g.granteeScopeId === CHANNEL);

  const uploadFiles = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const uploadAcl = createAclStore();
  async function* one(data: Uint8Array) {
    yield data;
  }
  await channelApp(uploadFiles, uploadAcl).uploadFileForViewer(initiator, {
    scopeId: CHANNEL,
    name: "brief.pdf",
    mimetype: "application/pdf",
    data: one(PNG),
  });
  const uploadGrants = (await uploadAcl.list()).filter((g) => g.granteeScopeId === CHANNEL);

  assert.equal(turnGrants.length, 1, "the turn path grants read to the channel scope");
  assert.equal(uploadGrants.length, 1, "the upload path grants read to the channel scope");
  const shape = (g: (typeof turnGrants)[number]) => ({
    ownerScopeId: g.ownerScopeId,
    granteeScopeId: g.granteeScopeId,
    permission: g.permission,
    grantedBy: g.grantedBy,
  });
  assert.deepEqual(shape(turnGrants[0]!), shape(uploadGrants[0]!));
});
