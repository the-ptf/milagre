// Synthetic seeds and in-memory sockets only. Never loads service startup or identity files.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");
assert.equal(require("tweetnacl/package.json").version, "1.0.3");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../../../packages/shared/src/relay-crypto.mjs");
const cryptoUrl = `data:text/javascript;base64,${Buffer.from(source.replace('"tweetnacl"', JSON.stringify(pathToFileURL(require.resolve("tweetnacl")).href))).toString("base64")}`;
const { b64url, hostIdOf } = await import(cryptoUrl);
const roomSource = read("../../../apps/relay/src/room.mjs");
const roomUrl = `data:text/javascript;base64,${Buffer.from(roomSource.replace('"tweetnacl"', JSON.stringify(pathToFileURL(require.resolve("tweetnacl")).href)).replace('"@milagre/shared/relay-crypto"', JSON.stringify(cryptoUrl))).toString("base64")}`;
const { createRoom } = await import(roomUrl);
const hostSource = read("../../../apps/daemon/src/relay-host.cjs");
const proofStatement = hostSource.match(
  /const proof = JSON\.stringify\(\{ t: "proof", key: b64url\(identity\.sign\.publicKey\), sig: b64url\(nacl\.sign\.detached\(nonce, identity\.sign\.secretKey\)\) \}\);/,
);
assert.ok(proofStatement, "review changed Node proof source before recording");
const proofFor = Function("identity", "nonce", "nacl", "b64url", `${proofStatement[0]} return proof;`);
const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (s) => new Uint8Array(Buffer.from(s, "hex"));
function roomChecks(id, nonce, proof) {
  let ready = false;
  const messages = [],
    closed = [];
  const socket = { send: (data) => messages.push(data), close: (...args) => closed.push(args) };
  const room = createRoom({
    id,
    nonce: () => nonce,
    onHostReady: () => {
      ready = true;
    },
  });
  room.hostOpened(socket);
  room.hostMessage(socket, proof);
  return { ready, challenge: messages[0], closed };
}
const cases = [0, 1, 127, 255].map((offset) => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (offset + i) & 255);
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => (offset + i * 7) & 255);
  const sign = nacl.sign.keyPair.fromSeed(seed);
  const id = hostIdOf(sign.publicKey);
  const proof = proofFor({ sign }, nonce, nacl, b64url);
  const accepted = roomChecks(id, nonce, proof);
  assert.equal(accepted.ready, true);
  const wrong = nonce.slice();
  wrong[0] ^= 1;
  assert.equal(roomChecks(id, wrong, proof).ready, false);
  const invalid = JSON.parse(proof);
  const sig = nacl.sign.detached(nonce, sign.secretKey);
  sig[0] ^= 1;
  invalid.sig = b64url(sig);
  assert.deepEqual(roomChecks(id, nonce, JSON.stringify(invalid)).closed, [[4403, "bad-proof"]]);
  assert.equal(roomChecks("wrong-host", nonce, proof).ready, false);
  return { seed: hex(seed), nonce: hex(nonce), publicKey: hex(sign.publicKey), hostId: id, challenge: accepted.challenge, proof };
});
const hash = (s) => createHash("sha256").update(s).digest("hex");
const fixtures = { tweetnaclVersion: "1.0.3", sourceSha256: { relayCrypto: hash(source), relayHost: hash(hostSource), room: hash(roomSource) }, cases };
const fixtureUrl = new URL("./fixtures/host-proof.json", import.meta.url);
if (process.argv[2] === "--record") {
  writeFileSync(fixtureUrl, `${JSON.stringify(fixtures, null, 2)}\n`);
  console.log("Recorded synthetic Node host-proof fixtures from daemon proof statement and actual relay room.");
} else {
  assert.deepEqual(fixtures, JSON.parse(readFileSync(fixtureUrl, "utf8")), "Node proof source/fixture drift");
  if (process.argv[2]) {
    const result = spawnSync(process.argv[2], [], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.length, cases.length);
    output.forEach((c, i) => {
      assert.equal(c.hostId, cases[i].hostId);
      assert.equal(c.challenge, cases[i].challenge);
      assert.equal(c.proof, cases[i].proof);
      assert.equal(roomChecks(c.hostId, unhex(cases[i].nonce), c.proof).ready, true);
    });
    console.log(
      "Actual Node relay room accepts 4 Rust codec proofs carrying unchanged Node signatures; Rust signing/verification remains blocked on an offline Ed25519 dependency.",
    );
  }
}
