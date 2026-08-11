import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeZip } from "../server/zip.ts";

test("the archive is a real zip that unzip can extract byte-for-byte", () => {
  // A hand-rolled writer is only worth trusting if the system `unzip` reads it,
  // so this round-trips through the actual tool rather than re-parsing our own
  // bytes with our own assumptions.
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"name":"MiniOmni"}\n', "utf8") },
    { name: "background.js", data: Buffer.from("console.log('hi');\n", "utf8") },
  ];
  const zip = makeZip(entries);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "starts with a local file header");

  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  try {
    const path = join(dir, "a.zip");
    writeFileSync(path, zip);
    // `unzip -l` fails loudly on a malformed archive; extraction proves content.
    execFileSync("unzip", ["-o", "-q", path, "-d", join(dir, "out")]);
    for (const e of entries) {
      assert.deepEqual(readFileSync(join(dir, "out", e.name)), e.data, `${e.name} round-trips`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty archive is still a valid zip", () => {
  const zip = makeZip([]);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, "ends with the end-of-central-directory record");
});
