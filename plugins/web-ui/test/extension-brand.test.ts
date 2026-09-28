import { test } from "node:test";
import assert from "node:assert/strict";
import { brandExtension } from "../server/extension-brand.ts";

const manifest = Buffer.from('{"name":"QM Browser Bridge","description":"Lets your QM agent drive one tab"}', "utf8");
const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("the served extension carries the configured product name", () => {
  const { entries, filename } = brandExtension(
    [
      { name: "manifest.json", data: manifest },
      { name: "popup.js", data: Buffer.from('const QM_KEY = 1; state = "Connected to QM";', "utf8") },
      { name: "icon.png", data: icon },
    ],
    "Acme Agent",
  );
  assert.equal(filename, "acme-agent-browser-bridge.zip");
  assert.equal(
    entries[0]?.data.toString("utf8"),
    '{"name":"Acme Agent Browser Bridge","description":"Lets your Acme Agent agent drive one tab"}',
  );
  assert.equal(entries[1]?.data.toString("utf8"), 'const QM_KEY = 1; state = "Connected to Acme Agent";');
  assert.equal(entries[2]?.data, icon);
});

test("without a configured name the extension ships unchanged", () => {
  const { entries, filename } = brandExtension([{ name: "manifest.json", data: manifest }], undefined);
  assert.equal(filename, "qm-browser-bridge.zip");
  assert.deepEqual(entries[0]?.data, manifest);
});

test("a label with markup or quotes cannot break the files it is written into", () => {
  const { entries, filename } = brandExtension([{ name: "manifest.json", data: manifest }], 'Evil"</script>');
  assert.equal(filename, "evilscript-browser-bridge.zip");
  assert.doesNotThrow(() => JSON.parse(entries[0]!.data.toString("utf8")));
  assert.doesNotMatch(entries[0]!.data.toString("utf8"), /[<>]/);
});
