// Execute actual devices.cjs with a closed in-memory fs/identity dependency set.
// No service startup graph, existing profile, real pairing material or network.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import vm from "node:vm";
import path from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");
assert.equal(require("tweetnacl/package.json").version, "1.0.3");
const source = readFileSync(new URL("../../../apps/daemon/src/devices.cjs", import.meta.url), "utf8");
const root = "/synthetic-memory-only";
const files = new Map();
const file = path.join(root, "devices.json");
function check(p) {
  assert.ok([file, path.join(root, "relay-phones.json")].includes(p));
}
const fs = {
  async readFile(p) {
    check(p);
    if (!files.has(p)) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
    return files.get(p);
  },
  async rm(p) {
    check(p);
    files.delete(p);
  },
};
const module = { exports: {} };
const imports = new Map([
  ["node:fs/promises", fs],
  ["node:path", path],
  ["@milagre/core/private-files", { assertPrivate: check }],
  [
    "./relay-identity.cjs",
    {
      async writePrivate(p, value) {
        check(p);
        files.set(p, JSON.stringify(value));
      },
    },
  ],
]);
const context = vm.createContext({
  module,
  require(name) {
    assert.ok(imports.has(name));
    return imports.get(name);
  },
});
new vm.Script(source).runInContext(context, { timeout: 1000 });
let now = 1;
const create = () => module.exports.createDevices(root, { now: () => now });
const key = (seed) => Buffer.from(nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(seed)).publicKey).toString("base64url");
const a = create();
await a.load();
await a.add(key(1), { name: "Synthetic \ud800 \ue000" });
await a.add(key(2), { kind: "computer", name: "Synthetic computer" });
const serialized = JSON.parse(files.get(file));
const b = create();
await b.load();
assert.equal(b.kindOf(key(1)), "phone");
assert.equal(b.kindOf(key(2)), "computer");
const notices = await b.takeNotices();
assert.equal(notices.devices.length, 1);
now = 2;
await b.remove(key(1));
const afterRemove = JSON.parse(files.get(file));
const c = create();
await c.load();
assert.equal(c.removedAt(key(1)), 2);
now = 3;
await c.add(key(1));
assert.equal(c.removedAt(key(1)), null);
const afterRepair = JSON.parse(files.get(file));
files.set(file, "malformed synthetic snapshot");
const dirty = create();
await dirty.load();
assert.equal(dirty.count(), 0);
const fixture = {
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  tweetnaclVersion: "1.0.3",
  serialized,
  afterRemove,
  afterRepair,
  malformedLoadsEmpty: dirty.count() === 0,
};
const destination = new URL("./fixtures/restart-node.json", import.meta.url);
if (process.argv[2] === "--record") writeFileSync(destination, JSON.stringify(fixture, null, 2) + "\n");
else {
  assert.deepEqual(fixture, JSON.parse(readFileSync(destination, "utf8")));
  console.log("Actual Node device serialization/reload/removal fixture matches; Rust disk format, metadata, epochs and dirty recovery deliberately differ.");
}
