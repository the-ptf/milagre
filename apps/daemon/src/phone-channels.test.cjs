const { test } = require("node:test");
const assert = require("node:assert/strict");
const { b64url, boxKeyPair, phoneHello, phoneFinish } = require("@milagre/shared/relay-crypto");
const { createPhoneChannels, frame, OPEN, DATA, CLOSE } = require("./phone-channels.cjs");
const { random, TOKEN, sleep, until, fakePeerDaemon } = require("./relay-test-kit.cjs");
const { createTransportDiagnostics } = require("./relay-host.cjs");

const connOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(1);
const answerOk = async () => new Response('{"v":1,"result":"ok"}', { status: 200 });
const nonZero = (counts) => Object.entries(counts).filter(([, n]) => n);
const timeouts = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

/** A bridge live socket that only records what the channel does with it. */
function liveSockets() {
  const made = [];
  class Live {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.closed = null;
      this.handlers = new Map();
      made.push(this);
    }
    on(name, handler) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
      return this;
    }
    emit(name, ...args) {
      for (const handler of this.handlers.get(name) ?? []) handler(...args);
    }
    send() {}
    close(code) {
      this.closed = code;
      this.readyState = 3;
    }
  }
  return { made, Live };
}

/**
 * createPhoneChannels on a fake carrier: `sent` keeps every frame the channels hand the carrier, `store` the paired
 * devices (key -> kind). The bridge never answers unless `fetch` says otherwise.
 */
function harness({ allowComputer, openPeer, add, fetch, diagnostics, helloMs = 60_000, pendingRepeatMs = 60_000, queueWaitMs = 60_000 } = {}) {
  const host = { box: boxKeyPair(random) };
  const store = new Map();
  const phones = {
    isKnown: (key) => store.has(key),
    kindOf: (key) => store.get(key) ?? null,
    add: add ?? (async (key, { kind }) => void store.set(key, kind)),
    seen: () => {},
  };
  const lives = liveSockets();
  const channels = createPhoneChannels({
    identity: host,
    phones,
    token: TOKEN,
    bridgeUrl: "http://127.0.0.1:9",
    canPair: () => true,
    WebSocket: lives.Live,
    fetch: fetch ?? (() => new Promise(() => {})),
    random,
    helloMs,
    openPeer,
    allowComputer,
    pendingRepeatMs,
    queueWaitMs,
    diagnostics,
  });
  const sent = [];
  const session = { conns: new Map(), send: (bytes) => sent.push(bytes), queued: () => 0 };
  const h = {
    channels,
    session,
    sent,
    store,
    lives: lives.made,
    open: (conn) => channels.onFrame(session, frame(OPEN, conn)),
    data: (conn, payload) => channels.onFrame(session, frame(DATA, conn, payload)),
    close: (conn) => channels.onFrame(session, frame(CLOSE, conn)),
    /** Frames of `type` sent for `conn`, from index `from` on. */
    framesFor: (type, conn, from = 0) => sent.slice(from).filter((bytes) => bytes[0] === type && connOf(bytes) === conn),
    /** A device whose hello says `kind` ("phone" or "desktop"); `known` stores it first as the matching kind. */
    device({ kind = "phone", known = false, name = "dev" } = {}) {
      const key = boxKeyPair(random);
      if (known) store.set(b64url(key.publicKey), kind === "desktop" ? "computer" : "phone");
      const device = {
        key,
        channel: null,
        hello(conn) {
          const { message, ephemeral } = phoneHello({ phone: key, host: host.box.publicKey, token: TOKEN, random, name, kind });
          const from = sent.length;
          h.data(conn, message);
          device.finish = () => {
            const reply = h.framesFor(DATA, conn, from).find((bytes) => bytes[9] !== 0x05);
            device.channel = phoneFinish({ ephemeral, phone: key, host: host.box.publicKey, reply: reply.subarray(9) });
            return device.channel;
          };
        },
        send(conn, message) {
          h.data(conn, device.channel.seal(message));
        },
      };
      return device;
    },
  };
  return h;
}

test("a duplicate OPEN for a connection still in its hello frees the old hello timer", () => {
  const h = harness();
  const before = timeouts();
  h.open(5n);
  assert.equal(timeouts(), before + 1);
  h.open(5n);
  assert.equal(timeouts(), before + 1, "the superseded record's hello timer is cleared");
  assert.equal(h.framesFor(CLOSE, 5n).length, 0, "the conn now belongs to the new record: no CLOSE for it");
  h.close(5n);
  assert.equal(timeouts(), before);
});

test("a duplicate OPEN while a computer waits for Allow aborts the old request and stops its notices", async (t) => {
  const held = [];
  const allowComputer = (request) =>
    new Promise((resolve) => {
      held.push({ signal: request.signal, resolve });
      request.signal.addEventListener("abort", () => resolve("dropped"));
      request.waiting();
    });
  // Settles whatever is still held, so a leaked notice interval cannot outlive the test.
  t.after(() => {
    for (const request of held) request.resolve("denied");
  });
  const h = harness({ allowComputer, openPeer: fakePeerDaemon().openPeer, pendingRepeatMs: 10 });
  h.open(6n);
  h.device({ kind: "desktop" }).hello(6n);
  await until(() => h.framesFor(DATA, 6n).length >= 2, "the first record's notices");
  const old = h.session.conns.get(6n);
  h.open(6n);
  const from = h.sent.length;
  assert.equal(held[0].signal.aborted, true, "the superseded request is told to stop");
  await sleep(80);
  assert.equal(h.framesFor(DATA, 6n, from).length, 0, "no more pending notices for the superseded record");
  assert.notEqual(h.session.conns.get(6n), old);
  assert.equal(h.framesFor(CLOSE, 6n).length, 0);
  h.close(6n);
});

test("a superseded record's failed save cannot close the record that replaced it", async () => {
  let fail;
  const add = () =>
    new Promise((_resolve, reject) => {
      fail = () => reject(new Error("disk full"));
    });
  const h = harness({ add });
  h.open(7n);
  h.device({ kind: "phone" }).hello(7n); // a first pairing: waits on add
  assert.equal(typeof fail, "function");
  h.open(7n);
  const replacement = h.session.conns.get(7n);
  fail();
  await sleep(10);
  assert.equal(h.session.conns.get(7n), replacement, "the new record still holds the conn");
  assert.equal(h.framesFor(CLOSE, 7n).length, 0, "no CLOSE went out for the new record's conn");
  h.close(7n);
});

test("a duplicate OPEN for an open phone closes the old live sockets and drops its queued requests", async () => {
  const h = harness({ queueWaitMs: 40 });
  const phone = h.device({ kind: "phone", known: true });
  h.open(9n);
  phone.hello(9n);
  phone.finish();
  phone.send(9n, { t: "live-open", id: 1, path: "/live" });
  for (let id = 1; id <= 17; id++) phone.send(9n, { t: "req", id, method: "GET", path: "/rpc", headers: {}, chunk: "", more: false });
  const old = h.session.conns.get(9n);
  assert.equal(old.state, "open");
  assert.equal(h.lives.length, 1);
  assert.equal(old.queue.length, 1, "16 in flight, one waiting");
  h.open(9n);
  assert.equal(h.lives[0].closed, 1001, "the old live socket is closed");
  assert.equal(old.queue.length, 0, "the old queue is dropped with its expiry timers");
  const from = h.sent.length;
  h.lives[0].emit("message", "late");
  h.lives[0].emit("close", 1000);
  await sleep(80);
  assert.equal(h.framesFor(DATA, 9n, from).length, 0, "nothing from the old record reaches the new one's conn");
  assert.equal(h.framesFor(CLOSE, 9n).length, 0);
  h.close(9n);
});

test("a duplicate OPEN for an open computer closes its daemon connection, whose late end cannot close the new channel", () => {
  const daemon = fakePeerDaemon();
  const h = harness({ openPeer: daemon.openPeer });
  const desktop = h.device({ kind: "desktop", known: true });
  h.open(11n);
  desktop.hello(11n);
  desktop.finish();
  assert.equal(daemon.connections.length, 1);
  h.open(11n);
  assert.equal(daemon.connections[0].closed, true, "the superseded daemon connection is closed");
  const again = h.device({ kind: "desktop", known: true });
  again.hello(11n);
  again.finish();
  const replacement = h.session.conns.get(11n);
  assert.equal(replacement.state, "open");
  // The old daemon connection ends late, as a connection that noticed its carrier went away does.
  daemon.connections[0].carrier.end();
  assert.equal(h.session.conns.get(11n), replacement, "the new channel stands");
  assert.equal(daemon.connections[1].closed, false);
  assert.equal(h.framesFor(CLOSE, 11n).length, 0);
  h.close(11n);
});

test("once a connection is dropped, nothing it started keeps sending for its conn", async () => {
  const answers = [];
  const fetch = () => new Promise((resolve) => answers.push(resolve));
  const h = harness({ fetch, queueWaitMs: 30 });
  const phone = h.device({ kind: "phone", known: true });
  h.open(13n);
  phone.hello(13n);
  phone.finish();
  phone.send(13n, { t: "live-open", id: 1, path: "/live" });
  for (let id = 1; id <= 17; id++) phone.send(13n, { t: "req", id, method: "GET", path: "/rpc", headers: {}, chunk: "", more: false });
  h.close(13n); // the relay says the phone is gone
  const from = h.sent.length;
  assert.equal(h.lives[0].closed, 1001);
  h.lives[0].emit("message", "late");
  for (const answer of answers) answer(new Response("{}", { status: 200 }));
  await sleep(80);
  assert.equal(h.framesFor(DATA, 13n, from).length, 0, "no response, live message or 429 after the drop");
  assert.equal(h.framesFor(CLOSE, 13n).length, 0, "a drop the relay asked for is not echoed back");
  assert.equal(h.session.conns.size, 0);
});

test("diagnostics count a scripted sequence by message type, mark and anomaly, with no ids or payloads", async (t) => {
  const diagnostics = createTransportDiagnostics();
  const held = [];
  const allowComputer = (request) =>
    new Promise((resolve) => {
      held.push(resolve);
      request.signal.addEventListener("abort", () => resolve("dropped"));
      request.waiting();
    });
  t.after(() => {
    for (const resolve of held) resolve("denied");
  });
  const h = harness({ diagnostics: diagnostics.attach("phone"), fetch: answerOk, allowComputer, openPeer: fakePeerDaemon().openPeer });
  const conn = 123456789012345n;
  const stray = 987654321098765n;
  const phone = h.device({ kind: "phone", known: true });
  h.open(conn);
  h.open(conn); // duplicateOpen
  h.data(stray, new Uint8Array([1, 2, 3])); // dataNoConn
  phone.hello(conn); // hello in, hello out
  phone.finish();
  phone.send(conn, { t: "ping" }); // ping in, pong out
  phone.send(conn, { t: "req", id: 1, method: "POST", path: "/rpc", headers: { authorization: `Bearer ${TOKEN}` }, chunk: "", more: false });
  await until(() => diagnostics.read().out.messages.res === 1, "the response");
  phone.send(conn, { t: "live-open", id: 2, path: "/live?token=hush" });
  h.lives[0].emit("message", "from the bridge"); // live out
  phone.send(conn, { t: "live", id: 2, data: "to the bridge" });
  phone.send(conn, { t: "live-close", id: 2 });
  phone.send(conn, { t: "mystery" }); // unknown in, and the channel drops
  // A computer waiting for Allow hears one notice; a frame it sends meanwhile drops it (dataNotOpen).
  h.open(21n);
  h.device({ kind: "desktop" }).hello(21n);
  h.data(21n, new Uint8Array([9]));
  // A hello that is not one is refused with an error mark.
  h.open(22n);
  h.data(22n, new Uint8Array([7, 7, 7]));
  // An open channel that cannot read a frame drops it (dataUndecryptable).
  const other = h.device({ kind: "phone", known: true });
  h.open(23n);
  other.hello(23n);
  other.finish();
  h.data(23n, new Uint8Array(40));
  const seen = diagnostics.read();
  assert.deepEqual(nonZero(seen.in.messages), [
    ["hello", 4],
    ["req", 1],
    ["live-open", 1],
    ["live", 1],
    ["live-close", 1],
    ["ping", 1],
    ["unknown", 1],
  ]);
  assert.deepEqual(nonZero(seen.out.messages), [
    ["hello", 2],
    ["res", 1],
    ["live", 1],
    ["pong", 1],
  ]);
  assert.deepEqual(seen.out.marks, { pending: 1, error: 1 });
  assert.deepEqual(seen.anomalies, { dataNoConn: 1, dataNotOpen: 1, dataUndecryptable: 1, duplicateOpen: 1 });
  // Frames and bytes are the relay socket's to count (relay-host.cjs), never the channels'.
  assert.equal(seen.in.frames + seen.out.frames + seen.in.bytes + seen.out.bytes, 0);
  const json = JSON.stringify(seen);
  for (const secret of [TOKEN, String(conn), String(stray), conn.toString(16), b64url(phone.key.publicKey), "hush", "/rpc", "/live", "mystery", "bridge"])
    assert.ok(!json.includes(secret), secret);

  diagnostics.reset();
  const fresh = diagnostics.read();
  assert.equal(nonZero(fresh.in.messages).length + nonZero(fresh.out.messages).length + nonZero(fresh.anomalies).length, 0);
  assert.deepEqual(fresh.out.marks, { pending: 0, error: 0 });
});
