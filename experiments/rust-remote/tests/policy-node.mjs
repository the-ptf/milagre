// Actual Node window predicates + NaCl handshake. Synthetic memory-only records, no service start.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");
assert.equal(require("tweetnacl/package.json").version, "1.0.3");
const source = readFileSync(new URL("../../../apps/daemon/src/phone.cjs", import.meta.url), "utf8");
const cryptoSource = readFileSync(new URL("../../../packages/shared/src/relay-crypto.mjs", import.meta.url), "utf8");
const resolved = cryptoSource.replace('"tweetnacl"', JSON.stringify(pathToFileURL(require.resolve("tweetnacl")).href));
const crypto = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
const open = source.match(/  const openPairing = \(\) => \{[^]*?\n  \};/)[0];
const may = source.match(/  function mayPair\(key\) \{[^]*?\n  \}/)[0];
const window = Function(`
let time=1, pairingUntil=0, pairingOpenedAt=0;
const now=()=>time, PAIRING_WINDOW_MS=600000, removed=new Map();
const relayPhones={removedAt:key=>removed.get(key)??null};
${open}
${may}
return {openPairing,mayPair,setTime:t=>time=t,remove:key=>removed.set(key,time)};
`)();
const host = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(1));
const token = "synthetic-policy-token-never-real",
  records = new Map();
function accept(seed, kind) {
  const phone = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(seed));
  let byte = seed;
  const random = (n) => Uint8Array.from({ length: n }, () => byte++ & 255);
  const pending = crypto.phoneHello({ phone, host: host.publicKey, token, kind, random });
  const accepted = crypto.hostAccept({ host, hello: pending.message, token, isKnown: (key) => records.has(key), canPair: window.mayPair, random });
  records.set(accepted.phoneKey, kind);
  crypto.phoneFinish({ phone, host: host.publicKey, ephemeral: pending.ephemeral, reply: accepted.reply });
  return accepted;
}
window.openPairing();
const devices = [
  [2, "phone"],
  [3, "phone"],
  [4, "desktop"],
  [5, "desktop"],
].map(([seed, kind]) => accept(seed, kind));
const firstPairing = devices.map((d) => d.firstPairing);
assert.deepEqual(firstPairing, [true, true, true, true]);
// This is crypto + mayPair coverage. Owner approval/persistence stay separate in Rust tests.
window.remove(devices[0].phoneKey);
const removedSameWindow = window.mayPair(devices[0].phoneKey);
window.openPairing();
assert.equal(window.mayPair(devices[0].phoneKey), false);
window.setTime(2);
window.openPairing();
const removedNextWindow = window.mayPair(devices[0].phoneKey);
window.setTime(600002);
assert.equal(window.mayPair(devices[1].phoneKey), false);
const knownAfterWindow = accept(3, "phone").firstPairing;
const fixture = {
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  cryptoSha256: createHash("sha256").update(cryptoSource).digest("hex"),
  tweetnaclVersion: "1.0.3",
  firstPairing,
  removedSameWindow,
  removedNextWindow,
  knownAfterWindow,
};
const path = new URL("./fixtures/policy-node.json", import.meta.url);
if (process.argv[2] === "--record") writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
else {
  assert.deepEqual(fixture, JSON.parse(readFileSync(path, "utf8")));
  console.log("Actual Node multi-device window/removal predicates and known reconnect match fixture; approval remains a service decision.");
}
