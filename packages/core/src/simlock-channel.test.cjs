const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAvccRelay, createEnvelopeReader, createSimlockChannel, withSimlock, TAG } = require("./simlock-channel.cjs");

const envelope = (tag, payload = Buffer.alloc(0)) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1, 0);
  head[4] = tag;
  return Buffer.concat([head, body]);
};
const tags = (base64) => {
  const read = createEnvelopeReader();
  return read(Buffer.from(base64, "base64")).map((e) => e.tag);
};

test("envelopes split across chunks are reassembled, and a bad length ends the stream", () => {
  const read = createEnvelopeReader();
  const bytes = Buffer.concat([envelope(TAG.meta, { codec: "h264" }), envelope(TAG.keyframe, Buffer.from([1, 2, 3]))]);
  assert.deepEqual(read(bytes.subarray(0, 7)), []);
  const out = read(bytes.subarray(7));
  assert.deepEqual(
    out.map((e) => e.tag),
    [TAG.meta, TAG.keyframe],
  );
  assert.deepEqual([...out[1].payload], [1, 2, 3]);
  assert.throws(() => createEnvelopeReader()(Buffer.from([0, 0, 0, 0, 1])), /not a frame envelope/);
});

test("a current viewer gets the next deltas; one behind a keyframe restarts from the configuration", () => {
  const relay = createAvccRelay();
  relay.push(TAG.delta, envelope(TAG.delta)); // nothing to decode from yet
  assert.equal(relay.read(0), null);
  relay.push(TAG.description, envelope(TAG.description));
  relay.push(TAG.keyframe, envelope(TAG.keyframe));
  const first = relay.read(0);
  assert.equal(first.reset, true);
  assert.deepEqual(tags(first.data), [TAG.description, TAG.keyframe]);
  assert.equal(relay.read(first.sequence), null);
  relay.push(TAG.delta, envelope(TAG.delta));
  relay.push(TAG.delta, envelope(TAG.delta));
  const next = relay.read(first.sequence);
  assert.equal(next.reset, false);
  assert.deepEqual(tags(next.data), [TAG.delta, TAG.delta]);
  relay.push(TAG.keyframe, envelope(TAG.keyframe));
  relay.push(TAG.delta, envelope(TAG.delta));
  // The viewer missed the new keyframe: configuration, keyframe and its delta again.
  const behind = relay.read(next.sequence);
  assert.equal(behind.reset, true);
  assert.deepEqual(tags(behind.data), [TAG.description, TAG.keyframe, TAG.delta]);
});

test("batches stay under the relay limit but always carry a decodable start", () => {
  const relay = createAvccRelay();
  relay.push(TAG.description, envelope(TAG.description));
  relay.push(TAG.keyframe, envelope(TAG.keyframe, Buffer.alloc(1_400_000)));
  for (let i = 0; i < 4; i++) relay.push(TAG.delta, envelope(TAG.delta, Buffer.alloc(400_000)));
  const first = relay.read(0);
  assert.deepEqual(tags(first.data), [TAG.description, TAG.keyframe]);
  const second = relay.read(first.sequence);
  assert.equal(second.reset, false);
  assert.ok(Buffer.from(second.data, "base64").length <= 1_500_000);
});

class FakeSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeSocket.last = this;
  }
  send(bytes) {
    this.sent.push(bytes);
  }
  close() {
    this.readyState = 3;
  }
}

function streamResponse(chunks) {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield chunk;
      }
    })(),
  };
}
const UPSTREAM = { stream: "https://g/v1/leases/l1/stream", input: "wss://g/v1/leases/l1/input", headers: { authorization: "Bearer slk_t" } };

test("a lease channel relays video, follows the input socket's size and sends serve-sim input", async () => {
  const fetches = [];
  const channel = createSimlockChannel(UPSTREAM, {
    WebSocket: FakeSocket,
    fetch: async (url, init) => {
      fetches.push({ url, auth: init.headers.authorization });
      return streamResponse([
        envelope(TAG.meta, { codec: "h264", width: 330, height: 720, fps: 30 }),
        envelope(TAG.description),
        envelope(TAG.keyframe),
        envelope(TAG.alive),
      ]);
    },
  });
  const socket = FakeSocket.last;
  assert.equal(socket.options.headers.authorization, "Bearer slk_t");
  assert.equal(channel.status().ready, false);
  socket.emit("message", Buffer.from([0x83]), true);
  socket.emit("message", Buffer.concat([Buffer.from([0x82]), Buffer.from(JSON.stringify({ width: 1206, height: 2622, orientation: "landscape_left" }))]), true);
  const frame = await channel.frame(0, new AbortController().signal);
  assert.equal(frame.mimeType, "video/avcc");
  assert.equal(frame.reset, true);
  assert.deepEqual(fetches, [{ url: UPSTREAM.stream, auth: "Bearer slk_t" }]);
  assert.deepEqual(channel.status(), { width: 1206, height: 2622, orientation: "landscape-left", ready: true });
  channel.send({ kind: "touch", phase: "begin", points: [{ x: 0.5, y: 0.25 }] });
  channel.send({ kind: "button", button: "home" });
  assert.deepEqual(
    socket.sent.map((bytes) => [bytes[0], JSON.parse(bytes.subarray(1).toString())]),
    [
      [3, { type: "begin", x: 0.5, y: 0.25 }],
      [4, { button: "home" }],
    ],
  );
  assert.throws(() => channel.send({ kind: "hinge", angle: 90 }), /hinge/);
  await channel.close();
  assert.equal(socket.readyState, 3);
});

test("a lease's end and a refused stream reach the viewer as errors", async () => {
  const ended = createSimlockChannel(UPSTREAM, {
    WebSocket: FakeSocket,
    fetch: async () => streamResponse([envelope(TAG.meta, { codec: "h264", width: 1, height: 1 }), envelope(TAG.ended, { reason: "expired" })]),
  });
  await assert.rejects(ended.frame(0, new AbortController().signal), /lease expired/);
  assert.equal(ended.status().error, "The Simlock lease expired.");

  const refused = createSimlockChannel(UPSTREAM, {
    WebSocket: FakeSocket,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "capture program spawn EACCES" } }) }),
  });
  await assert.rejects(refused.frame(0, new AbortController().signal), /could not stream this device: capture program spawn EACCES/);
});

test("leased devices join the local list and route by id", async () => {
  const calls = [];
  const local = {
    iceServers: [],
    list: async () => [{ id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", name: "iPhone", platform: "ios", version: "27.0" }],
    connect: async (id) => calls.push(["connect", id]),
    offer: async (id) => calls.push(["offer", id]),
    closeViewer: async (id) => calls.push(["closeViewer", id]),
    repairInput: async (id) => calls.push(["repair", id]),
    stop: async () => calls.push(["stop"]),
  };
  const host = {
    leases: () => [{ deviceId: "simlock:l1", name: "iPhone 17", platform: "ios", version: "27.0" }],
    isDevice: (id) => id.startsWith("simlock:"),
    upstream: () => null,
    stop: async () => calls.push(["host stop"]),
  };
  const adapter = withSimlock(local, host);
  assert.deepEqual(
    (await adapter.list()).map((d) => [d.id, d.name]),
    [
      ["AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "iPhone"],
      ["simlock:l1", "iPhone 17 (Simlock)"],
    ],
  );
  await adapter.connect("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  await assert.rejects(adapter.connect("simlock:l1"), /lease has ended/);
  await assert.rejects(adapter.offer("simlock:l1"), /stream through Milagre/);
  await assert.rejects(adapter.repairInput("simlock:l1"), /not available for Simlock/);
  await adapter.closeViewer("simlock:l1");
  await adapter.stop();
  assert.deepEqual(calls, [["connect", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"], ["stop"], ["host stop"]]);
  // Leased devices still list when this Mac's own discovery fails.
  local.list = async () => {
    throw new Error("no Xcode");
  };
  assert.equal((await adapter.list()).length, 1);
});
