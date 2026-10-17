import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createHookRoom,
  createHookDirectory,
  memoryHookStorage,
  memoryHookDirectory,
  readHookBody,
  hookIdOf,
  hookSecretOf,
  pickHookHeaders,
  splitHookFrame,
  NOT_FOUND,
  MAX_HOOK_BODY,
  MAX_STORED,
  MAX_STORED_PER_HOOK,
  HOLD_MS,
} from "./hooks.mjs";
import { createRoom, unframe, frame, HOOK, HOOK_SET, HOOK_ACK } from "./room.mjs";

const encoder = new TextEncoder();
const hex = (c) => c.repeat(64);
const A = hex("a"),
  B = hex("b");

function setup({ roomId = "room-1", directory = memoryHookDirectory(), clock = { now: 1_000 } } = {}) {
  const storage = memoryHookStorage();
  let n = 0;
  const hooks = createHookRoom({ storage, directory, roomId, now: () => clock.now, randomId: () => `d${++n}` });
  const sent = [];
  const send = (bytes) => {
    sent.push(bytes);
    return true;
  };
  return { storage, directory, hooks, sent, send, clock };
}
const setFrame = (ids) => encoder.encode(JSON.stringify({ hookIds: ids }));
const request = (body = '{"ok":true}', extra = {}) => ({ headers: { "content-type": "application/json" }, query: {}, body: encoder.encode(body), ...extra });

/** The header and body of a HOOK frame the room sent. */
function readHook(bytes) {
  const { type, conn, payload } = unframe(bytes);
  assert.equal(type, HOOK);
  assert.equal(conn, 0n);
  return splitHookFrame(payload);
}

test("frame constants sit beside OPEN, DATA and CLOSE", () => {
  assert.deepEqual([HOOK, HOOK_SET, HOOK_ACK], [4, 5, 6]);
});

test("an unregistered hook gets the same 404 as a bad secret", async () => {
  const { hooks } = setup();
  const answer = await hooks.receive(A, request());
  assert.deepEqual(answer, NOT_FOUND);
  assert.equal(answer.status, 404);
});

test("a registered hook with the host online answers 202 and forwards one HOOK frame, body intact", async () => {
  const { hooks, send, sent, storage } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  hooks.onHostReady(send);
  const body = new Uint8Array([0, 255, 10, 13, 7]);
  const answer = await hooks.receive(A, { headers: { "x-sentry": "1" }, query: { q: "v" }, body });
  assert.equal(answer.status, 202);
  assert.deepEqual(answer.json, { id: "d1" });
  assert.equal(sent.length, 1);
  const { header, body: got } = readHook(sent[0]);
  assert.deepEqual(header, { id: "d1", hookId: A, receivedAt: 1_000, headers: { "x-sentry": "1" }, query: { q: "v" } });
  assert.deepEqual(got, body);
  assert.equal(storage.deliveries.size(), 1, "stored until acked");
});

test("with the host offline a delivery is stored, then flushed oldest first when the host is ready", async () => {
  const { hooks, send, sent, clock } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A, B]), () => false);
  await hooks.receive(A, request("one"));
  clock.now += 10;
  await hooks.receive(B, request("two"));
  assert.equal(sent.length, 0);
  hooks.onHostReady(send);
  assert.deepEqual(
    sent.map((bytes) => new TextDecoder().decode(readHook(bytes).body)),
    ["one", "two"],
  );
});

test("a send that fails leaves the delivery stored for the next ready", async () => {
  const { hooks, send, sent, storage } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  hooks.onHostReady(() => false);
  assert.equal((await hooks.receive(A, request())).status, 202);
  assert.equal(storage.deliveries.size(), 1);
  hooks.onHostReady(send);
  assert.equal(sent.length, 1);
});

test("HOOK_ACK deletes the delivery", async () => {
  const { hooks, send, storage } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  hooks.onHostReady(send);
  const { json } = await hooks.receive(A, request());
  await hooks.onFrame(HOOK_ACK, encoder.encode(json.id), send);
  assert.equal(storage.deliveries.size(), 0);
  assert.equal(storage.deliveries.bytes(), 0);
});

test("expire deletes deliveries older than 24 h and says when the next one expires", async () => {
  const { hooks, storage, clock } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A]), () => false);
  await hooks.receive(A, request("old"));
  clock.now += 60_000;
  await hooks.receive(A, request("new"));
  assert.equal(hooks.expire(1_000 + HOLD_MS - 1), 1_000 + HOLD_MS);
  assert.equal(storage.deliveries.size(), 2);
  assert.equal(hooks.expire(1_000 + HOLD_MS), 61_000 + HOLD_MS);
  assert.equal(storage.deliveries.size(), 1);
  assert.equal(hooks.expire(61_000 + HOLD_MS), null);
  assert.equal(storage.deliveries.size(), 0);
});

test("the 201st stored delivery gets 429", async () => {
  const { hooks } = setup();
  const ids = Array.from({ length: MAX_STORED / MAX_STORED_PER_HOOK + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
  await hooks.onFrame(HOOK_SET, setFrame(ids), () => false);
  for (let i = 0; i < MAX_STORED; i += 1) {
    const answer = await hooks.receive(ids[Math.floor(i / MAX_STORED_PER_HOOK)], request());
    assert.equal(answer.status, 202, `delivery ${i + 1}`);
  }
  assert.equal(MAX_STORED, 200);
  assert.equal((await hooks.receive(ids.at(-1), request())).status, 429);
});

test("one noisy hook hits its own cap and leaves room for the others", async () => {
  const { hooks } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A, B]), () => false);
  for (let i = 0; i < MAX_STORED_PER_HOOK; i += 1) assert.equal((await hooks.receive(A, request())).status, 202);
  assert.equal((await hooks.receive(A, request())).status, 429);
  assert.equal((await hooks.receive(B, request())).status, 202);
});

test("the room caps stored bytes at 20 MiB", async () => {
  const { hooks } = setup();
  const ids = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(64, "0"));
  await hooks.onFrame(HOOK_SET, setFrame(ids), () => false);
  const big = new Uint8Array(MAX_HOOK_BODY);
  let accepted = 0;
  for (let i = 0; i < 100; i += 1) {
    const answer = await hooks.receive(ids[i % ids.length], { headers: {}, query: {}, body: big });
    if (answer.status !== 202) {
      assert.equal(answer.status, 429);
      break;
    }
    accepted += 1;
  }
  assert.equal(accepted, 80);
});

test("HOOK_SET claims, then releases, in the directory", async () => {
  const directory = memoryHookDirectory();
  const { hooks, send } = setup({ directory });
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  assert.equal(directory.owner(A), "room-1");
  await hooks.onFrame(HOOK_SET, setFrame([]), send);
  assert.equal(directory.owner(A), null);
  assert.deepEqual(await hooks.receive(A, request()), NOT_FOUND);
});

test("a hook another room claimed is not registered here", async () => {
  const directory = memoryHookDirectory();
  const first = setup({ directory, roomId: "room-1" });
  const second = setup({ directory, roomId: "room-2" });
  await first.hooks.onFrame(HOOK_SET, setFrame([A]), first.send);
  await second.hooks.onFrame(HOOK_SET, setFrame([A, B]), second.send);
  assert.equal(directory.owner(A), "room-1");
  assert.equal(directory.owner(B), "room-2");
  assert.deepEqual(await second.hooks.receive(A, request()), NOT_FOUND);
  // A release by a room that never owned it changes nothing.
  await second.hooks.onFrame(HOOK_SET, setFrame([]), second.send);
  assert.equal(directory.owner(A), "room-1");
});

test("after rotation the old hook gets 404 at once and the new one 202", async () => {
  const { hooks, send } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  assert.equal((await hooks.receive(A, request())).status, 202);
  const rotating = hooks.onFrame(HOOK_SET, setFrame([B]), send);
  // The old hook is gone before any directory call finishes.
  assert.deepEqual(await hooks.receive(A, request()), NOT_FOUND);
  await rotating;
  assert.deepEqual(await hooks.receive(A, request()), NOT_FOUND);
  assert.equal((await hooks.receive(B, request())).status, 202);
});

test("HOOK_SET frames apply in order even when the directory is slow", async () => {
  const inner = memoryHookDirectory();
  const slow = {
    claim: async (id, room) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return inner.claim(id, room);
    },
    release: async (id, room) => inner.release(id, room),
  };
  const { hooks, send } = setup({ directory: slow });
  const one = hooks.onFrame(HOOK_SET, setFrame([A]), send);
  const two = hooks.onFrame(HOOK_SET, setFrame([]), send);
  await Promise.all([one, two]);
  assert.equal(inner.owner(A), null);
  assert.deepEqual(await hooks.receive(A, request()), NOT_FOUND);
});

test("a malformed HOOK_SET or HOOK_ACK changes nothing", async () => {
  const { hooks, send, storage } = setup();
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  await hooks.onFrame(HOOK_SET, encoder.encode("not json"), send);
  await hooks.onFrame(HOOK_SET, setFrame(["nothex", A]), send);
  assert.equal((await hooks.receive(A, request())).status, 202);
  await hooks.onFrame(HOOK_ACK, encoder.encode("missing"), send);
  assert.equal(storage.deliveries.size(), 1);
  assert.deepEqual(await hooks.receive("nothex", request()), NOT_FOUND);
});

test("the directory keeps the first room that claims a hook and lets only it release", () => {
  const kv = new Map();
  const storage = { get: (k) => kv.get(k), put: (k, v) => kv.set(k, v), delete: (k) => kv.delete(k) };
  const directory = createHookDirectory({ storage });
  assert.equal(directory.claim("room-1"), true);
  assert.equal(directory.claim("room-1"), true, "claiming again is fine");
  assert.equal(directory.claim("room-2"), false);
  directory.release("room-2");
  assert.equal(directory.room(), "room-1");
  directory.release("room-1");
  assert.equal(directory.room(), null);
  assert.equal(directory.claim("room-2"), true);
});

test("hookIdOf is the hex sha256 of the secret, and only a 43-char base64url secret parses", async () => {
  const secret = "A".repeat(43);
  assert.equal(await hookIdOf(secret), createHash("sha256").update(secret).digest("hex"));
  assert.equal(hookSecretOf("/hook/" + secret), secret);
  assert.equal(hookSecretOf("/hook/" + secret + "/"), null);
  assert.equal(hookSecretOf("/hook/short"), null);
  assert.equal(hookSecretOf("/hook/" + "A".repeat(42) + "="), null);
  assert.equal(hookSecretOf("/hooks/" + secret), null);
});

test("the size guard reads bodies up to 256 KiB and refuses anything larger", async () => {
  const ok = await readHookBody(new Request("https://relay/hook/x", { method: "POST", body: new Uint8Array(MAX_HOOK_BODY).fill(1) }));
  assert.equal(ok.byteLength, MAX_HOOK_BODY);
  assert.equal(await readHookBody(new Request("https://relay/hook/x", { method: "POST", body: new Uint8Array(MAX_HOOK_BODY + 1) })), null);
  // A body that lies about its length is still cut off while streaming.
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(64 * 1024));
      controller.close();
    },
  });
  assert.equal(await readHookBody(new Request("https://relay/hook/x", { method: "POST", body: stream, duplex: "half" })), null);
  assert.equal(
    await readHookBody(new Request("https://relay/hook/x", { method: "POST", headers: { "content-length": String(MAX_HOOK_BODY + 1) }, body: "x" })),
    null,
  );
  assert.deepEqual(await readHookBody(new Request("https://relay/hook/x", { method: "POST" })), new Uint8Array());
});

test("forwarded headers are lowercased, skip the relay's own, and stop at 16 KiB", () => {
  const picked = pickHookHeaders([
    ["Content-Type", "application/json"],
    ["CF-Connecting-IP", "1.2.3.4"],
    ["X-Milagre-Hook", "spoof"],
    ["Cookie", "a=b"],
    ["Sentry-Hook-Signature", "abc"],
  ]);
  assert.deepEqual(picked, { "content-type": "application/json", "sentry-hook-signature": "abc" });
  const many = pickHookHeaders(Array.from({ length: 40 }, (_, i) => [`x-h${i}`, "v".repeat(1000)]));
  const size = Object.entries(many).reduce((sum, [k, v]) => sum + k.length + v.length, 0);
  assert.ok(size <= 16 * 1024, `${size}`);
  assert.ok(Object.keys(many).length >= 15);
});

test("the room routes HOOK_SET and HOOK_ACK on conn 0 to the hook room and tells it when the host is ready", async () => {
  const { default: nacl } = await import("tweetnacl");
  const { hostIdOf, b64url, fromB64url } = await import("@milagre/shared/relay-crypto");
  const keys = nacl.sign.keyPair();
  const seen = [];
  const room = createRoom({
    id: hostIdOf(keys.publicKey),
    nonce: () => new Uint8Array(32).fill(3),
    onHostReady: () => seen.push("ready"),
    onHostFrame: (type, payload) => seen.push([type, new TextDecoder().decode(payload)]),
  });
  assert.equal(room.sendHost(new Uint8Array([1])), false, "no host yet");
  const host = { sent: [], send: (d) => host.sent.push(d), close() {} };
  room.hostOpened(host);
  const { nonce } = JSON.parse(host.sent[0]);
  room.hostMessage(host, JSON.stringify({ t: "proof", key: b64url(keys.publicKey), sig: b64url(nacl.sign.detached(fromB64url(nonce), keys.secretKey)) }));
  assert.deepEqual(seen, ["ready"]);
  room.hostMessage(host, frame(HOOK_SET, 0n, encoder.encode('{"hookIds":[]}')));
  room.hostMessage(host, frame(HOOK_ACK, 0n, encoder.encode("d1")));
  // Other types on conn 0 and hook types on a phone's conn are not hook frames.
  room.hostMessage(host, frame(2, 0n, encoder.encode("x")));
  room.hostMessage(host, frame(HOOK_ACK, 7n, encoder.encode("x")));
  assert.deepEqual(seen, ["ready", [HOOK_SET, '{"hookIds":[]}'], [HOOK_ACK, "d1"]]);
  assert.equal(room.sendHost(frame(HOOK, 0n)), true);
  assert.equal(unframe(host.sent.at(-1)).type, HOOK);
});
