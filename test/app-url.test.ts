import { test } from "node:test";
import assert from "node:assert/strict";
import { appSubdomainOrigin, appUrlOf, type Deployment } from "../src/deploy/deploy-store.ts";

const app = (over: Partial<Pick<Deployment, "id" | "name" | "endpoint">> = {}) => ({
  id: "0f3c2a4e-1111-4222-8333-444455556666",
  name: "maria-demo",
  endpoint: null,
  ...over,
});
const links = { deployAppsDomain: "apps.mo.example.com", publicWebUrl: "https://mo.example.com/" };

test("a provider endpoint's public URL wins, with any access token stripped", () => {
  const endpoint = { host: "internal", port: 443, publicUrl: "https://maria.cluster.example/?access=tok" };
  assert.equal(appUrlOf(app({ endpoint }), links), "https://maria.cluster.example/");
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
