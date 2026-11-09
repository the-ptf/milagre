const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { boxKeyPair, b64url, hostAccept } = require("@milagre/shared/relay-crypto");
const { createFrameReader, createFrameWriter } = require("@milagre/shared/peer-frames");
const { connectPeer, PeerError } = require("./peer-client.cjs");

const random = (n) => new Uint8Array(randomBytes(n));
const TOKEN = "a".repeat(64);
const encoder = new TextEncoder();
const STATUS = { version: "9.8.7", methods: ["project:recent"], capabilities: ["desktop-v1", "desktop-peer-v1"] };
const echo = (frame) => ({ v: 1, id: frame.id, result: frame.method === "daemon:status" ? STATUS : { echo: frame.args } });

async function until(check, label) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * A Mac at the other end of an in-memory socket: it reads the hello with the real hostAccept, then answers each daemon
 * frame as `answer(frame)` says ("close" closes the socket as a Mac from before PR 1 does). `hello`: "accept", "pending"
 * (accept later with mac.accept()), "full" (the relay's 4429), or a refusal body.
 */
function fakeMac({ hello = "accept", answer = echo } = {}) {
  const host = boxKeyPair(random);
  const mac = { hostKey: b64url(host.publicKey), sockets: [], hellos: [], accept: () => {} };
  mac.createSocket = (url) => {
    const reader = createFrameReader("rpc");
    const writer = createFrameWriter("evt");
    let channel = null;
    const target = new EventTarget();
    const socket = {
      url,
      binaryType: "",
      addEventListener: target.addEventListener.bind(target),
      emit(type, event = {}) {
        target.dispatchEvent(Object.assign(new Event(type), event));
      },
      closed: null,
      deliver(bytes) {
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        queueMicrotask(() => socket.emit("message", { data }));
      },
      closeWith(code) {
        if (socket.closed) return;
        socket.closed = code;
        queueMicrotask(() => socket.emit("close", { code }));
      },
      close() {
        socket.closeWith(1000);
      },
      push(event) {
        for (const text of writer.write(JSON.stringify({ v: 1, event }))) socket.deliver(channel.sealEncoded(text));
      },
      sent: 0,
      send(bytes) {
        if (socket.closed) throw new Error("closed");
        socket.sent++;
        if (!channel) {
          if (hello === "full") return socket.closeWith(4429);
          if (typeof hello === "object") return socket.deliver(new Uint8Array([0x04, ...encoder.encode(JSON.stringify({ t: "error", ...hello }))]));
          const accepted = hostAccept({ host, hello: bytes, isKnown: () => false, canPair: true, token: TOKEN, random });
          // A reply the pinned host did not seal: random bytes after ACCEPT, or the real reply with one byte flipped.
          if (hello === "forged") return socket.deliver(new Uint8Array([0x02, ...random(200)]));
          if (hello === "tampered") {
            const reply = new Uint8Array(accepted.reply);
            reply[reply.length - 1] ^= 0xff;
            return socket.deliver(reply);
          }
          mac.hellos.push({ kind: accepted.kind, name: accepted.name });
          mac.accept = () => {
            socket.deliver(accepted.reply);
            channel = accepted.channel;
          };
          if (hello === "pending") socket.deliver(new Uint8Array([0x05, ...encoder.encode('{"t":"pending"}')]));
          else mac.accept();
          return;
        }
        const message = channel.open(bytes);
        if (message.t === "ping") return socket.deliver(channel.seal({ t: "pong" }));
        const read = reader.read(message);
        if (!read) return;
        const reply = answer(read.frame);
        if (reply === "close") return socket.closeWith(1000);
        // A promise answers later, as a slow call does.
        void Promise.resolve(reply).then((value) => {
          if (value && !socket.closed) for (const text of writer.write(JSON.stringify(value))) socket.deliver(channel.sealEncoded(text));
        });
      },
    };
    mac.sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  };
  return mac;
}

const dial = (mac, options = {}) =>
  connectPeer({
    url: "wss://relay.test/",
    hostId: "h".repeat(22),
    hostKey: mac.hostKey,
    token: TOKEN,
    identity: boxKeyPair(random),
    name: "desk",
    createSocket: mac.createSocket,
    ...options,
  });

test("the hello says desktop and its name, daemon calls go out as rpc and come back, events arrive", async (t) => {
  const mac = fakeMac();
  const client = await dial(mac);
  t.after(() => client.close());
  assert.equal(mac.sockets[0].url, `wss://relay.test/v1/phone?id=${"h".repeat(22)}`);
  assert.deepEqual(mac.hellos, [{ kind: "desktop", name: "desk" }]);
  assert.deepEqual(client.status, STATUS);
  assert.deepEqual(await client.call("project:recent", [1]), { echo: [1] });
  // Past 768 KiB both ways: parts out, parts back, through the 512 KiB pieces.
  const big = "ação🙂".repeat(150_000);
  assert.deepEqual(await client.call("echo", [big]), { echo: [big] });
  const events = [];
  client.on("event", (event) => events.push(event));
  mac.sockets[0].push({ channel: "project:state", payload: { path: "/p" }, seq: 3 });
  await until(() => events.length === 1, "the event");
  assert.deepEqual(events, [{ channel: "project:state", payload: { path: "/p" }, seq: 3 }]);
});

test("a Mac holding a first pairing says so, and the desktop waits until it is allowed", async (t) => {
  const mac = fakeMac({ hello: "pending" });
  let pending = 0;
  let done = false;
  const connecting = dial(mac, { onPending: () => pending++ }).then((client) => {
    done = true;
    return client;
  });
  await until(() => pending === 1, "the pending notice");
  await delay(50);
  assert.equal(done, false, "still waiting for Allow");
  mac.accept();
  const client = await connecting;
  t.after(() => client.close());
  assert.equal(pending, 1);
});

test("each refusal reads as its code, final when retrying can't help", async () => {
  for (const [hello, code, final] of [
    [{ code: "unknown-phone" }, "unknown-phone", true],
    [{ code: "unknown-phone", reason: "denied" }, "denied", true],
    [{ code: "unknown-phone", reason: "busy" }, "busy", false],
    [{ code: "bad-token", reason: "reset" }, "reset", true],
    [{ code: "bad-token" }, "bad-token", true],
    [{ code: "bad-hello", reason: "kind" }, "kind", true],
    [{ code: "bad-hello" }, "bad-hello", false],
    ["full", "full", false],
  ]) {
    await assert.rejects(dial(fakeMac({ hello })), (error) => {
      assert.ok(error instanceof PeerError, code);
      assert.equal(error.code, code);
      assert.equal(error.final, final, code);
      return true;
    });
  }
});

test("a Mac from before paired desktops, closing on the first rpc, reads as outdated, as does one without desktop-peer-v1", async () => {
  await assert.rejects(dial(fakeMac({ answer: () => "close" })), { code: "outdated", final: false });
  const old = (frame) => ({ v: 1, id: frame.id, result: { methods: [], capabilities: ["desktop-v1"] } });
  await assert.rejects(dial(fakeMac({ answer: old })), { code: "outdated" });
});

test("a dropped channel fails its calls and says close once", async () => {
  const mac = fakeMac({ answer: (frame) => (frame.method === "slow" ? null : echo(frame)) });
  const client = await dial(mac);
  let closes = 0;
  client.on("close", () => closes++);
  const slow = client.call("slow");
  mac.sockets[0].closeWith(1006);
  await assert.rejects(slow, /closed/);
  await until(() => closes === 1, "close");
  client.close();
  await delay(20);
  assert.equal(closes, 1);
  assert.equal(client.closed, true);
  await assert.rejects(client.call("project:recent"), /closed/);
});

test("cancelling a pairing that waits for Allow ends it as cancelled", async () => {
  const abort = new AbortController();
  await assert.rejects(dial(fakeMac({ hello: "pending" }), { signal: abort.signal, onPending: () => abort.abort() }), { code: "cancelled", final: false });
});

test("a reply the pinned host did not seal is bad-host, final, and opens no channel", async () => {
  for (const hello of ["forged", "tampered"]) {
    const mac = fakeMac({ hello });
    await assert.rejects(dial(mac), { code: "bad-host", final: true }, hello);
    // Only the hello went out: no rpc was sent on a channel that never opened.
    assert.equal(mac.sockets[0].sent, 1, hello);
    assert.equal(mac.sockets[0].closed, 1000, hello);
  }
});

test("keys that can't be used end as keys, final, before a socket opens", async () => {
  const mac = fakeMac();
  await assert.rejects(dial(mac, { hostKey: "not a key!" }), { code: "keys", final: true });
  await assert.rejects(dial(mac, { hostKey: "abcd" }), { code: "keys", final: true });
  await assert.rejects(dial(mac, { identity: {} }), { code: "keys", final: true });
  assert.equal(mac.sockets.length, 0);
});

test("aborting the signal after the connection is up leaves it open", async (t) => {
  const abort = new AbortController();
  const client = await dial(fakeMac(), { signal: abort.signal });
  t.after(() => client.close());
  let closes = 0;
  client.on("close", () => closes++);
  abort.abort();
  await delay(20);
  assert.equal(client.closed, false);
  assert.equal(closes, 0);
  assert.deepEqual(await client.call("project:recent", [2]), { echo: [2] });
});

test("a paged reply may not announce too many pages nor run past the cap", async (t) => {
  const asked = [];
  const answer = (frame) => {
    if (frame.method === "huge") return { v: 1, id: frame.id, pages: { pageId: "p", pageCount: 1e9 } };
    if (frame.method === "long") return { v: 1, id: frame.id, pages: { pageId: "p", pageCount: 10 } };
    if (frame.method === "fits") return { v: 1, id: frame.id, pages: { pageId: "p", pageCount: 2 } };
    if (frame.method === "daemon:result-page") {
      asked.push(frame.args[1]);
      return { v: 1, id: frame.id, result: "[1," + (frame.args[1] === 0 ? '"' : "") + "x".repeat(1000) + (frame.args[1] === 1 ? '"]' : "") };
    }
    return echo(frame);
  };
  const client = await dial(fakeMac({ answer }), { maxPagedChars: 2500 });
  t.after(() => client.close());
  await assert.rejects(client.call("huge"), /invalid paged response/);
  assert.deepEqual(asked, [], "no page is asked for past the page count cap");
  await assert.rejects(client.call("long"), /too large/);
  assert.deepEqual(asked, [0, 1, 2], "reading stops at the page that passes the cap");
  // Within the cap, pages still join and parse.
  const fits = (frame) =>
    frame.method === "fits"
      ? { v: 1, id: frame.id, pages: { pageId: "p", pageCount: 2 } }
      : frame.method === "daemon:result-page"
        ? { v: 1, id: frame.id, result: frame.args[1] === 0 ? '{"a":"' : 'b"}' }
        : echo(frame);
  const ok = await dial(fakeMac({ answer: fits }));
  t.after(() => ok.close());
  assert.deepEqual(await ok.call("fits"), { a: "b" });
});

test("closeWhenIdle lets calls and paged replies in flight finish, then closes; keepOpen takes it back", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const pages = ['{"a":', "1}"];
  const mac = fakeMac({
    answer: (frame) =>
      frame.method === "slow"
        ? held.then(() => echo(frame))
        : frame.method === "big"
          ? { v: 1, id: frame.id, pages: { pageId: "p", pageCount: 2 } }
          : frame.method === "daemon:result-page"
            ? delay(10).then(() => ({ v: 1, id: frame.id, result: pages[frame.args[1]] }))
            : echo(frame),
  });
  const client = await dial(mac);
  let closes = 0;
  let before = 0;
  client.on("close", () => closes++);
  const slow = client.call("slow", [1]);
  const big = client.call("big");
  client.closeWhenIdle(() => before++);
  release();
  assert.deepEqual(await slow, { echo: [1] });
  assert.equal(client.closed, false, "the paged reply is still being read");
  assert.deepEqual(await big, { a: 1 });
  await until(() => client.closed, "the close once idle");
  assert.equal(before, 1);
  assert.equal(closes, 1);

  const idle = await dial(fakeMac());
  idle.closeWhenIdle();
  assert.equal(idle.closed, true, "nothing in flight: it closes at once");

  const kept = await dial(fakeMac({ answer: (frame) => (frame.method === "never" ? new Promise(() => {}) : echo(frame)) }));
  void kept.call("never").catch(() => {});
  kept.closeWhenIdle();
  kept.keepOpen();
  assert.deepEqual(await kept.call("project:recent", [2]), { echo: [2] });
  assert.equal(kept.closed, false);
  kept.close();
});
