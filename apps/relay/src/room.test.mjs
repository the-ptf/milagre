import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import nacl from "tweetnacl";
import { createRoom, frame, unframe, MAX_PHONES } from "./room.mjs";
import { hostIdOf, b64url, fromB64url } from "@milagre/shared/relay-crypto";

function fakeSocket() {
  const s = { sent: [], closed: null };
  s.send = (d) => s.sent.push(d);
  s.close = (code, reason) => {
    s.closed = { code, reason };
  };
  return s;
}
const keys = nacl.sign.keyPair();
const id = hostIdOf(keys.publicKey);
const randomNonce = () => new Uint8Array(32).fill(7);

function connectHost(room) {
  const host = fakeSocket();
  room.hostOpened(host);
  const { nonce } = JSON.parse(host.sent[0]);
  room.hostMessage(host, JSON.stringify({ t: "proof", key: b64url(keys.publicKey), sig: b64url(nacl.sign.detached(fromB64url(nonce), keys.secretKey)) }));
  assert.deepEqual(JSON.parse(host.sent[1]), { t: "ready" });
  return host;
}

test("host must sign the challenge with the key behind its id", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = fakeSocket();
  room.hostOpened(host);
  const other = nacl.sign.keyPair();
  room.hostMessage(host, JSON.stringify({ t: "proof", key: b64url(other.publicKey), sig: b64url(nacl.sign.detached(randomNonce(), other.secretKey)) }));
  assert.equal(host.closed.code, 4403);
});

test("phone frames reach the host tagged with a connection, and back", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 1, conn, payload: new Uint8Array() });
  room.phoneMessage(phone, new Uint8Array([9, 9]));
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 2, conn, payload: new Uint8Array([9, 9]) });
  room.hostMessage(host, frame(2, conn, new Uint8Array([5])));
  assert.deepEqual(phone.sent.at(-1), new Uint8Array([5]));
});

test("a phone with no host is closed as offline", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const phone = fakeSocket();
  room.phoneOpened(phone);
  assert.equal(phone.closed.code, 4404);
});

test("phones are closed as host-gone when the host leaves", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  room.phoneOpened(phone);
  room.hostClosed(host);
  assert.equal(phone.closed.code, 4410);
});

test("frames over 1 MiB and a 17th phone are refused", () => {
  const room = createRoom({ id, nonce: randomNonce });
  connectHost(room);
  const phones = Array.from({ length: 17 }, fakeSocket);
  phones.forEach((p) => room.phoneOpened(p));
  assert.equal(phones[16].closed.code, 4429);
  room.phoneMessage(phones[0], new Uint8Array(1024 * 1024 + 1));
  assert.equal(phones[0].closed.code, 1009);
});

test("a second host replaces the first", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const first = connectHost(room);
  connectHost(room);
  assert.equal(first.closed.code, 4409);
});

test("a malformed proof closes the host instead of throwing", () => {
  for (const proof of [{ t: "proof", key: "!!", sig: "x" }, { t: "proof", key: b64url(keys.publicKey), sig: "***" }, { t: "proof" }, "not json"]) {
    const room = createRoom({ id, nonce: randomNonce });
    const host = fakeSocket();
    room.hostOpened(host);
    room.hostMessage(host, typeof proof === "string" ? proof : JSON.stringify(proof));
    assert.equal(host.closed.code, 4403);
  }
});

function proofFor(socket, signer) {
  const { nonce } = JSON.parse(socket.sent[0]);
  return JSON.stringify({ t: "proof", key: b64url(signer.publicKey), sig: b64url(nacl.sign.detached(fromB64url(nonce), signer.secretKey)) });
}

test("an impostor connecting while the real host is ready is refused and disturbs nothing", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  const impostor = fakeSocket();
  room.hostOpened(impostor);
  assert.equal(host.closed, null);
  assert.equal(phone.closed, null);
  room.hostMessage(impostor, proofFor(impostor, nacl.sign.keyPair()));
  assert.equal(impostor.closed.code, 4403);
  assert.equal(host.closed, null);
  assert.equal(phone.closed, null);
  room.phoneMessage(phone, new Uint8Array([1]));
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 2, conn, payload: new Uint8Array([1]) });
  room.hostMessage(host, frame(2, conn, new Uint8Array([2])));
  assert.deepEqual(phone.sent.at(-1), new Uint8Array([2]));
});

test("a proven second host closes the first host and its phones", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const first = connectHost(room);
  const phone = fakeSocket();
  room.phoneOpened(phone);
  const second = connectHost(room);
  assert.deepEqual(first.closed, { code: 4409, reason: "replaced" });
  assert.deepEqual(phone.closed, { code: 4410, reason: "host-gone" });
  room.hostClosed(first);
  const later = fakeSocket();
  assert.notEqual(room.phoneOpened(later), null);
  assert.equal(unframe(second.sent.at(-1)).type, 1);
});

test("a pending host that never proves does not block the current host, and phones cannot use it", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const idle = fakeSocket();
  room.hostOpened(idle);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  assert.notEqual(conn, null);
  room.hostMessage(host, frame(2, conn, new Uint8Array([3])));
  assert.deepEqual(phone.sent.at(-1), new Uint8Array([3]));
  assert.equal(idle.sent.length, 1);
  room.hostClosed(idle);
  assert.equal(host.closed, null);
});

test("only one host can be pending: a newer one closes the older", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const older = fakeSocket(),
    newer = fakeSocket();
  room.hostOpened(older);
  room.hostOpened(newer);
  assert.equal(older.closed.code, 4409);
  room.hostMessage(newer, proofFor(newer, keys));
  assert.deepEqual(JSON.parse(newer.sent[1]), { t: "ready" });
  assert.equal(room.phoneOpened(fakeSocket()) !== null, true);
});

test("a pending host cannot carry phone frames before it proves", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  const impostor = fakeSocket();
  room.hostOpened(impostor);
  room.hostMessage(impostor, frame(2, conn, new Uint8Array([6])));
  assert.equal(impostor.closed.code, 4403);
  assert.equal(phone.sent.length, 0);
});

test("with no proven host, a phone is offline even while a host is pending", () => {
  const room = createRoom({ id, nonce: randomNonce });
  room.hostOpened(fakeSocket());
  const phone = fakeSocket();
  room.phoneOpened(phone);
  assert.equal(phone.closed.code, 4404);
});

test("a phone text frame closes that phone with 1003 and forwards nothing", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  room.phoneOpened(phone);
  const before = host.sent.length;
  room.phoneMessage(phone, "hello");
  assert.equal(phone.closed.code, 1003);
  assert.equal(host.sent.length, before);
});

test("a numeric text frame from a phone is refused without allocating", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  room.phoneOpened(phone);
  const before = host.sent.length;
  const buffers = process.memoryUsage().arrayBuffers;
  room.phoneMessage(phone, "200000000");
  assert.ok(process.memoryUsage().arrayBuffers - buffers < 1024 * 1024);
  assert.equal(phone.closed.code, 1003);
  assert.equal(host.sent.length, before);
  const small = fakeSocket();
  room.phoneOpened(small);
  const sentBefore = host.sent.length;
  room.phoneMessage(small, "5");
  assert.equal(small.closed.code, 1003);
  assert.equal(host.sent.length, sentBefore);
});

test("a ready host sending a frame under 9 bytes or a text frame is closed with 1003", () => {
  for (const bad of [new Uint8Array(8), new Uint8Array(), "text", "300000000"]) {
    const room = createRoom({ id, nonce: randomNonce });
    const host = connectHost(room);
    const phone = fakeSocket();
    room.phoneOpened(phone);
    assert.doesNotThrow(() => room.hostMessage(host, bad));
    assert.equal(host.closed.code, 1003);
    assert.equal(phone.sent.length, 0);
  }
});

test("ArrayBuffer frames from the socket layer are forwarded", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  room.phoneMessage(phone, new Uint8Array([4, 2]).buffer);
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 2, conn, payload: new Uint8Array([4, 2]) });
  room.hostMessage(host, frame(2, conn, new Uint8Array([8])).buffer);
  assert.deepEqual(phone.sent.at(-1), new Uint8Array([8]));
});

test("binary from another realm (an ArrayBuffer or view that fails instanceof) is forwarded", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  const foreign = vm.runInNewContext("new Uint8Array([6, 7, 8])");
  assert.equal(foreign.buffer instanceof ArrayBuffer, false);
  room.phoneMessage(phone, foreign.buffer);
  assert.equal(phone.closed, null);
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 2, conn, payload: new Uint8Array([6, 7, 8]) });
  room.phoneMessage(phone, foreign);
  assert.equal(phone.closed, null);
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 2, conn, payload: new Uint8Array([6, 7, 8]) });
  const hostFrame = vm.runInNewContext("new Uint8Array(10)");
  hostFrame[0] = 2;
  new DataView(hostFrame.buffer).setBigUint64(1, conn);
  hostFrame[9] = 5;
  room.hostMessage(host, hostFrame.buffer);
  assert.equal(host.closed, null);
  assert.deepEqual(phone.sent.at(-1), new Uint8Array([5]));
});

test("look-alikes of an ArrayBuffer are still refused", () => {
  const room = createRoom({ id, nonce: randomNonce });
  connectHost(room);
  for (const fake of [
    { byteLength: 200000000 },
    { byteLength: 4, [Symbol.toStringTag]: "ArrayBuffer" },
    200000000,
    null,
    undefined,
    new Blob([new Uint8Array(4)]),
  ]) {
    const phone = fakeSocket();
    room.phoneOpened(phone);
    room.phoneMessage(phone, fake);
    assert.equal(phone.closed?.code, 1003, String(fake));
  }
});

test("a host whose send throws while a phone opens is dropped, and the phone takes no slot", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  host.send = () => {
    throw new Error("socket is closing");
  };
  const phone = fakeSocket();
  let conn;
  assert.doesNotThrow(() => {
    conn = room.phoneOpened(phone);
  });
  assert.equal(conn, null);
  assert.equal(phone.closed.code, 4404);
  assert.ok(host.closed, "the broken host is closed");
  // The broken host no longer counts: a phone message goes nowhere and the next phone is offline.
  assert.doesNotThrow(() => room.phoneMessage(phone, new Uint8Array([1])));
  const late = fakeSocket();
  assert.equal(room.phoneOpened(late), null);
  assert.equal(late.closed.code, 4404);
  // A new host gets all 16 slots.
  const next = connectHost(room);
  const phones = Array.from({ length: MAX_PHONES }, () => fakeSocket());
  for (const each of phones) assert.notEqual(room.phoneOpened(each), null);
  assert.equal(phones.filter((each) => each.closed).length, 0);
  assert.equal(next.closed, null);
});

test("a phone whose send throws is cleaned up, the host is told, and its slot is free again", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phones = Array.from({ length: MAX_PHONES }, () => fakeSocket());
  const conns = phones.map((phone) => room.phoneOpened(phone));
  const broken = phones[3];
  broken.send = () => {
    throw new Error("socket is closing");
  };
  assert.doesNotThrow(() => room.hostMessage(host, frame(2, conns[3], new Uint8Array([5]))));
  assert.ok(broken.closed, "the broken phone is closed");
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 3, conn: conns[3], payload: new Uint8Array() });
  const before = host.sent.length;
  room.phoneMessage(broken, new Uint8Array([1]));
  room.phoneClosed(broken);
  assert.equal(host.sent.length, before);
  const extra = fakeSocket();
  assert.notEqual(room.phoneOpened(extra), null);
  assert.equal(extra.closed, null);
  assert.equal(host.closed, null);
});

test("closing twice (an error then a close) is the same as closing once", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  room.phoneOpened(phone);
  const before = host.sent.length;
  room.phoneClosed(phone);
  room.phoneClosed(phone);
  assert.equal(host.sent.length, before + 1);
  room.hostClosed(host);
  assert.doesNotThrow(() => room.hostClosed(host));
  const next = connectHost(room);
  assert.notEqual(room.phoneOpened(fakeSocket()), null);
  assert.equal(next.closed, null);
});

// Restore: the Durable Object can be evicted while sockets stay open. The room marks each socket's
// role on it (the worker stores that as the socket's attachment) and a fresh room rebuilds from those marks.

/** A room whose marks are kept the way serializeAttachment keeps them: a structured clone, last write wins. */
function markedRoom(nonce = randomNonce) {
  const marks = new Map();
  const room = createRoom({ id, nonce, mark: (socket, state) => marks.set(socket, structuredClone(state)) });
  return { room, marks };
}
/** Simulates eviction: a brand-new room built only from the sockets and their last marks, in the order given. */
function revive(marks, sockets, nonce = () => new Uint8Array(32).fill(9)) {
  const next = markedRoom(nonce);
  next.room.restore(sockets.map((socket) => ({ socket, state: marks.has(socket) ? marks.get(socket) : null })));
  return next;
}

test("the room marks each socket with its role and state", () => {
  const { room, marks } = markedRoom();
  const host = fakeSocket();
  room.hostOpened(host);
  assert.deepEqual(marks.get(host), { role: "pending", challenge: b64url(randomNonce()) });
  room.hostMessage(host, proofFor(host, keys));
  assert.deepEqual(marks.get(host), { role: "host", next: "0" });
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  assert.deepEqual(marks.get(phone), { role: "phone", conn: String(conn) });
  assert.deepEqual(marks.get(host), { role: "host", next: String(conn) });
  room.phoneClosed(phone);
  assert.equal(marks.get(phone), null);
});

test("a restored ready host and its phones keep talking, new phones get fresh conns, and CLOSE still works", () => {
  const { room, marks } = markedRoom();
  const host = connectHost(room);
  const first = fakeSocket(),
    second = fakeSocket();
  const a = room.phoneOpened(first),
    b = room.phoneOpened(second);
  const { room: revived, marks: after } = revive(marks, [host, first, second]);
  for (const socket of [host, first, second]) assert.equal(socket.closed, null);

  revived.phoneMessage(first, new Uint8Array([1, 2]));
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 2, conn: a, payload: new Uint8Array([1, 2]) });
  revived.hostMessage(host, frame(2, b, new Uint8Array([7])));
  assert.deepEqual(second.sent.at(-1), new Uint8Array([7]));

  const third = fakeSocket();
  const c = revived.phoneOpened(third);
  assert.ok(c > a && c > b, `conn ${c} is newer than ${a} and ${b}`);
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 1, conn: c, payload: new Uint8Array() });
  assert.deepEqual(after.get(host), { role: "host", next: String(c) });

  revived.hostMessage(host, frame(3, a));
  assert.deepEqual(first.closed, { code: 1000, reason: "closed-by-host" });
  revived.phoneClosed(second);
  assert.deepEqual(unframe(host.sent.at(-1)), { type: 3, conn: b, payload: new Uint8Array() });
  assert.equal(host.closed, null);
});

test("a restored phone conn above the host mark still moves the counter past it", () => {
  const { room, marks } = markedRoom();
  const host = connectHost(room);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  marks.set(host, { role: "host", next: "0" }); // a stale counter must not hand out a conn that is in use
  const { room: revived } = revive(marks, [host, phone]);
  const later = fakeSocket();
  assert.ok(revived.phoneOpened(later) > conn);
});

test("a restored pending host proves against its original challenge and then replaces the old host", () => {
  const { room, marks } = markedRoom(() => new Uint8Array(32).fill(3));
  const old = connectHost(room);
  const phone = fakeSocket();
  room.phoneOpened(phone);
  const newcomer = fakeSocket();
  room.hostOpened(newcomer);
  const { room: revived, marks: after } = revive(marks, [old, phone, newcomer]); // the new room would issue a different nonce
  assert.equal(old.closed, null);
  assert.equal(newcomer.closed, null);
  revived.hostMessage(newcomer, proofFor(newcomer, keys));
  assert.deepEqual(JSON.parse(newcomer.sent.at(-1)), { t: "ready" });
  assert.deepEqual(old.closed, { code: 4409, reason: "replaced" });
  assert.deepEqual(phone.closed, { code: 4410, reason: "host-gone" });
  assert.equal(after.get(newcomer).role, "host");
  assert.notEqual(revived.phoneOpened(fakeSocket()), null);
});

test("a restored pending host with a bad proof is still refused and the restored host is untouched", () => {
  const { room, marks } = markedRoom();
  const host = connectHost(room);
  const impostor = fakeSocket();
  room.hostOpened(impostor);
  const { room: revived } = revive(marks, [host, impostor]);
  revived.hostMessage(impostor, proofFor(impostor, nacl.sign.keyPair()));
  assert.equal(impostor.closed.code, 4403);
  assert.equal(host.closed, null);
});

test("sockets restored with no state or an unknown one are closed as lost-state", () => {
  const { room } = markedRoom();
  const bare = fakeSocket(),
    unknown = fakeSocket(),
    badConn = fakeSocket(),
    badChallenge = fakeSocket();
  room.restore([
    { socket: bare, state: null },
    { socket: unknown, state: { role: "admin" } },
    { socket: badConn, state: { role: "phone", conn: "x" } },
    { socket: badChallenge, state: { role: "pending", challenge: "short" } },
  ]);
  for (const socket of [bare, unknown, badConn, badChallenge]) assert.deepEqual(socket.closed, { code: 1011, reason: "lost-state" });
});

test("with two restored hosts the last listed one is kept and the other is replaced", () => {
  const one = markedRoom(),
    two = markedRoom();
  const first = connectHost(one.room),
    second = connectHost(two.room);
  const marks = new Map([
    [first, one.marks.get(first)],
    [second, two.marks.get(second)],
  ]);
  const { room: revived } = revive(marks, [first, second]);
  assert.deepEqual(first.closed, { code: 4409, reason: "replaced" });
  assert.equal(second.closed, null);
  const phone = fakeSocket();
  const conn = revived.phoneOpened(phone);
  assert.deepEqual(unframe(second.sent.at(-1)), { type: 1, conn, payload: new Uint8Array() });
  revived.hostMessage(first, frame(2, conn, new Uint8Array([1])));
  assert.equal(phone.sent.length, 0);
});

test("with two restored pending hosts the last listed one is kept", () => {
  const one = markedRoom(),
    two = markedRoom();
  const older = fakeSocket(),
    newer = fakeSocket();
  one.room.hostOpened(older);
  two.room.hostOpened(newer);
  const marks = new Map([
    [older, one.marks.get(older)],
    [newer, two.marks.get(newer)],
  ]);
  const { room: revived } = revive(marks, [older, newer]);
  assert.deepEqual(older.closed, { code: 4409, reason: "replaced" });
  revived.hostMessage(newer, proofFor(newer, keys));
  assert.deepEqual(JSON.parse(newer.sent.at(-1)), { t: "ready" });
});

test("phones restored without a host are closed as host-gone, even with a host pending", () => {
  const { room, marks } = markedRoom();
  const host = connectHost(room);
  const phone = fakeSocket(),
    other = fakeSocket();
  room.phoneOpened(phone);
  room.phoneOpened(other);
  const pending = fakeSocket();
  room.hostOpened(pending);
  revive(marks, [phone]);
  assert.deepEqual(phone.closed, { code: 4410, reason: "host-gone" });
  revive(marks, [pending, other]);
  assert.deepEqual(other.closed, { code: 4410, reason: "host-gone" });
  assert.equal(pending.closed, null);
  assert.equal(host.closed, null);
});

test("a socket the room already closed is not restored as live, even if it is still listed while closing", () => {
  const { room, marks } = markedRoom();
  const first = connectHost(room);
  const phone = fakeSocket();
  room.phoneOpened(phone);
  const second = connectHost(room);
  assert.equal(first.closed.code, 4409);
  first.closed = null;
  phone.closed = null; // still CLOSING, so getWebSockets() may list them
  const { room: revived } = revive(marks, [second, first, phone]);
  assert.equal(first.closed.code, 1011);
  assert.equal(phone.closed.code, 1011);
  assert.equal(second.closed, null);
  const late = fakeSocket();
  const conn = revived.phoneOpened(late);
  assert.deepEqual(unframe(second.sent.at(-1)), { type: 1, conn, payload: new Uint8Array() });
});

test("phoneRefusal says why a phone would be turned away, so the worker can refuse it before accepting", () => {
  const room = createRoom({ id, nonce: randomNonce });
  assert.deepEqual(room.phoneRefusal(), { code: 4404, reason: "host-offline" });
  room.hostOpened(fakeSocket());
  assert.deepEqual(room.phoneRefusal(), { code: 4404, reason: "host-offline" });
  const host = connectHost(room);
  assert.equal(room.phoneRefusal(), null);
  const before = host.sent.length;
  for (let i = 0; i < MAX_PHONES; i++) room.phoneOpened(fakeSocket());
  assert.deepEqual(room.phoneRefusal(), { code: 4429, reason: "too-many-phones" });
  assert.equal(host.sent.length, before + MAX_PHONES, "asking sends nothing");
});

test("restore re-marks the host when restored conns move the counter past its mark", () => {
  const { room, marks } = markedRoom();
  const host = connectHost(room);
  const phones = [fakeSocket(), fakeSocket()];
  const conns = phones.map((phone) => room.phoneOpened(phone));
  marks.set(host, { role: "host", next: "0" }); // a mark that fell behind
  const { marks: after } = revive(marks, [host, ...phones]);
  assert.deepEqual(after.get(host), { role: "host", next: String(conns[1]) });
  const untouched = revive(new Map([[host, { role: "host", next: "5" }]]), [host]);
  assert.equal(untouched.marks.has(host), false, "a mark that is already right is not rewritten");
});

test("a CLOSE that says host-offline closes the phone as if no Mac were there", () => {
  const room = createRoom({ id, nonce: randomNonce });
  const host = connectHost(room);
  const phone = fakeSocket();
  const conn = room.phoneOpened(phone);
  room.hostMessage(host, frame(3, conn, new TextEncoder().encode("host-offline")));
  assert.deepEqual(phone.closed, { code: 4404, reason: "host-offline" });
  const other = fakeSocket();
  const next = room.phoneOpened(other);
  room.hostMessage(host, frame(3, next, new TextEncoder().encode("anything else")));
  assert.deepEqual(other.closed, { code: 1000, reason: "closed-by-host" });
});
