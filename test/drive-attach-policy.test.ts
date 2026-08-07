import assert from "node:assert/strict";
import test from "node:test";
import {
  decideMountMutation,
  decideMountRead,
  parseAttachBody,
  AGENT_MAY_NOT_ATTACH,
} from "../src/mounts/attach-policy.ts";

const allow = async () => true;
const deny = async () => false;

test("an agent turn may not attach a folder, even for someone who could", async () => {
  const d = await decideMountMutation({
    triggered: true,
    principalId: "ada@example.com",
    scopeId: "project:acme",
    canUseContext: allow,
  });
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.status, 403);
  assert.equal(d.ok === false && d.message, AGENT_MAY_NOT_ATTACH);
});

test("the triggered check runs before the membership check", async () => {
  let asked = false;
  await decideMountMutation({
    triggered: true,
    principalId: "ada@example.com",
    scopeId: "project:acme",
    canUseContext: async () => {
      asked = true;
      return true;
    },
  });
  assert.equal(asked, false, "an agent turn is refused without consulting membership at all");
});

test("someone who cannot use the context cannot attach to it", async () => {
  const d = await decideMountMutation({
    triggered: false,
    principalId: "outsider@example.com",
    scopeId: "project:acme",
    canUseContext: deny,
  });
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.status, 403);
  assert.match(d.ok === false ? d.message : "", /upload files to/);
});

test("someone who can upload to the scope may attach a folder to it", async () => {
  const d = await decideMountMutation({
    triggered: false,
    principalId: "ada@example.com",
    scopeId: "project:acme",
    canUseContext: allow,
  });
  assert.equal(d.ok, true);
});

test("the authorization asks about the target scope, not the caller's own", async () => {
  const seen: Array<[string, string]> = [];
  await decideMountMutation({
    triggered: false,
    principalId: "ada@example.com",
    scopeId: "project:acme",
    canUseContext: async (p, s) => {
      seen.push([p, s]);
      return true;
    },
  });
  assert.deepEqual(seen, [["ada@example.com", "project:acme"]]);
});

test("reading the mount list is allowed on a triggered turn", async () => {
  const d = await decideMountRead({
    principalId: "ada@example.com",
    scopeId: "project:acme",
    canUseContext: allow,
  });
  assert.equal(d.ok, true, "the prompt block already tells the agent which folders are attached");
});

test("reading still requires access to the conversation", async () => {
  const d = await decideMountRead({
    principalId: "outsider@example.com",
    scopeId: "project:acme",
    canUseContext: deny,
  });
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.status, 403);
});

test("attach bodies are validated before any authorization or Drive work", () => {
  const good = parseAttachBody({ scopeId: "project:acme", externalId: "f1", name: "specs", mode: "rw" });
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok === true ? good.value : null, {
    scopeId: "project:acme",
    externalId: "f1",
    name: "specs",
    mode: "rw",
  });
});

test("each missing or malformed field is rejected with a usable reason", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ externalId: "f1", name: "specs", mode: "rw" }, /scopeId/],
    [{ scopeId: "s", name: "specs", mode: "rw" }, /externalId/],
    [{ scopeId: "s", externalId: "f1", mode: "rw" }, /name/],
    [{ scopeId: "s", externalId: "f1", name: "specs" }, /mode/],
    [{ scopeId: "s", externalId: "f1", name: "specs", mode: "sideways" }, /mode/],
    [{ scopeId: "s", externalId: "f1", name: "Bad Name", mode: "rw" }, /lowercase/],
    [{ scopeId: "s", externalId: "f1", name: "specs", mode: "rw", displayPath: 7 }, /displayPath/],
  ];
  for (const [body, expected] of cases) {
    const parsed = parseAttachBody(body);
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(body)} to be rejected`);
    assert.match(parsed.ok === false ? parsed.message : "", expected);
  }
});

test("an optional displayPath is carried through when present", () => {
  const parsed = parseAttachBody({
    scopeId: "project:acme",
    externalId: "f1",
    name: "specs",
    mode: "ro",
    displayPath: "My Drive/Product",
  });
  assert.equal(parsed.ok === true && parsed.value.displayPath, "My Drive/Product");
  assert.equal(parsed.ok === true && parsed.value.mode, "ro");
});
