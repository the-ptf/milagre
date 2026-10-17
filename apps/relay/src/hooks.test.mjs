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
  handleHookRequest,
  sqlHookStorage,
  splitHookFrame,
  NOT_FOUND,
  MAX_HOOK_BODY,
  MAX_STORED,
  MAX_STORED_PER_HOOK,
  HOLD_MS,
} from "./hooks.mjs";
import { createRoom, unframe, frame, HOOK, HOOK_SET, HOOK_ACK, HOOK_RESULT } from "./room.mjs";

const encoder = new TextEncoder();
const hex = (c) => c.repeat(64);
const A = hex("a"),
  B = hex("b");

function setup({ roomId = "room-1", directory = memoryHookDirectory(), clock = { now: 1_000 } } = {}) {
  const storage = memoryHookStorage();
  let n = 0;
  const hooks = createHookRoom({ storage, directory, roomId, now: () => clock.now, randomId: () => `d${++n}` });
  const sent = []; // HOOK frames
  const results = []; // HOOK_RESULT payloads
  const send = (bytes) => {
    if (bytes[0] === HOOK_RESULT) results.push(JSON.parse(new TextDecoder().decode(unframe(bytes).payload)));
    else sent.push(bytes);
    return true;
  };
  return { storage, directory, hooks, sent, results, send, clock };
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
  assert.deepEqual([HOOK, HOOK_SET, HOOK_ACK, HOOK_RESULT], [4, 5, 6, 7]);
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

test("the directory keeps the first room that claims a hook and lets only it release", async () => {
  const kv = new Map();
  const storage = { get: (k) => kv.get(k), put: (k, v) => kv.set(k, v), delete: (k) => kv.delete(k) };
  const directory = createHookDirectory({ storage });
  assert.equal(await directory.claim("room-1"), true);
  assert.equal(await directory.claim("room-1"), true, "claiming again is fine");
  assert.equal(await directory.claim("room-2"), false);
  directory.release("room-2");
  assert.equal(directory.room(), "room-1");
  directory.release("room-1");
  assert.equal(directory.room(), null);
  assert.equal(await directory.claim("room-2"), true);
});

test("a room that proves it holds the secret takes a hook over from the room that has it; a wrong proof doesn't", async () => {
  const kv = new Map();
  const storage = { get: (k) => kv.get(k), put: (k, v) => kv.set(k, v), delete: (k) => kv.delete(k) };
  const directory = createHookDirectory({ storage });
  const secret = "P".repeat(43);
  const hookId = await hookIdOf(secret);
  assert.equal(await directory.claim("old-room", { hookId, secret }), true);
  assert.equal(await directory.claim("new-room", { hookId, secret: "Q".repeat(43) }), false, "wrong secret");
  assert.equal(await directory.claim("new-room", { hookId: await hookIdOf("Q".repeat(43)), secret: "Q".repeat(43) }), false, "another hook's proof");
  assert.equal(directory.room(), "old-room");
  assert.equal(await directory.claim("new-room", { hookId, secret }), true);
  assert.equal(directory.room(), "new-room");
  directory.release("old-room");
  assert.equal(directory.room(), "new-room", "the old room can't release it any more");
});

test("a hook the old room never releases moves to the new room with proof, and the next POST reaches it", async () => {
  const { hops, room, directory } = edge();
  const secret = "T".repeat(43);
  const hookId = await hookIdOf(secret);
  const old = room("old-room");
  await old.hooks.onFrame(HOOK_SET, setFrame([hookId]), old.send);
  // The old host crashed and never says []. The Mac's new room asks without proof first, then with it.
  const fresh = room("new-room");
  await fresh.hooks.onFrame(HOOK_SET, setFrame([hookId]), fresh.send);
  assert.deepEqual(fresh.results.at(-1), { refused: [hookId], failed: [] });
  await fresh.hooks.onFrame(HOOK_SET, encoder.encode(JSON.stringify({ hookIds: [hookId], proofs: { [hookId]: "U".repeat(43) } })), fresh.send);
  assert.deepEqual(fresh.results.at(-1), { refused: [hookId], failed: [] }, "a wrong proof changes nothing");
  await fresh.hooks.onFrame(HOOK_SET, encoder.encode(JSON.stringify({ hookIds: [hookId], proofs: { [hookId]: secret } })), fresh.send);
  assert.deepEqual(fresh.results.at(-1), { refused: [], failed: [] });
  assert.equal(directory.owner(hookId), "new-room");
  fresh.hooks.onHostReady(fresh.send);
  assert.equal((await handleHookRequest(post(`/hook/${secret}`), hops)).status, 202);
  assert.equal(fresh.sent.length, 1);
  assert.equal(old.sent.length, 0);
});

test("a directory that can't be reached is reported as failed, not refused, and the chain survives a settle that throws", async () => {
  let reachable = false;
  const inner = memoryHookDirectory();
  const directory = {
    claim: (id, room, secret) => {
      if (!reachable) throw new Error("directory down");
      return inner.claim(id, room, secret);
    },
    release: (id, room) => inner.release(id, room),
  };
  let roomThrows = true;
  const storage = memoryHookStorage();
  const results = [];
  const send = (bytes) => {
    if (bytes[0] === HOOK_RESULT) results.push(JSON.parse(new TextDecoder().decode(unframe(bytes).payload)));
    return true;
  };
  const hooks = createHookRoom({
    storage,
    directory,
    roomId: () => {
      if (roomThrows) throw new Error("no room id yet");
      return "room-1";
    },
    send,
  });
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  roomThrows = false;
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  assert.deepEqual(results.at(-1), { refused: [], failed: [A] });
  reachable = true;
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  assert.deepEqual(results.at(-1), { refused: [], failed: [] });
  assert.equal(storage.hooks.has(A), true);
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

test("each HOOK_SET is answered with the ids another room still holds, and a later set claims them once released", async () => {
  // A Phone Reset: the Mac's new room asks for hooks its old room still owns.
  const directory = memoryHookDirectory();
  const old = setup({ directory, roomId: "old-room" });
  const fresh = setup({ directory, roomId: "new-room" });
  await old.hooks.onFrame(HOOK_SET, setFrame([A, B]), old.send);
  assert.deepEqual(old.results, [{ refused: [], failed: [] }]);
  await fresh.hooks.onFrame(HOOK_SET, setFrame([A, B]), fresh.send);
  assert.deepEqual(fresh.results.at(-1), { refused: [A, B], failed: [] });
  assert.deepEqual(await fresh.hooks.receive(A, request()), NOT_FOUND);
  // The retiring host lets go, then the new one sends its set again.
  await old.hooks.onFrame(HOOK_SET, setFrame([]), old.send);
  assert.deepEqual(await old.hooks.receive(A, request()), NOT_FOUND);
  await fresh.hooks.onFrame(HOOK_SET, setFrame([A, B]), fresh.send);
  assert.deepEqual(fresh.results.at(-1), { refused: [], failed: [] });
  assert.equal(directory.owner(A), "new-room");
  assert.equal((await fresh.hooks.receive(A, request())).status, 202);
});

test("a directory release that fails is tried again on the next set", async () => {
  const inner = memoryHookDirectory();
  let failing = true;
  const flaky = {
    claim: (id, room) => inner.claim(id, room),
    release: async (id, room) => {
      if (failing) throw new Error("directory down");
      inner.release(id, room);
    },
  };
  const { hooks, send } = setup({ directory: flaky });
  await hooks.onFrame(HOOK_SET, setFrame([A]), send);
  await hooks.onFrame(HOOK_SET, setFrame([]), send);
  assert.equal(inner.owner(A), "room-1", "the release failed");
  assert.deepEqual(await hooks.receive(A, request()), NOT_FOUND, "dead here all the same");
  failing = false;
  await hooks.onFrame(HOOK_SET, setFrame([B]), send);
  assert.equal(inner.owner(A), null);
  assert.equal(inner.owner(B), "room-1");
});

test("HOOK_ACK returns nothing to wait on, even while a set is settling", async () => {
  const { hooks, send } = setup();
  const settling = hooks.onFrame(HOOK_SET, setFrame([A]), send);
  assert.equal(hooks.onFrame(HOOK_ACK, encoder.encode("x"), send), undefined);
  await settling;
});

/** The edge with an in-memory directory and rooms, counting lookups. */
function edge() {
  const directory = memoryHookDirectory();
  const rooms = new Map();
  const lookups = [];
  const hops = {
    lookupRoom: (hookId) => {
      lookups.push(hookId);
      return directory.owner(hookId);
    },
    forwardToRoom: async (roomId, hookId, packed) => {
      const { unpackHookRequest, hookResponse } = await import("./hooks.mjs");
      return hookResponse(rooms.get(roomId).hooks.receive(hookId, unpackHookRequest(packed)));
    },
  };
  const room = (roomId) => {
    const made = setup({ directory, roomId });
    rooms.set(roomId, made);
    return made;
  };
  return { hops, room, lookups, directory };
}
const post = (path, init = {}) => new Request(`https://relay.milagre.cloud${path}`, { method: "POST", body: '{"a":1}', ...init });
async function snapshotResponse(response) {
  return { status: response.status, headers: [...response.headers.entries()], body: new Uint8Array(await response.arrayBuffer()) };
}

test("a malformed secret, an unknown hook and a released hook answer the same bytes, each after one lookup", async () => {
  const { hops, room, lookups } = edge();
  const mac = room("room-1");
  const released = "R".repeat(43);
  const releasedId = await hookIdOf(released);
  await mac.hooks.onFrame(HOOK_SET, setFrame([releasedId]), mac.send);
  assert.equal((await handleHookRequest(post(`/hook/${released}`), hops)).status, 202);
  await mac.hooks.onFrame(HOOK_SET, setFrame([]), mac.send);
  // Released from the room but, as after a failed release, still in the directory: the room's own 404 must match.
  const stillListed = "S".repeat(43);
  const stillListedId = await hookIdOf(stillListed);
  await mac.hooks.onFrame(HOOK_SET, setFrame([stillListedId]), mac.send);
  mac.storage.hooks.delete(stillListedId);
  lookups.length = 0;
  const answers = [];
  for (const path of ["/hook/bad-shape", `/hook/${"U".repeat(43)}`, `/hook/${released}`, `/hook/${stillListed}`, `/hook/${"A".repeat(42)}=`]) {
    const before = lookups.length;
    answers.push(await snapshotResponse(await handleHookRequest(post(path), hops)));
    assert.equal(lookups.length, before + 1, path);
  }
  for (const answer of answers.slice(1)) assert.deepEqual(answer, answers[0]);
  assert.equal(answers[0].status, 404);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(answers[0].body)), NOT_FOUND.json);
});

test("405 and 413 are decided before any lookup", async () => {
  const { hops, lookups } = edge();
  const secret = "/hook/" + "A".repeat(43);
  const get = await handleHookRequest(new Request(`https://relay.milagre.cloud${secret}`), hops);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const big = await handleHookRequest(post(secret, { body: new Uint8Array(MAX_HOOK_BODY + 1) }), hops);
  assert.equal(big.status, 413);
  assert.deepEqual(lookups, []);
});

test("a registered hook gets 202 through the edge with its headers, query and body", async () => {
  const { hops, room } = edge();
  const mac = room("room-1");
  const secret = "Z".repeat(43);
  await mac.hooks.onFrame(HOOK_SET, setFrame([await hookIdOf(secret)]), mac.send);
  mac.hooks.onHostReady(mac.send);
  const response = await handleHookRequest(
    post(`/hook/${secret}?env=prod&env=dev`, { headers: { "content-type": "application/json", "cf-ray": "x" }, body: '{"level":"error"}' }),
    hops,
  );
  assert.equal(response.status, 202);
  const { header, body } = readHook(mac.sent[0]);
  assert.deepEqual(header.query, { env: "prod" });
  assert.equal(header.headers["content-type"], "application/json");
  assert.equal(header.headers["cf-ray"], undefined);
  assert.equal(new TextDecoder().decode(body), '{"level":"error"}');
});

test("the SQL storage keeps order, counts, sums and BLOB bytes (node:sqlite standing in for the Durable Object)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const values = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      const rows = /^\s*SELECT/i.test(query) ? statement.all(...values) : (statement.run(...values), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error("Expected one row");
          return rows[0];
        },
      };
    },
  };
  const storage = sqlHookStorage(sql);
  storage.hooks.add(A);
  storage.hooks.add(A);
  storage.hooks.add(B);
  assert.equal(storage.hooks.has(A), true);
  assert.deepEqual([...storage.hooks].sort(), [A, B]);
  storage.hooks.delete(B);
  assert.equal(storage.hooks.has(B), false);
  assert.equal(storage.deliveries.size(), 0);
  assert.equal(storage.deliveries.bytes(), 0);
  const body = new Uint8Array([0, 1, 255, 10]);
  const view = new Uint8Array(new Uint8Array([9, 9, ...body, 9]).buffer, 2, 4); // a view into a larger buffer
  storage.deliveries.put({ id: "late", hook: A, receivedAt: 20, size: 4, headers: { h: "1" }, query: { q: "2" }, body: view });
  storage.deliveries.put({ id: "early", hook: B, receivedAt: 10, size: 3, headers: {}, query: {}, body: new Uint8Array([1, 2, 3]) });
  storage.deliveries.put({ id: "tie", hook: A, receivedAt: 20, size: 1, headers: {}, query: {}, body: new Uint8Array([7]) });
  assert.deepEqual(storage.deliveries.list(), [
    { id: "early", hook: B, receivedAt: 10, size: 3 },
    { id: "late", hook: A, receivedAt: 20, size: 4 },
    { id: "tie", hook: A, receivedAt: 20, size: 1 },
  ]);
  assert.equal(storage.deliveries.size(), 3);
  assert.equal(storage.deliveries.bytes(), 8);
  const got = storage.deliveries.get("late");
  assert.deepEqual(got.body, body);
  assert.deepEqual(got.headers, { h: "1" });
  assert.deepEqual(got.query, { q: "2" });
  storage.deliveries.delete("late");
  assert.equal(storage.deliveries.get("late"), null);
  assert.equal(storage.deliveries.bytes(), 4);
  // The hook room runs on it as on memory.
  const hooks = createHookRoom({ storage, directory: memoryHookDirectory(), roomId: "room-1", now: () => 30 });
  await hooks.onFrame(HOOK_SET, setFrame([A]), () => true);
  assert.equal((await hooks.receive(A, request("x"))).status, 202);
  assert.equal(storage.deliveries.size(), 3);
});
