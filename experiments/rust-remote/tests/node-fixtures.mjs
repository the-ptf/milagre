// Synthetic keys only. Imports actual production functions; never starts a service.
// NODE_PATH may point at an existing dependency installation if this worktree has none.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as peer from "../../../packages/shared/src/peer-frames.mjs";
const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");
const tweetnaclVersion = require("tweetnacl/package.json").version;
assert.equal(tweetnaclVersion, "1.0.3", "fixtures require the repository-pinned tweetnacl 1.0.3");
const source = readFileSync(new URL("../../../packages/shared/src/relay-crypto.mjs", import.meta.url), "utf8");
// Only resolve the existing import; all protocol function bodies remain unchanged.
const resolved = source.replace('"tweetnacl"', JSON.stringify(pathToFileURL(require.resolve("tweetnacl")).href));
const crypto = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
const channelSource = readFileSync(new URL("../../../apps/daemon/src/phone-channels.cjs", import.meta.url), "utf8");
const frameSource = channelSource.match(/function frame\(type, conn, payload = new Uint8Array\(\)\) \{[\s\S]*?\n\}/)[0];
const frame = Function(`${frameSource}; return frame;`)();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (text) => new Uint8Array(Buffer.from(text, "hex"));
const sequence = (seed) => (n) => Uint8Array.from({ length: n }, () => seed++ & 255);
const host = nacl.box.keyPair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const phone = nacl.box.keyPair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, i) => i + 33));
const token = "synthetic-token-never-a-pairing-secret";
const cases = [
  { options: {}, clientSeed: 64, hostSeed: 128 },
  {
    options: {
      name: " \u202eLab\u0000 phone 🧪 ",
      kind: "phone",
      caps: ["batch"],
    },
    clientSeed: 192,
    hostSeed: 32,
  },
  {
    options: {
      name: "  Desktop ",
      kind: "desktop",
      caps: ["batch", "x".repeat(33), "🧪".repeat(16), "🧪".repeat(17)],
    },
    clientSeed: 80,
    hostSeed: 160,
  },
];
const phoneTexts = [
  '{"t":"ping"}',
  '{"t":"req","id":1,"method":"GET","path":"/snapshot","headers":{},"chunk":"","more":false}',
  '{"t":"rpc","frame":{"v":1,"id":2,"method":"test"}}',
];
const hostTexts = [
  '{"t":"pong"}',
  '{"t":"batch","items":[{"t":"live","id":1,"data":"hello 🧪"},{"t":"live-close","id":1,"code":1000}]}',
  '{"t":"evt","frame":{"v":1,"id":2,"result":null}}',
];
function handshake(c) {
  const pending = crypto.phoneHello({
    phone,
    host: host.publicKey,
    token,
    random: sequence(c.clientSeed),
    ...c.options,
  });
  const accepted = crypto.hostAccept({
    host,
    hello: pending.message,
    token,
    isKnown: () => false,
    canPair: true,
    random: sequence(c.hostSeed),
  });
  const client = crypto.phoneFinish({
    phone,
    host: host.publicKey,
    ephemeral: pending.ephemeral,
    reply: accepted.reply,
  });
  return { pending, accepted, client };
}
const invalidHellos = (() => {
  const { pending } = handshake(cases[0]);
  const inner = { token, eph: crypto.b64url(pending.ephemeral.publicKey) };
  const inputs = [
    { label: "missing-token", value: { eph: inner.eph } },
    { label: "wrong-token-type", value: { ...inner, token: false } },
    {
      label: "wrong-token-before-kind",
      value: { ...inner, token: "wrong", kind: "computer" },
    },
    { label: "missing-eph", value: { token } },
    { label: "altered-eph", value: { ...inner, eph: "wrong" } },
    { label: "unknown-kind", value: { ...inner, kind: "computer" } },
    { label: "null-kind", value: { ...inner, kind: null } },
    { label: "null-inner", value: null },
    { label: "array-inner", value: [] },
    { label: "populated-positional-array", value: [token, inner.eph, null, [], "phone"] },
  ];
  return inputs.map(({ label, value }) => {
    const boxed = nacl.box(new TextEncoder().encode(JSON.stringify(value)), pending.message.slice(65, 89), host.publicKey, phone.secretKey);
    const hello = new Uint8Array([...pending.message.slice(0, 89), ...boxed]);
    let error;
    try {
      crypto.hostAccept({
        host,
        hello,
        token,
        isKnown: () => false,
        canPair: true,
        random: sequence(128),
      });
    } catch (e) {
      error = e.code;
    }
    assert.ok(error, label);
    return { label, hello: hex(hello), error };
  });
})();
const callbacks = [false, true].flatMap((known) =>
  [false, true].map((pairable) => {
    const { pending } = handshake(cases[0]);
    const calls = [];
    let error = null,
      firstPairing = null;
    try {
      const accepted = crypto.hostAccept({
        host,
        hello: pending.message,
        token,
        isKnown: (id) => {
          calls.push(["known", id]);
          return known;
        },
        canPair: (id) => {
          calls.push(["pair", id]);
          return pairable;
        },
        random: sequence(128),
      });
      firstPairing = accepted.firstPairing;
    } catch (e) {
      error = e.code;
    }
    return { known, pairable, calls, error, firstPairing };
  }),
);
const invalidAccepts = (() => {
  const { pending, accepted } = handshake(cases[0]);
  const inner = JSON.parse(new TextDecoder().decode(nacl.box.open(accepted.reply.slice(57), accepted.reply.slice(33, 57), host.publicKey, phone.secretKey)));
  const boxed = nacl.box(new TextEncoder().encode(JSON.stringify([inner.eph, inner.peer])), accepted.reply.slice(33, 57), phone.publicKey, host.secretKey);
  const reply = new Uint8Array([...accepted.reply.slice(0, 57), ...boxed]);
  assert.throws(() => crypto.phoneFinish({ ephemeral: pending.ephemeral, phone, host: host.publicKey, reply }));
  return [{ label: "positional-accept-array", reply: hex(reply) }];
})();
const fixtures = {
  tweetnaclVersion,
  callbacks,
  invalidAccepts,
  invalidHellos,
  sourceSha256: {
    relayCrypto: hash(source),
    phoneChannels: hash(channelSource),
    peerFrames: hash(readFileSync(new URL("../../../packages/shared/src/peer-frames.mjs", import.meta.url))),
  },
  token,
  hostSecret: hex(host.secretKey),
  phoneSecret: hex(phone.secretKey),
  phoneTexts,
  hostTexts,
  cases: cases.map((c) => {
    const { pending, accepted, client } = handshake(c);
    return {
      ...c,
      hello: hex(pending.message),
      reply: hex(accepted.reply),
      device: {
        key: accepted.phoneKey,
        first_pairing: accepted.firstPairing,
        kind: accepted.kind,
        name: accepted.name,
        caps: accepted.caps,
      },
      phoneFrames: phoneTexts.map((text) => hex(client.sealEncoded(new TextEncoder().encode(text)))),
      hostFrames: hostTexts.map((text) => hex(accepted.channel.sealEncoded(new TextEncoder().encode(text)))),
    };
  }),
  envelopes: [1, 2, 3, 4, 5, 6, 7].map((type) => {
    const conn = type >= 4 ? 0n : 0xfedcba9876543210n;
    return {
      type,
      conn: conn.toString(),
      payload: "030001ff",
      encoded: hex(frame(type, conn, bytes("030001ff"))),
    };
  }),
  // Store hashes for large exact bytes, not megabytes of repeated fixture content.
  peerCases: [2, 768 * 1024, 768 * 1024 + 1, 1024 * 1024, 16 * 1024 * 1024].flatMap((size) =>
    ["rpc", "evt"].map((kind) => {
      const json = '"' + "x".repeat(size - 2) + '"';
      return {
        size,
        kind,
        hashes: peer.createFrameWriter(kind).write(json).map(hash),
      };
    }),
  ),
};
const fixturePath = new URL("./fixtures/node.json", import.meta.url);
if (process.argv.includes("--record")) {
  writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + "\n");
  console.log("Recorded synthetic fixtures from actual Node implementations.");
} else {
  assert.deepEqual(JSON.parse(readFileSync(fixturePath)), fixtures, "production contract changed; review before re-recording");
  const binary = process.argv[2];
  assert.ok(binary, "usage: node tests/node-fixtures.mjs <Rust conformance example binary>");
  const run = spawnSync(binary, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const rust = JSON.parse(run.stdout);
  for (const [i, c] of fixtures.cases.entries()) {
    const actual = rust.cases[i];
    assert.equal(actual.hello, c.hello);
    assert.equal(actual.reply, c.reply);
    const accepted = crypto.hostAccept({
      host,
      hello: bytes(actual.hello),
      token,
      isKnown: () => false,
      canPair: true,
      random: sequence(c.hostSeed),
    });
    const pending = crypto.phoneHello({
      phone,
      host: host.publicKey,
      token,
      random: sequence(c.clientSeed),
      ...c.options,
    });
    const client = crypto.phoneFinish({
      phone,
      host: host.publicKey,
      ephemeral: pending.ephemeral,
      reply: bytes(actual.reply),
    });
    actual.phoneFrames.forEach((f, j) => assert.deepEqual(accepted.channel.open(bytes(f)), JSON.parse(phoneTexts[j])));
    actual.hostFrames.forEach((f, j) => assert.deepEqual(client.open(bytes(f)), JSON.parse(hostTexts[j])));
    assert.deepEqual(actual.phoneFrames, c.phoneFrames);
    assert.deepEqual(actual.hostFrames, c.hostFrames);
  }
  for (const kind of ["rpc", "evt"]) {
    const reader = peer.createFrameReader(kind);
    let got;
    for (const text of rust.parts[kind]) got = reader.read(JSON.parse(text));
    assert.equal(got.frame, "🧪".repeat(200000));
  }
  assert.deepEqual(
    rust.envelopes,
    fixtures.envelopes.map((e) => e.encoded),
  );
  assert.deepEqual(
    rust.peerHashes,
    fixtures.peerCases.map((c) => c.hashes),
  );
  console.log("Node accepts Rust hello/accept, 18 encrypted messages, both fragmented directions and 7 envelopes; all 10 boundary frame hashes match.");
}
