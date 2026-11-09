const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boxKeyPair, phoneHello, hostAccept, phoneFinish } = require("@milagre/shared/relay-crypto");
const { createFrameReader, createFrameWriter, MAX_FRAME_BYTES, PART_THRESHOLD } = require("@milagre/shared/peer-frames");
const protocol = require("./protocol.cjs");
const { openPeerChannel, PEER_BUDGET } = require("./peer-channel.cjs");
const { random, TOKEN } = require("./relay-test-kit.cjs");

/** Both ends of one encrypted channel: the Mac's and the desktop's. */
function channelPair() {
  const host = boxKeyPair(random);
  const device = boxKeyPair(random);
  const { message, ephemeral } = phoneHello({ phone: device, host: host.publicKey, token: TOKEN, random, kind: "desktop" });
  const accepted = hostAccept({ host, hello: message, isKnown: () => false, canPair: true, token: TOKEN, random });
  return { mac: accepted.channel, desktop: phoneFinish({ ephemeral, phone: device, host: host.publicKey, reply: accepted.reply }) };
}

/** A desktop's messages for one request, as it would send them. */
const rpcMessages = (json) =>
  createFrameWriter("rpc")
    .write(json)
    .map((text) => JSON.parse(Buffer.from(text).toString("utf8")));

/**
 * One desktop channel on a fake carrier, with a fake daemon connection that answers invalid() as acceptConnection does.
 * `out`: what the desktop read, opened. `state.frames`: what reached the daemon.
 */
function harness({ queued = () => 0 } = {}) {
  const { mac, desktop } = channelPair();
  const out = [];
  const state = { open: true, dropped: 0, closed: 0, frames: [], invalid: [] };
  let carrier;
  const peer = openPeerChannel({
    openPeer(given) {
      carrier = given;
      return {
        receive: (frame) => state.frames.push(frame),
        invalid(error) {
          state.invalid.push(error.code);
          carrier.send({ v: 1, id: null, error: { code: error.code, message: error.message } });
          carrier.end();
        },
        close: () => state.closed++,
      };
    },
    // The carrier seals what the channel hands it (phone-channels.cjs does, batched or not).
    deliver: (encoded) => out.push(desktop.open(mac.sealEncoded(encoded))),
    queued,
    isOpen: () => state.open,
    drop: () => {
      state.open = false;
      state.dropped++;
    },
  });
  return { peer, carrier, out, state };
}

test("an rpc message reaches the daemon connection, and its reply goes back as one evt message", () => {
  const { peer, carrier, out, state } = harness();
  peer.receive({ t: "rpc", frame: { v: 1, id: 1, method: "daemon:status", args: [] } });
  assert.deepEqual(state.frames, [{ v: 1, id: 1, method: "daemon:status", args: [] }]);
  assert.equal(carrier.send(null, '{"v":1,"id":1,"result":{"ok":true}}'), true);
  assert.equal(carrier.send({ v: 1, event: { channel: "project:state", payload: {}, seq: 1 } }), true);
  assert.deepEqual(out, [
    { t: "evt", frame: { v: 1, id: 1, result: { ok: true } } },
    { t: "evt", frame: { v: 1, event: { channel: "project:state", payload: {}, seq: 1 } } },
  ]);
});

test("a request in parts reaches the connection whole, and a reply over 768 KiB goes back in parts", () => {
  const { peer, carrier, out, state } = harness();
  const text = "ação🙂".repeat(100_000);
  for (const message of rpcMessages(JSON.stringify({ v: 1, id: 2, method: "echo", args: [text] }))) peer.receive(message);
  assert.deepEqual(state.frames, [{ v: 1, id: 2, method: "echo", args: [text] }]);
  carrier.send({ v: 1, id: 2, result: text });
  assert.ok(out.length > 1 && out.every((message) => message.t === "part"));
  const reader = createFrameReader("evt");
  assert.deepEqual(out.map((message) => reader.read(message)).at(-1), { frame: { v: 1, id: 2, result: text } });
});

test("ping gets pong, and a message outside the protocol throws for the carrier to drop the channel", () => {
  const { peer, out, state } = harness();
  peer.receive({ t: "ping" });
  assert.deepEqual(out, [{ t: "pong" }]);
  for (const message of [
    { t: "req", id: 1, method: "POST", path: "/rpc", headers: {}, chunk: "", more: false },
    { t: "live-open", id: 1, path: "/live" },
    { t: "evt", frame: {} },
    null,
  ])
    assert.throws(() => peer.receive(message), /Unknown message/);
  assert.deepEqual(state.frames, []);
});

test("a broken or oversized part answers with its error code and drops the channel", () => {
  const { peer, out, state } = harness();
  const parts = rpcMessages(JSON.stringify({ v: 1, id: 3, method: "echo", args: ["x".repeat(PART_THRESHOLD)] }));
  peer.receive(parts[1]);
  assert.deepEqual(state.invalid, ["BAD_PART"]);
  assert.equal(out.at(-1).frame.error.code, "BAD_PART");
  assert.equal(state.dropped, 1);
  const big = harness();
  big.peer.receive({ ...parts[0], n: 33 });
  assert.deepEqual(big.state.invalid, ["FRAME_TOO_LARGE"]);
  assert.equal(big.state.dropped, 1);
});

test("a reply over 16 MiB throws FRAME_TOO_LARGE, as the socket's send does, and sends nothing", () => {
  const { carrier, out } = harness();
  assert.throws(() => carrier.send(null, JSON.stringify("x".repeat(MAX_FRAME_BYTES))), { code: "FRAME_TOO_LARGE" });
  assert.deepEqual(out, []);
});

test("a desktop that falls behind by the budget is dropped instead of queued without end", () => {
  const { carrier, out, state } = harness({ queued: () => PEER_BUDGET - 100 });
  assert.equal(carrier.send({ v: 1, event: { channel: "project:state", payload: "y".repeat(200), seq: 1 } }), false);
  assert.deepEqual(out, []);
  assert.equal(state.dropped, 1);
  assert.equal(PEER_BUDGET, 2 * MAX_FRAME_BYTES);
});

test("once the channel is gone, sends return false and nothing goes out; end and destroy drop it; close closes the connection", () => {
  const { peer, carrier, out, state } = harness();
  carrier.end();
  carrier.destroy();
  assert.equal(state.dropped, 2);
  assert.equal(carrier.isClosed(), true);
  assert.equal(carrier.send({ v: 1, id: 1, result: null }), false);
  assert.deepEqual(out, []);
  peer.close();
  assert.equal(state.closed, 1);
});

test("the channel's frame limit is the daemon's", () => {
  assert.equal(MAX_FRAME_BYTES, protocol.MAX_FRAME_BYTES);
});
