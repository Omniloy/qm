import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSubdomainOrigin, appUrlOf, createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createApp } from "../src/api/app.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";

const app = (over: Partial<Pick<Deployment, "id" | "name" | "endpoint">> = {}) => ({
  id: "0f3c2a4e-1111-4222-8333-444455556666",
  name: "maria-demo",
  endpoint: null,
  ...over,
});
const links = { deployAppsDomain: "apps.mo.example.com", publicWebUrl: "https://mo.example.com/" };

test("the apps-domain subdomain wins over a stale endpoint URL, so a renamed app links to its current name", () => {
  const endpoint = { host: "internal", port: 443, publicUrl: "https://old-name.apps.mo.example.com/" };
  assert.equal(appUrlOf(app({ endpoint }), links), "https://maria-demo.apps.mo.example.com/");
});

test("without an apps domain a provider endpoint's public URL wins, with any access token stripped", () => {
  const endpoint = { host: "internal", port: 443, publicUrl: "https://maria.cluster.example/?access=tok" };
  assert.equal(appUrlOf(app({ endpoint }), { publicWebUrl: links.publicWebUrl }), "https://maria.cluster.example/");
});

test("an apps domain links the app on its own subdomain", () => {
  assert.equal(appUrlOf(app(), links), "https://maria-demo.apps.mo.example.com/");
  assert.equal(
    appUrlOf(app({ name: undefined }), links),
    "https://0f3c2a4e-1111-4222-8333-444455556666.apps.mo.example.com/",
    "an unnamed app uses its id",
  );
});

test("without an apps domain the link is the signed-in /d/ path on the public web URL", () => {
  assert.equal(appUrlOf(app(), { publicWebUrl: "https://mo.example.com//" }), "https://mo.example.com/d/maria-demo/");
  assert.equal(appUrlOf(app(), {}), "/d/maria-demo/");
});

test("a ref that is not a DNS label never becomes a subdomain", () => {
  assert.equal(appSubdomainOrigin(app({ name: "Bad_Name" }), links.deployAppsDomain), undefined);
  assert.equal(appSubdomainOrigin(app({ name: "-edge" }), links.deployAppsDomain), undefined);
  assert.equal(appUrlOf(app({ name: "Bad_Name" }), links), "https://mo.example.com/d/Bad_Name/");
  assert.equal(appSubdomainOrigin(app(), undefined), undefined);
});

test("after a rename, share notices, invitations and the app list all link the current name", async () => {
  const notices: string[] = [];
  const invitations: string[] = [];
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async (d) => ({ host: "10.0.0.1", port: 443, publicUrl: `https://${d.name}.apps.example.com/` }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "app-url-")),
    deployAppsDomain: "apps.example.com",
    publicWebUrl: "https://qm.example.com",
    deliveries: {
      enqueue: async (delivery: { text?: string }) => {
        notices.push(delivery.text ?? "");
        return delivery;
      },
    } as never,
  });
  const app = createApp({
    deploy,
    identity: createIdentityService(),
    inviteMailer: {
      async send(message: { text: string }) {
        invitations.push(message.text);
        return "message-id";
      },
    },
  } as unknown as Parameters<typeof createApp>[0]);
  const d = await app.deploy({
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    entrypoint: "x",
    files: [],
    name: "old-name",
  });
  await app.renameDeployment(d.id, "new-name");
  const current = "https://new-name.apps.example.com/";

  await app.shareDeployment(d.id, "personal:U2", "read", { createdBy: "U1" });
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Open it: https:\/\/new-name\.apps\.example\.com\//);
  const invited = await app.inviteToDeployment(d.id, "guest@example.com", "U1");
  assert.equal(invited.invitation.appUrl, current);
  assert.match(invitations[0] ?? "", /https:\/\/new-name\.apps\.example\.com\//);
  const [listed] = await app.listDeploymentsForViewer("U1");
  assert.equal(listed?.url, current);
  assert.doesNotMatch(JSON.stringify([notices, invitations, listed]), /old-name/);
});
