const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { b64url, boxKeyPair } = require("@milagre/shared/relay-crypto");
const { createAssembler, fromBase64 } = require("@milagre/shared/relay-rpc");
const { readIdentity } = require("./relay-identity.cjs");
const { createDevices } = require("./devices.cjs");
const { startRelayHost, createTransportDiagnostics, transportDiagnostics } = require("./relay-host.cjs");
const {
  random,
  TOKEN,
  LIVE_ORIGIN,
  sleep,
  listen,
  until,
  startFakeBridge,
  connectPhone,
  connectDesktop,
  fakePeerDaemon,
  startLocalRelay: startRelay,
} = require("./relay-test-kit.cjs");

async function startMac(
  t,
  { relayUrl, bridgeUrl, canPair = () => false, token = TOKEN, timing, onStatus, openPeer, allowComputer = async () => "allowed", WebSocket, diagnostics } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-host-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const identity = await readIdentity(dir);
  const phones = createDevices(dir);
  await phones.load();
  const statuses = [];
  const host = startRelayHost({
    relayUrl,
    identity,
    phones,
    token,
    bridgeUrl,
    canPair: (key) => canPair(key),
    timing,
    openPeer,
    allowComputer,
    ...(WebSocket ? { WebSocket } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    onStatus: (status) => {
      statuses.push(status);
      onStatus?.(status);
    },
  });
  t.after(() => host.close());
  return { host, identity, phones, dir, statuses };
}

async function paired(t, options = {}) {
  const relay = options.relay ?? (await startRelay(t));
  const bridge = options.bridge ?? (await startFakeBridge(t));
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, canPair: () => true, ...options.mac });
  await until(() => mac.host.status() === "online", "host online");
  const connect = async () => {
    const phone = connectPhone({ relayUrl: relay.url, identity: mac.identity });
    t.after(() => phone.close());
    const result = await phone.hello();
    assert.ok(result.channel, `hello refused: ${JSON.stringify(result)}`);
    return phone;
  };
  return { relay, bridge, mac, connect };
}

const decode = (bytes) => new TextDecoder().decode(bytes);

test("a paired phone calls /rpc through the relay", async (t) => {
  const { bridge, connect } = await paired(t);
  const phone = await connect();
  phone.request(1, {
    method: "POST",
    path: "/rpc",
    headers: { "content-type": "application/json", origin: "https://evil.example", authorization: "Bearer nope" },
    body: '{"v":1,"method":"daemon:status","args":[]}',
  });
  const response = await phone.response(1);
  assert.equal(response.status, 200);
  assert.equal(decode(response.body), '{"v":1,"result":"pong"}');
  assert.deepEqual(response.headers, { "content-type": "application/json", etag: '"abc"' });
  assert.equal(bridge.seen.lastBody, '{"v":1,"method":"daemon:status","args":[]}');
  const request = bridge.seen.requests.at(-1);
  assert.equal(request.origin, undefined, "the bridge refuses requests that carry an Origin");
  assert.match(request.host, /^127\.0\.0\.1:\d+$/);
  phone.send({ t: "ping" });
  assert.deepEqual(await phone.next(), { t: "pong" });
});

test("a 600 KB media response arrives in 3 chunks and reassembles", async (t) => {
  const { connect } = await paired(t);
  const phone = await connect();
  phone.request(7, { path: "/media" });
  const parts = [];
  const assembler = createAssembler();
  let result;
  while (!result?.done) {
    const message = await phone.next();
    assert.equal(message.t, "res");
    parts.push(message);
    result = assembler.add(message);
  }
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((part) => part.more),
    [true, true, false],
  );
  assert.equal(fromBase64(parts[0].chunk).length, 262144);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, new Uint8Array(600_000).fill(7));
});

test('an unknown phone with a stale token gets {t:"error",code:"bad-token"} and a close', async (t) => {
  const { relay, mac } = await paired(t);
  const phone = connectPhone({ relayUrl: relay.url, identity: mac.identity, token: "b".repeat(64) });
  t.after(() => phone.close());
  const result = await phone.hello();
  assert.deepEqual(result, { error: { t: "error", code: "bad-token" } });
  assert.equal(mac.phones.isKnown(b64url(phone.key.publicKey)), false);
  // The relay forwards the Mac's close frame; the phone socket ends.
  assert.equal((await phone.closed).code, 1000);
});

test("a retired host holds its old room only to tell every phone the Mac was reset", async (t) => {
  const relay = await startRelay(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-retired-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const old = await readIdentity(dir);
  const host = startRelayHost({ relayUrl: relay.url, identity: { hostId: old.hostId, sign: old.sign }, retired: true });
  t.after(() => host.close());
  await until(() => host.status() === "online", "retired host online");
  // A phone that paired before the reset, with the token it still has.
  const phone = connectPhone({ relayUrl: relay.url, identity: old });
  t.after(() => phone.close());
  assert.deepEqual(await phone.hello(), { error: { t: "error", code: "bad-token", reason: "reset" } });
  assert.equal((await phone.closed).code, 1000);
});

test("a new phone outside the pairing window gets unknown-phone; inside it, it pairs and is remembered", async (t) => {
  let open = false;
  const { relay, mac } = await paired(t, { mac: { canPair: () => open } });
  const outside = connectPhone({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => outside.close());
  assert.deepEqual(await outside.hello(), { error: { t: "error", code: "unknown-phone" } });
  await outside.closed;

  open = true;
  const key = boxKeyPair(random);
  const inside = connectPhone({ relayUrl: relay.url, identity: mac.identity, key });
  t.after(() => inside.close());
  assert.ok((await inside.hello()).channel);
  inside.send({ t: "ping" });
  assert.deepEqual(await inside.next(), { t: "pong" });
  const id = b64url(key.publicKey);
  assert.equal(mac.phones.isKnown(id), true);
  assert.match(await fs.readFile(path.join(mac.dir, "devices.json"), "utf8"), new RegExp(id));
  inside.close();

  open = false;
  const again = connectPhone({ relayUrl: relay.url, identity: mac.identity, key });
  t.after(() => again.close());
  assert.ok((await again.hello()).channel, "a remembered phone needs no pairing window");
});

test("the host reconnects after the relay drops it and phones can connect again", async (t) => {
  const relay = await startRelay(t);
  const bridge = await startFakeBridge(t);
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, canPair: () => true, timing: { backoff: [20, 40], jitter: false } });
  await until(() => mac.host.status() === "online", "host online");
  const first = connectPhone({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => first.close());
  assert.ok((await first.hello()).channel);

  relay.hostSockets.at(-1).terminate();
  await until(() => mac.statuses.includes("offline"), "host offline");
  await first.closed;
  await until(() => mac.host.status() === "online" && relay.hostSockets.length === 2, "host back online");

  const second = connectPhone({ relayUrl: relay.url, identity: mac.identity, key: first.key });
  t.after(() => second.close());
  assert.ok((await second.hello()).channel);
  second.request(1, { method: "POST", path: "/rpc", body: "{}" });
  assert.equal(decode((await second.response(1)).body), '{"v":1,"result":"pong"}');
});

test("a silent relay is abandoned after the idle timeout and the host dials again", async (t) => {
  const relay = await startRelay(t, { autoPong: false });
  const bridge = await startFakeBridge(t);
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { pingMs: 30, idleMs: 150, backoff: [20], jitter: false } });
  await until(() => relay.hostSockets.length >= 2, "a second dial after the idle drop");
  assert.ok(mac.statuses.includes("offline"));
});

test("live-open forwards the bridge live socket messages, and live-close closes it", async (t) => {
  const { bridge, connect } = await paired(t);
  const phone = await connect();
  phone.send({ t: "live-open", id: 3, path: "/live?projectPath=%2Ftmp" });
  assert.deepEqual(await phone.next(), { t: "live", id: 3, data: '{"v":1,"hello":1}' });
  assert.deepEqual(bridge.seen.liveHeaders.at(-1), { authorization: `Bearer ${TOKEN}`, origin: LIVE_ORIGIN, url: "/live?projectPath=%2Ftmp" });
  phone.send({ t: "live", id: 3, data: "hi" });
  assert.deepEqual(await phone.next(), { t: "live", id: 3, data: "echo:hi" });

  const closed = new Promise((resolve) => bridge.lives[0].on("close", resolve));
  phone.send({ t: "live-close", id: 3 });
  await closed;

  phone.send({ t: "live-open", id: 4, path: "/live" });
  assert.equal((await phone.next()).t, "live");
  bridge.lives[1].close(1001);
  const message = await phone.next();
  assert.equal(message.t, "live-close");
  assert.equal(message.id, 4);
});

test("a live-open with a path that is not a route is refused", async (t) => {
  const { bridge, connect } = await paired(t);
  const phone = await connect();
  phone.send({ t: "live-open", id: 10, path: "no-slash" });
  assert.deepEqual(await phone.next(), { t: "live-close", id: 10, code: 1008 });
  assert.equal(bridge.seen.liveOpen, 0);
});

test("a connection is limited to 8 live sockets and 16 requests in flight, with 64 more waiting their turn", async (t) => {
  const { bridge, connect } = await paired(t);
  const phone = await connect();
  for (let id = 1; id <= 9; id++) phone.send({ t: "live-open", id, path: "/live" });
  const refused = [];
  const hellos = new Set();
  while (!refused.length || hellos.size < 8) {
    const message = await phone.next();
    if (message.t === "live-close") refused.push(message);
    else hellos.add(message.id);
  }
  assert.deepEqual(refused, [{ t: "live-close", id: 9, code: 1013 }]);
  assert.equal(bridge.seen.liveOpen, 8);

  for (let id = 100; id < 181; id++) phone.request(id, { path: "/slow" });
  const over = await phone.response(180);
  assert.equal(over.status, 429, "past 16 running and 64 waiting a flood is refused");
  assert.equal(decode(over.body), '{"v":1,"error":{"message":"Too many requests"}}');
  await until(() => bridge.waiting() === 16, "the 16 requests to reach the bridge");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.waiting(), 16, "the rest wait on the Mac, not at the bridge");
  // A busy Mac answering slowly: each free slot takes the next waiting request, so every one is answered.
  const freeing = setInterval(() => bridge.release(), 10);
  t.after(() => clearInterval(freeing));
  // Answers come back in any order, so read them all in one pass.
  const statuses = new Map();
  while (statuses.size < 80) {
    const message = await phone.next();
    if (message.t === "res" && !message.more) statuses.set(message.id, message.status);
  }
  assert.deepEqual(new Set(statuses.values()), new Set([200]));
});

test("a request that waited too long on the Mac is refused unread, never run late", async (t) => {
  const { bridge, connect } = await paired(t, { mac: { timing: { queueWaitMs: 150 } } });
  const phone = await connect();
  for (let id = 1; id <= 17; id++) phone.request(id, { path: "/slow" });
  await until(() => bridge.waiting() === 16, "16 requests to reach the bridge");
  const late = await phone.response(17);
  assert.equal(late.status, 429, "the phone can't cancel it, so the Mac turns it away instead of running it later");
  bridge.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bridge.waiting(), 0, "the refused request never reached the bridge");
});

test("a bad frame closes only that phone", async (t) => {
  const { connect } = await paired(t);
  const a = await connect();
  const b = await connect();
  a.ws.send(new Uint8Array(40).fill(3));
  assert.equal((await a.closed).code, 1000);
  b.send({ t: "ping" });
  assert.deepEqual(await b.next(), { t: "pong" });
});

test("closing the host closes its phones and stops reconnecting", async (t) => {
  const { relay, mac, connect } = await paired(t);
  const phone = await connect();
  await mac.host.close();
  await phone.closed;
  await sleep(100);
  assert.equal(relay.hostSockets.length, 1);
  assert.equal(mac.host.status(), "offline");
});

test("a relay that sends a malformed challenge cannot crash the host, which dials again", async (t) => {
  const bad = ["!!", "AAAA", ""];
  const relay = await startRelay(t, {
    hostBehavior: (ws, index) => index < bad.length && (ws.send(JSON.stringify({ t: "challenge", nonce: bad[index] })), true),
  });
  const bridge = await startFakeBridge(t);
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { backoff: [20], jitter: false } });
  await until(() => mac.host.status() === "online" && relay.hostSockets.length === bad.length + 1, "host online after the bad challenges");
});

test("a relay that accepts the socket but never sends a challenge, or never answers the proof, is abandoned", async (t) => {
  const relay = await startRelay(t, {
    hostBehavior: (ws, index) => index === 0 || (index === 1 && (ws.send(JSON.stringify({ t: "challenge", nonce: "A".repeat(43) })), true)),
  });
  const bridge = await startFakeBridge(t);
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { idleMs: 100, pingMs: 60000, backoff: [20], jitter: false } });
  await until(() => mac.host.status() === "online" && relay.hostSockets.length === 3, "host online on the third dial");
});

test("a relay that never answers the upgrade is abandoned at the handshake timeout", async (t) => {
  const stalled = require("node:net").createServer((socket) => {
    socket.on("error", () => {});
  });
  const port = await listen(stalled);
  t.after(() => {
    stalled.close();
    stalled.closeAllConnections?.();
  });
  let dials = 0;
  stalled.on("connection", () => {
    dials += 1;
  });
  const mac = await startMac(t, { relayUrl: `ws://127.0.0.1:${port}`, bridgeUrl: "http://127.0.0.1:1", timing: { idleMs: 100, backoff: [20], jitter: false } });
  await until(() => dials >= 2, "a second dial after the handshake timeout");
  assert.ok(mac.statuses.includes("offline"));
});

test("a 3 MB upload split into 256 KiB chunks reaches the bridge byte for byte", async (t) => {
  const { bridge, connect } = await paired(t);
  const phone = await connect();
  const body = new Uint8Array(randomBytes(3_000_000));
  phone.request(5, { method: "POST", path: "/attachments", headers: { "content-type": "application/octet-stream" }, body });
  const response = await phone.response(5);
  assert.equal(response.status, 200);
  assert.equal(decode(response.body), '{"v":1,"result":{"size":3000000}}');
  assert.equal(bridge.seen.uploads.length, 1);
  assert.equal(bridge.seen.uploads[0].type, "application/octet-stream");
  assert.deepEqual(new Uint8Array(bridge.seen.uploads[0].body), body);
});

test("an upload over 8 MiB is refused with 413 and the connection stays usable", async (t) => {
  const { bridge, connect } = await paired(t);
  const phone = await connect();
  phone.request(6, { method: "POST", path: "/attachments", body: new Uint8Array(9 * 1024 * 1024) });
  const response = await phone.response(6);
  assert.equal(response.status, 413);
  assert.equal(decode(response.body), '{"v":1,"error":{"message":"Upload too large"}}');
  assert.equal(bridge.seen.uploads.length, 0);
  phone.request(7, { method: "POST", path: "/rpc", body: "{}" });
  assert.equal(decode((await phone.response(7)).body), '{"v":1,"result":"pong"}');
});

test("a GET with an empty chunk and an invalid part both behave", async (t) => {
  const { connect } = await paired(t);
  const phone = await connect();
  phone.send({ t: "req", id: 1, method: "GET", path: "/media", headers: {}, chunk: "", more: false });
  assert.equal((await phone.response(1)).status, 200);
  phone.send({ t: "req", id: 2, method: "POST", path: "/attachments", headers: {}, chunk: "***", more: false });
  assert.equal((await phone.closed).code, 1000);
});

test("a phone that never completes its hello is closed at the hello deadline; a paired one stays", async (t) => {
  const { relay, mac, connect } = await paired(t, { mac: { timing: { helloMs: 150 } } });
  const good = await connect();
  const silent = connectPhone({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => silent.close());
  await silent.opened;
  const started = Date.now();
  const closed = await Promise.race([silent.closed, sleep(3000).then(() => null)]);
  assert.ok(closed, "the silent phone was never closed");
  assert.equal(closed.code, 1000);
  assert.equal(closed.reason, "closed-by-host");
  assert.ok(Date.now() - started >= 100, "closed before the deadline");
  await sleep(200);
  good.send({ t: "ping" });
  assert.deepEqual(await good.next(), { t: "pong" });
});

/** A relay that answers the proof with ready and then does `after(ws)`: a stand-in for a flapping or replacing relay. */
function scriptedRelay(t, plan) {
  const dials = [],
    closes = [];
  return startRelay(t, {
    hostBehavior: (ws, index) => {
      dials.push(Date.now());
      ws.on("close", () => closes.push(Date.now()));
      const step = plan(index);
      if (!step) return false;
      ws.send(JSON.stringify({ t: "challenge", nonce: b64url(random(32)) }));
      ws.once("message", () => {
        ws.send(JSON.stringify({ t: "ready" }));
        step(ws);
      });
      return true;
    },
  }).then((relay) => ({ ...relay, dials, closes }));
}

test("a host closed as replaced (4409) waits replacedMs before dialing again; other closes keep the short backoff", async (t) => {
  const bridge = await startFakeBridge(t);
  for (const [code, slow] of [
    [4409, true],
    [1011, false],
  ]) {
    const relay = await scriptedRelay(t, (index) => index === 0 && ((ws) => ws.close(code, "bye")));
    const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { backoff: [20], replacedMs: 400, jitter: false } });
    await until(() => mac.host.status() === "online" && relay.dials.length === 2, `back online after ${code}`);
    const gap = relay.dials[1] - relay.closes[0];
    if (slow) assert.ok(gap >= 380, `after 4409 the host waited ${gap} ms`);
    else assert.ok(gap < 300, `after ${code} the host waited only ${gap} ms`);
    await mac.host.close();
  }
});

test("the 4409 wait is jittered but never shorter than replacedMs", async (t) => {
  const bridge = await startFakeBridge(t);
  const relay = await scriptedRelay(t, (index) => index === 0 && ((ws) => ws.close(4409, "replaced")));
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { backoff: [20], replacedMs: 300, jitter: true } });
  await until(() => mac.host.status() === "online" && relay.dials.length === 2, "back online");
  const gap = relay.dials[1] - relay.closes[0];
  assert.ok(gap >= 280 && gap < 300 * 1.4 + 150, `waited ${gap} ms`);
});

test("a relay that drops the host right after ready keeps backing off: ready alone does not reset the backoff", async (t) => {
  const bridge = await startFakeBridge(t);
  const relay = await scriptedRelay(t, (index) => index < 3 && ((ws) => setTimeout(() => ws.close(1011), 10)));
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { backoff: [20, 150, 400], stableMs: 10_000, jitter: false } });
  await until(() => mac.host.status() === "online" && relay.dials.length === 4, "the fourth dial", 8000);
  const gaps = [0, 1, 2].map((i) => relay.dials[i + 1] - relay.closes[i]);
  assert.ok(gaps[1] >= 140 && gaps[2] >= 380, `gaps grew: ${gaps.join(", ")} ms`);
});

test("a session that stays up for stableMs resets the backoff", async (t) => {
  const bridge = await startFakeBridge(t);
  // First session flaps (attempt 1), the second stays up past stableMs and then drops.
  const relay = await scriptedRelay(t, (index) =>
    index === 0 ? (ws) => setTimeout(() => ws.close(1011), 10) : index === 1 ? (ws) => setTimeout(() => ws.close(1011), 250) : null,
  );
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { backoff: [20, 600], stableMs: 100, jitter: false } });
  await until(() => mac.host.status() === "online" && relay.dials.length === 3, "the third dial");
  const gap = relay.dials[2] - relay.closes[1];
  assert.ok(gap < 300, `after a stable session the host redialed in ${gap} ms`);
});

test("a 4409 before ready keeps the short backoff: a replaced pending socket is no sign of a twin Mac", async (t) => {
  const bridge = await startFakeBridge(t);
  const dials = [],
    closes = [];
  // Anyone who knows the hostId can open pending sockets and knock the Mac's pending one off with 4409.
  const relay = await startRelay(t, {
    hostBehavior: (ws, index) => {
      dials.push(Date.now());
      ws.on("close", () => closes.push(Date.now()));
      if (index > 0) return false;
      ws.send(JSON.stringify({ t: "challenge", nonce: b64url(random(32)) }));
      ws.once("message", () => ws.close(4409, "replaced"));
      return true;
    },
  });
  const mac = await startMac(t, { relayUrl: relay.url, bridgeUrl: bridge.url, timing: { backoff: [20], replacedMs: 400, jitter: false } });
  await until(() => mac.host.status() === "online" && dials.length === 2, "back online");
  const gap = dials[1] - closes[0];
  assert.ok(gap < 300, `a pending 4409 waited only ${gap} ms`);
});

test("a phone's hello names it: a first pairing saves the name, a later hello renames it, and drop closes it", async (t) => {
  const { relay, mac } = await paired(t);
  const key = boxKeyPair(random);
  const id = b64url(key.publicKey);
  const first = connectPhone({ relayUrl: relay.url, identity: mac.identity, key, name: "iPhone 16 Pro" });
  t.after(() => first.close());
  assert.ok((await first.hello()).channel);
  assert.equal(mac.phones.list().find((device) => device.key === id).name, "iPhone 16 Pro");
  assert.deepEqual(mac.host.connectedKeys(), [id]);
  first.close();
  await until(() => mac.host.connectedKeys().length === 0, "the closed channel is gone");

  const second = connectPhone({ relayUrl: relay.url, identity: mac.identity, key, name: "Victor's iPhone" });
  t.after(() => second.close());
  assert.ok((await second.hello()).channel);
  await until(() => mac.phones.list().find((device) => device.key === id).name === "Victor's iPhone", "renamed by the hello");
  // The hello does not wait for the write, so wait for the file before the test's cleanup removes the directory.
  await until(
    async () => (await fs.readFile(path.join(mac.dir, "devices.json"), "utf8").catch(() => "")).includes("Victor's iPhone"),
    "the name written to devices.json",
  );
  mac.host.drop(id);
  await second.closed;
  assert.deepEqual(mac.host.connectedKeys(), []);
});

test("a desktop's hello is turned away with reason kind and saved nowhere", async (t) => {
  const { relay, mac } = await paired(t);
  const key = boxKeyPair(random);
  const desktop = connectPhone({ relayUrl: relay.url, identity: mac.identity, key, kind: "desktop", name: "studio" });
  t.after(() => desktop.close());
  assert.deepEqual(await desktop.hello(), { error: { t: "error", code: "bad-hello", reason: "kind" } });
  assert.equal(mac.phones.isKnown(b64url(key.publicKey)), false);
});

test("the pairing window can stay closed to one phone while another pairs", async (t) => {
  const blocked = boxKeyPair(random);
  const { relay, mac, connect } = await paired(t, { mac: { canPair: (key) => key !== b64url(blocked.publicKey) } });
  const phone = connectPhone({ relayUrl: relay.url, identity: mac.identity, key: blocked });
  t.after(() => phone.close());
  assert.deepEqual(await phone.hello(), { error: { t: "error", code: "unknown-phone" } });
  await connect();
});

test("a desktop pairs in the window as a computer, and its frames reach the daemon and come back, in parts past 768 KiB", async (t) => {
  const daemon = fakePeerDaemon();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity, name: "studio" });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  const id = b64url(desktop.key.publicKey);
  assert.deepEqual(
    mac.phones.list().map((device) => [device.key, device.kind, device.name]),
    [[id, "computer", "studio"]],
  );
  assert.deepEqual(mac.host.connectedKeys(), [id]);
  assert.deepEqual((await desktop.call("daemon:status")).result, { echo: [] });
  // Both ways through the real room, whose frames stop at 1 MiB.
  const big = "ação🙂".repeat(150_000);
  assert.deepEqual((await desktop.call("echo", [big])).result, { echo: [big] });
  assert.ok(desktop.messages.filter((message) => message.t === "part").length >= 3, "the reply came in parts");
  desktop.sendMessage({ t: "ping" });
  await until(() => desktop.messages.some((message) => message.t === "pong"), "pong");
  assert.equal(desktop.error, null);
});

test("a desktop cannot speak HTTP-over-channel: a req closes its channel and its daemon connection", async (t) => {
  const daemon = fakePeerDaemon();
  const { relay, bridge, mac } = await paired(t, { mac: { openPeer: daemon.openPeer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  desktop.sendMessage({ t: "req", id: 1, method: "POST", path: "/rpc", headers: {}, chunk: "", more: false });
  await desktop.closed;
  await until(() => daemon.connections[0].closed, "the daemon connection closed");
  assert.equal(bridge.seen.requests.length, 0, "nothing reached the bridge");
});

test("a device keeps the kind it paired as: a phone's key saying desktop, and a computer's saying phone, are turned away", async (t) => {
  const daemon = fakePeerDaemon();
  const { relay, mac, connect } = await paired(t, { mac: { openPeer: daemon.openPeer } });
  const phone = await connect();
  const asDesktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity, key: phone.key });
  t.after(() => asDesktop.close());
  assert.deepEqual(await asDesktop.hello(), { error: { t: "error", code: "bad-hello", reason: "kind" } });
  assert.equal(daemon.connections.length, 0);
  const computer = boxKeyPair(random);
  await mac.phones.add(b64url(computer.publicKey), { kind: "computer", name: "studio" });
  const asPhone = connectPhone({ relayUrl: relay.url, identity: mac.identity, key: computer });
  t.after(() => asPhone.close());
  assert.deepEqual(await asPhone.hello(), { error: { t: "error", code: "bad-hello", reason: "kind" } });
  assert.deepEqual(
    mac.phones.list().map((device) => device.kind),
    ["phone", "computer"],
    "both stay as they paired",
  );
});

test("dropping a desktop's key closes its channel and its daemon connection", async (t) => {
  const daemon = fakePeerDaemon();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  mac.host.drop(b64url(desktop.key.publicKey));
  assert.equal((await desktop.closed).code, 1000);
  assert.equal(daemon.connections[0].closed, true);
  assert.deepEqual(mac.host.connectedKeys(), []);
});

test("losing the relay closes every desktop's daemon connection", async (t) => {
  const daemon = fakePeerDaemon();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  relay.hostSockets[0].terminate();
  await until(() => daemon.connections[0].closed, "closed with the relay");
});

test("a desktop outside the pairing window gets unknown-phone and is saved nowhere", async (t) => {
  const daemon = fakePeerDaemon();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, canPair: () => false } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.deepEqual(await desktop.hello(), { error: { t: "error", code: "unknown-phone" } });
  assert.equal(mac.phones.count(), 0);
  assert.equal(daemon.connections.length, 0);
});

test("a bad part gets its error reply before the channel closes", async (t) => {
  const daemon = fakePeerDaemon();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  // A part of a frame nobody started: the reader refuses it, the daemon answers with the error and then ends.
  desktop.sendMessage({ t: "part", id: 99, i: 5, n: 7, data: "x" });
  const reply = await until(() => desktop.frames.find((frame) => frame.error), "the error reply");
  assert.ok(reply.error.code, "the error carries a code");
  await desktop.closed;
  assert.equal(daemon.connections[0].closed, true);
  assert.equal(desktop.error, null);
});

test("a desktop whose daemon connection can't open is dropped, and never reaches the bridge", async (t) => {
  const openPeer = () => {
    throw new Error("no daemon");
  };
  const { relay, bridge, mac } = await paired(t, { mac: { openPeer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  // Sent at once, like a desktop that doesn't wait: if the channel stayed open this would reach the bridge.
  try {
    desktop.sendMessage({ t: "req", id: 1, method: "POST", path: "/rpc", headers: {}, chunk: "", more: false });
  } catch {
    /* already closed */
  }
  await desktop.closed;
  await sleep(50);
  assert.equal(bridge.seen.requests.length, 0, "nothing reached the bridge");
  assert.deepEqual(mac.host.connectedKeys(), []);
  assert.equal(mac.host.status(), "online", "the host carries on");
});

test("a daemon connection that ends while it is being opened is closed, not leaked", async (t) => {
  const connections = [];
  const openPeer = (carrier) => {
    const connection = { closed: false };
    connections.push(connection);
    carrier.end();
    return { receive() {}, invalid() {}, close: () => (connection.closed = true) };
  };
  const { relay, mac } = await paired(t, { mac: { openPeer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  await desktop.closed;
  await until(() => connections[0]?.closed, "the connection closed");
  assert.deepEqual(mac.host.connectedKeys(), []);
});

test("a phone response in flight on the shared relay socket does not drop a connected desktop", async (t) => {
  // What one ~30 MiB phone response holds on the Mac's relay socket (about 40 MiB on the wire) while a desktop is connected.
  const busy = { amount: 0 };
  class BusySocket extends require("ws").WebSocket {
    get bufferedAmount() {
      return busy.amount || super.bufferedAmount;
    }
  }
  const daemon = fakePeerDaemon();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, WebSocket: BusySocket } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  busy.amount = 40 * 1024 * 1024;
  assert.deepEqual((await desktop.call("daemon:status")).result, { echo: [] });
  assert.equal(daemon.connections[0].closed, false, "the desktop's channel stands");
  assert.deepEqual(mac.host.connectedKeys(), [b64url(desktop.key.publicKey)]);
  busy.amount = 0;
});

test("a device store that throws while a hello is read drops that channel and the host carries on", async (t) => {
  const { relay, mac, connect } = await paired(t, { mac: { openPeer: fakePeerDaemon().openPeer } });
  const known = boxKeyPair(random);
  await mac.phones.add(b64url(known.publicKey), { kind: "phone", name: "known" });
  const original = mac.phones.kindOf;
  mac.phones.kindOf = () => {
    throw new Error("store broke");
  };
  const phone = connectPhone({ relayUrl: relay.url, identity: mac.identity, key: known });
  t.after(() => phone.close());
  // Closed with no reply, or refused: either way the channel is gone.
  await Promise.race([phone.closed, phone.hello().catch(() => null)]);
  await phone.closed;
  mac.phones.kindOf = original;
  assert.equal(mac.host.status(), "online", "the host carries on");
  await connect();
});

/** An owner who answers when the test says: each request is recorded, and `answer(verdict)` settles the latest. */
function owner() {
  const asked = [];
  return {
    asked,
    allowComputer: (request) =>
      new Promise((resolve) => {
        asked.push({ ...request, answer: resolve });
        request.waiting();
      }),
    answer: (verdict) => asked.at(-1).answer(verdict),
  };
}

test("a computer's first hello waits for Allow, and only then is saved and gets its daemon connection", async (t) => {
  const daemon = fakePeerDaemon();
  const you = owner();
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, allowComputer: you.allowComputer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity, name: "studio" });
  t.after(() => desktop.close());
  const hello = desktop.hello({ ms: 10_000 });
  await until(() => desktop.notices.length > 0, "the pending notice");
  assert.deepEqual(desktop.notices[0], { t: "pending" });
  assert.deepEqual(
    you.asked.map(({ key, name }) => [key, name]),
    [[b64url(desktop.key.publicKey), "studio"]],
  );
  assert.equal(mac.phones.count(), 0, "nothing saved before Allow");
  assert.equal(daemon.connections.length, 0, "no daemon connection before Allow");
  assert.deepEqual(mac.host.connectedKeys(), [], "a waiting computer isn't connected");
  you.answer("allowed");
  assert.ok((await hello).channel);
  assert.deepEqual(
    mac.phones.list().map((device) => [device.kind, device.name]),
    [["computer", "studio"]],
  );
  assert.deepEqual((await desktop.call("daemon:status")).result, { echo: [] });
});

test("Deny, a request past its window and a busy Mac turn the computer away with their reasons, saving nothing", async (t) => {
  for (const [verdict, error] of [
    ["denied", { t: "error", code: "unknown-phone", reason: "denied" }],
    ["expired", { t: "error", code: "unknown-phone" }],
    ["busy", { t: "error", code: "unknown-phone", reason: "busy" }],
  ]) {
    const daemon = fakePeerDaemon();
    const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, allowComputer: async () => verdict } });
    const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
    t.after(() => desktop.close());
    assert.deepEqual(await desktop.hello(), { error }, verdict);
    assert.equal(mac.phones.count(), 0, verdict);
    assert.equal(daemon.connections.length, 0, verdict);
  }
});

test("a phone pairs as before and a known computer reconnects, neither asking", async (t) => {
  const asked = [];
  const daemon = fakePeerDaemon();
  const { relay, mac, connect } = await paired(t, {
    mac: {
      openPeer: daemon.openPeer,
      allowComputer: async (request) => {
        asked.push(request.key);
        return "allowed";
      },
    },
  });
  await connect();
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  assert.equal(asked.length, 1, "the computer's first pairing asked");
  const again = connectDesktop({ relayUrl: relay.url, identity: mac.identity, key: desktop.key });
  t.after(() => again.close());
  assert.ok((await again.hello()).channel);
  assert.equal(asked.length, 1, "its reconnect did not");
});

test("a held hello outlasts the hello timeout, hearing a notice every few seconds", async (t) => {
  const daemon = fakePeerDaemon();
  const you = owner();
  const { relay, mac } = await paired(t, {
    mac: { openPeer: daemon.openPeer, allowComputer: you.allowComputer, timing: { helloMs: 200, pendingRepeatMs: 40 } },
  });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  const hello = desktop.hello({ ms: 10_000 });
  await sleep(600);
  assert.ok(desktop.notices.length >= 3, `notices: ${desktop.notices.length}`);
  you.answer("allowed");
  assert.ok((await hello).channel, "still open after three hello timeouts");
});

test("a computer that leaves while it waits drops its request", async (t) => {
  const you = owner();
  const { relay, mac } = await paired(t, { mac: { openPeer: fakePeerDaemon().openPeer, allowComputer: you.allowComputer } });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  void desktop.hello({ ms: 2000 }).catch(() => {});
  await until(() => you.asked.length === 1, "the request");
  desktop.close();
  await until(() => you.asked[0].signal.aborted, "the request dropped");
  assert.equal(mac.phones.count(), 0);
});

test("a request that throws is aborted, so nothing is left waiting for it", async (t) => {
  const signals = [];
  const { relay, mac } = await paired(t, {
    mac: {
      openPeer: fakePeerDaemon().openPeer,
      allowComputer: async (request) => {
        signals.push(request.signal);
        throw new Error("boom");
      },
    },
  });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).error, "turned away");
  assert.equal(signals[0].aborted, true, "the request was told to stop");
  assert.equal(mac.phones.count(), 0);
});

test("waiting() runs once however often it is called, and not at all after the request is over", async (t) => {
  let request;
  const { relay, mac } = await paired(t, {
    mac: {
      openPeer: fakePeerDaemon().openPeer,
      allowComputer: (asked) =>
        new Promise((resolve) => {
          request = { ...asked, resolve };
          asked.waiting();
          asked.waiting();
        }),
      timing: { helloMs: 200, pendingRepeatMs: 20 },
    },
  });
  const desktop = connectDesktop({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => desktop.close());
  const hello = desktop.hello({ ms: 10_000 });
  await until(() => desktop.notices.length >= 3, "notices");
  request.resolve("allowed");
  assert.ok((await hello).channel);
  request.waiting();
  // A notice sent once the channel is open is not sealed: the desktop's reader fails on it.
  await sleep(120);
  assert.equal(desktop.error, null, "no notice repeats once the owner has answered");
});

test("a computer's second hello replaces its first while it waits, and the new channel keeps hearing that it waits", async (t) => {
  const daemon = fakePeerDaemon();
  // As phone.cjs does: a second request from the same key settles the first one as dropped.
  const waiting = new Map();
  const allowComputer = (request) =>
    new Promise((resolve) => {
      waiting.get(request.key)?.("dropped");
      waiting.set(request.key, resolve);
      request.waiting();
    });
  const { relay, mac } = await paired(t, { mac: { openPeer: daemon.openPeer, allowComputer, timing: { pendingRepeatMs: 30 } } });
  const key = boxKeyPair(random);
  const first = connectDesktop({ relayUrl: relay.url, identity: mac.identity, key, name: "studio" });
  t.after(() => first.close());
  const refused = first.hello({ ms: 10_000 });
  await until(() => first.notices.length > 0, "the first channel's notice");
  const second = connectDesktop({ relayUrl: relay.url, identity: mac.identity, key, name: "studio" });
  t.after(() => second.close());
  const accepted = second.hello({ ms: 10_000 });
  assert.deepEqual((await refused).error, { t: "error", code: "unknown-phone" });
  const heard = second.notices.length;
  await until(() => second.notices.length >= heard + 2, "the second channel's repeated notices");
  waiting.get(b64url(key.publicKey))("allowed");
  assert.ok((await accepted).channel);
});

// Webhooks over the host connection (frames 4-7 on conn 0, apps/relay/src/hooks.mjs).
const crypto = require("node:crypto");
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const HOOK_SECRET = "H".repeat(43);
const HOOK_ID = sha(HOOK_SECRET);

async function hookMac(t, relay, hooks, identityDir) {
  const dir = identityDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "relay-host-hooks-")));
  if (!identityDir) t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const identity = await readIdentity(dir);
  const host = startRelayHost({ relayUrl: relay.url, identity, hooks, hooksOnly: true });
  t.after(() => host.close());
  await until(() => host.status() === "online", "host online");
  return { host, identity, dir };
}
function hookSet(ids, extra = {}) {
  return { ids: () => ids, receive: () => ({ ack: true }), refused: () => {}, owners: () => ({}), ...extra };
}
const roomOf = (relay, identity) => relay.hooks.rooms.get(identity.hostId);
const hookUrlFor = (relay, secret) => `${relay.url.replace(/^ws:/, "http:")}/hook/${secret}`;

test("deliveries that wait for the Mac arrive in order, in batches, and are acked only once receive has them", async (t) => {
  const relay = await startRelay(t);
  const batches = [];
  const hooks = hookSet([HOOK_ID], { receive: (list) => batches.push(list) });
  const first = await hookMac(t, relay, hooks);
  await until(() => relay.hooks.directory.owner(HOOK_ID) === first.identity.hostId, "registered");
  await first.host.close();
  for (const n of [1, 2, 3]) assert.equal((await relay.postHook(hookUrlFor(relay, HOOK_SECRET), JSON.stringify({ n }))).status, 202);
  assert.equal(roomOf(relay, first.identity).storage.deliveries.size(), 3);
  await hookMac(t, relay, hooks, first.dir);
  await until(() => roomOf(relay, first.identity).storage.deliveries.size() === 0, "all acked");
  // Frames that land in one read are one batch; a busy machine may split them, never reorder them.
  assert.ok(batches.length >= 1 && batches.length <= 3);
  const all = batches.flat();
  assert.deepEqual(
    all.map((delivery) => JSON.parse(new TextDecoder().decode(delivery.body)).n),
    [1, 2, 3],
  );
  assert.equal(all[0].hookId, HOOK_ID);
  assert.equal(all[0].headers["content-type"], "application/json");
});

test("a receive that throws acks nothing, so the relay keeps the delivery", async (t) => {
  const relay = await startRelay(t);
  let calls = 0;
  const mac = await hookMac(
    t,
    relay,
    hookSet([HOOK_ID], {
      receive: () => {
        calls += 1;
        throw new Error("disk full");
      },
    }),
  );
  await until(() => relay.hooks.directory.owner(HOOK_ID) === mac.identity.hostId, "registered");
  assert.equal((await relay.postHook(hookUrlFor(relay, HOOK_SECRET), "{}")).status, 202);
  await until(() => calls === 1, "receive called");
  await sleep(100);
  assert.equal(roomOf(relay, mac.identity).storage.deliveries.size(), 1);
});

test("every hook set carries the owner keys; a hook another room holds moves only for the right key, else it shows on its Routine", async (t) => {
  const relay = await startRelay(t);
  const OWNER = "K".repeat(43);
  await relay.hooks.directory.claim(HOOK_ID, "someone-else", OWNER);
  const refusals = [];
  // Only the URL secret: not enough.
  const wrong = await hookMac(t, relay, hookSet([HOOK_ID], { owners: () => ({ [HOOK_ID]: HOOK_SECRET }), refused: (ids) => refusals.push(ids) }));
  // Reported on the first answer and on the retry after it, never cleared in between (no flicker on the Routine).
  await until(() => refusals.length >= 2, "the retry's answer", 6000);
  assert.deepEqual(
    refusals,
    refusals.map(() => [HOOK_ID]),
  );
  assert.equal(relay.hooks.directory.owner(HOOK_ID), "someone-else");
  await wrong.host.close();

  const taken = [];
  const asked = [];
  const right = await hookMac(
    t,
    relay,
    hookSet([HOOK_ID], {
      owners: (ids) => {
        asked.push(ids);
        return { [HOOK_ID]: OWNER };
      },
      refused: (ids) => taken.push(ids),
    }),
  );
  await until(() => relay.hooks.directory.owner(HOOK_ID) === right.identity.hostId, "the hook to move here");
  assert.deepEqual(asked[0], [HOOK_ID], "the first set already carries the key");
  assert.ok(taken.every((ids) => ids.length === 0));
  assert.equal((await relay.postHook(hookUrlFor(relay, HOOK_SECRET), "{}")).status, 202);
});

test("syncHooks sends a changed set at once, and an unchanged one not at all", async (t) => {
  const relay = await startRelay(t);
  let ids = [HOOK_ID];
  const mac = await hookMac(t, relay, hookSet(null, { ids: () => ids }));
  await until(() => relay.hooks.directory.owner(HOOK_ID) === mac.identity.hostId, "registered");
  ids = [];
  mac.host.syncHooks();
  await until(() => relay.hooks.directory.owner(HOOK_ID) === null, "released");
  assert.equal((await relay.postHook(hookUrlFor(relay, HOOK_SECRET), "{}")).status, 404);
});

test("a host without hooks ignores hook frames and never registers anything", async (t) => {
  const { relay, mac } = await paired(t);
  const room = relay.hooks.rooms.get(mac.identity.hostId);
  // The relay would only send HOOK for a registered hook; force one anyway.
  room.storage.hooks.add(HOOK_ID);
  room.hooks.receive(HOOK_ID, { headers: {}, query: {}, body: new Uint8Array([1]) });
  room.hooks.onHostReady();
  await sleep(100);
  assert.equal(room.storage.deliveries.size(), 1, "never acked");
  assert.equal(relay.hooks.directory.owner(HOOK_ID), null);
  assert.equal(mac.host.status(), "online");
});

test("a claim the directory failed is asked for again until it lands", async (t) => {
  const relay = await startRelay(t);
  const directory = relay.hooks.directory;
  const claim = directory.claim;
  let calls = 0;
  directory.claim = (...args) => {
    calls += 1;
    if (calls === 1) throw new Error("directory down");
    return claim(...args);
  };
  const mac = await hookMac(t, relay, hookSet([HOOK_ID], { owners: () => ({ [HOOK_ID]: "K".repeat(43) }) }));
  await until(() => directory.owner(HOOK_ID) === mac.identity.hostId, "the hook to be registered after the failure", 6000);
  assert.ok(calls >= 2);
});

test("a retired room's host registers no hooks, so its room lets them go, and still acks what waited there", async (t) => {
  const relay = await startRelay(t);
  const received = [];
  const first = await hookMac(t, relay, hookSet([HOOK_ID], { owners: () => ({ [HOOK_ID]: "K".repeat(43) }) }));
  await until(() => relay.hooks.directory.owner(HOOK_ID) === first.identity.hostId, "registered");
  await first.host.close();
  assert.equal((await relay.postHook(hookUrlFor(relay, HOOK_SECRET), "{}")).status, 202);
  // The same identity, now retired by a Reset (phone.cjs hands it hooks with no ids).
  const retired = startRelayHost({
    relayUrl: relay.url,
    identity: first.identity,
    retired: true,
    hooks: hookSet([], { receive: (list) => received.push(...list) }),
  });
  t.after(() => retired.close());
  await until(() => relay.hooks.directory.owner(HOOK_ID) === null, "the old room to let go");
  await until(() => received.length === 1, "the waiting delivery");
  await until(() => roomOf(relay, first.identity).storage.deliveries.size() === 0, "acked");
});

test("with phone access off, a phone that dials the webhooks-only host hears the Mac is offline", async (t) => {
  const relay = await startRelay(t);
  const mac = await hookMac(t, relay, hookSet([HOOK_ID]));
  const phone = connectPhone({ relayUrl: relay.url, identity: mac.identity });
  t.after(() => phone.close());
  assert.deepEqual(await phone.closed, { code: 4404, reason: "host-offline" });
});

test("a draining host says drained once it has acked everything its room held, and not before", async (t) => {
  const relay = await startRelay(t);
  const first = await hookMac(t, relay, hookSet([HOOK_ID], { owners: () => ({ [HOOK_ID]: "K".repeat(43) }) }));
  await until(() => relay.hooks.directory.owner(HOOK_ID) === first.identity.hostId, "registered");
  await first.host.close();
  for (const n of [1, 2]) assert.equal((await relay.postHook(hookUrlFor(relay, HOOK_SECRET), JSON.stringify({ n }))).status, 202);
  const received = [];
  let drained = 0;
  let heldWhenDrained = null;
  // Every answer from the room (hooks.refused hears each one), and how many had come when the host was back online.
  let answers = 0;
  let answersWhenBack = null;
  const draining = startRelayHost({
    relayUrl: relay.url,
    identity: first.identity,
    retired: true,
    timing: { backoff: [20, 40], jitter: false },
    onStatus: (status) => {
      if (status === "online" && drained) answersWhenBack = answers;
    },
    hooks: hookSet([], {
      receive: (list) => received.push(...list),
      refused: () => (answers += 1),
      drained: () => {
        drained += 1;
        heldWhenDrained = roomOf(relay, first.identity).storage.deliveries.size();
      },
    }),
  });
  t.after(() => draining.close());
  await until(() => drained === 1, "drained", 6000);
  assert.equal(received.length, 2);
  assert.equal(heldWhenDrained, 0);
  assert.equal(relay.hooks.directory.owner(HOOK_ID), null, "its hooks released");
  // Dropped and back, the host asks its room again and hears that it still holds nothing.
  relay.hostSockets.at(-1).terminate();
  await until(() => answersWhenBack !== null && answers > answersWhenBack, "the room's answer after the reconnect");
  assert.equal(drained, 1, "once");
});

test("a webhook host can confirm an empty room again after hooks are added back", async (t) => {
  const relay = await startRelay(t);
  let ids = [HOOK_ID];
  let drained = 0;
  const mac = await hookMac(t, relay, hookSet(null, { ids: () => ids, drained: () => (drained += 1) }));
  await until(() => relay.hooks.directory.owner(HOOK_ID), "registered");
  ids = [];
  mac.host.syncHooks();
  await until(() => drained === 1, "first empty room confirmed");
  ids = [HOOK_ID];
  mac.host.syncHooks();
  await until(() => relay.hooks.directory.owner(HOOK_ID), "registered again");
  ids = [];
  mac.host.syncHooks();
  await until(() => drained === 2, "second empty room confirmed");
});

test("a draining host whose room holds nothing says drained at once", async (t) => {
  const relay = await startRelay(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-host-drain-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const identity = await readIdentity(dir);
  let drained = 0;
  const host = startRelayHost({ relayUrl: relay.url, identity, retired: true, hooks: hookSet([], { drained: () => (drained += 1) }) });
  t.after(() => host.close());
  await until(() => drained === 1, "drained");
});

// Transport diagnostics (relay-host.cjs createTransportDiagnostics): opt-in counters, no payloads.
test("transport diagnostics are off by default, and a host without them never reads the socket's buffer", async (t) => {
  if (process.env.MILAGRE_TRANSPORT_DIAGNOSTICS === "1") return t.skip("diagnostics turned on in this environment");
  assert.equal(transportDiagnostics, null);
  const reads = { count: 0 };
  class Counting extends require("ws").WebSocket {
    get bufferedAmount() {
      reads.count += 1;
      return super.bufferedAmount;
    }
  }
  const { connect } = await paired(t, { mac: { WebSocket: Counting } });
  const phone = await connect();
  phone.send({ t: "ping" });
  assert.deepEqual(await phone.next(), { t: "pong" });
  phone.request(1, { path: "/rpc", method: "POST", body: "{}" });
  assert.equal((await phone.response(1)).status, 200);
  assert.equal(reads.count, 0);
});

test("MILAGRE_TRANSPORT_DIAGNOSTICS=1 at start turns the process-wide diagnostics on; anything else leaves them off", () => {
  const { execFileSync } = require("node:child_process");
  const on = (value) =>
    execFileSync(process.execPath, ["-e", "process.stdout.write(String(require('./relay-host.cjs').transportDiagnostics !== null))"], {
      cwd: __dirname,
      env: { ...process.env, MILAGRE_TRANSPORT_DIAGNOSTICS: value },
    }).toString();
  assert.equal(on("1"), "true");
  assert.equal(on("0"), "false");
  assert.equal(on(""), "false");
});

test("transport diagnostics count frames, bytes and envelopes both ways, the most the socket held, and reconnects", async (t) => {
  const clock = { now: 5_000 };
  const diagnostics = createTransportDiagnostics({ now: () => clock.now });
  const tally = { inFrames: 0, inBytes: 0, outFrames: 0, outBytes: 0 };
  const busy = { amount: 0 };
  // Tallies the relay socket only: the bridge's live sockets share the class.
  class Tallied extends require("ws").WebSocket {
    constructor(url, ...rest) {
      super(url, ...rest);
      this.relay = String(url).includes("/v1/host");
      if (this.relay)
        this.on("message", (data) => {
          tally.inFrames += 1;
          tally.inBytes += data.length;
        });
    }
    send(data, ...rest) {
      if (this.relay) {
        tally.outFrames += 1;
        tally.outBytes += typeof data === "string" ? Buffer.byteLength(data) : data.length;
      }
      return super.send(data, ...rest);
    }
    get bufferedAmount() {
      return busy.amount || super.bufferedAmount;
    }
  }
  const relay = await startRelay(t);
  const { mac, connect } = await paired(t, { relay, mac: { WebSocket: Tallied, diagnostics, timing: { backoff: [20], jitter: false } } });
  const phone = await connect();
  phone.send({ t: "ping" });
  assert.deepEqual(await phone.next(), { t: "pong" });
  busy.amount = 12_345;
  phone.request(1, { path: "/rpc", method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: '{"secret":"s3cr3t"}' });
  assert.equal((await phone.response(1)).status, 200);
  busy.amount = 0;
  phone.close();
  await until(() => diagnostics.read().in.envelopes.CLOSE === 1, "the relay's CLOSE");
  const seen = diagnostics.read();
  assert.equal(seen.in.frames, tally.inFrames);
  assert.equal(seen.in.bytes, tally.inBytes);
  assert.equal(seen.out.frames, tally.outFrames);
  assert.equal(seen.out.bytes, tally.outBytes);
  assert.deepEqual(
    Object.entries(seen.in.envelopes).filter(([, n]) => n),
    [
      ["OPEN", 1],
      ["DATA", 3],
      ["CLOSE", 1],
      ["text", 2],
    ],
  );
  assert.deepEqual(
    Object.entries(seen.out.envelopes).filter(([, n]) => n),
    [
      ["DATA", 3],
      ["text", 1],
    ],
  );
  assert.deepEqual(
    Object.entries(seen.in.messages).filter(([, n]) => n),
    [
      ["hello", 1],
      ["req", 1],
      ["ping", 1],
    ],
  );
  assert.deepEqual(
    Object.entries(seen.out.messages).filter(([, n]) => n),
    [
      ["hello", 1],
      ["res", 1],
      ["pong", 1],
    ],
  );
  assert.equal(seen.maxBufferedAmount, 12_345);
  assert.deepEqual(seen.active, { phone: 1, retired: 0, hooks: 0 });
  // Nothing that names a device, the Mac, the bridge or a request is in what diagnostics hand out.
  const json = JSON.stringify(seen);
  for (const secret of [TOKEN, "s3cr3t", mac.identity.hostId, b64url(phone.key.publicKey), "/rpc", "127.0.0.1", "Bearer"])
    assert.ok(!json.includes(secret), secret);

  relay.hostSockets[0].terminate();
  await until(() => relay.hostSockets.length === 2 && mac.host.status() === "online", "the host back online");
  const after = diagnostics.read().sockets.phone;
  assert.equal(after.connects, 2);
  assert.equal(after.reconnects, 1);
  assert.equal(after.closes["1006"], 1);

  clock.now = 9_000;
  diagnostics.reset();
  const fresh = diagnostics.read();
  assert.equal(fresh.since, 9_000);
  assert.equal(fresh.uptimeMs, 0);
  assert.equal(fresh.in.frames + fresh.out.frames + fresh.sockets.phone.connects + fresh.maxBufferedAmount, 0);
  assert.deepEqual(fresh.active, { phone: 1, retired: 0, hooks: 0 }, "a reset keeps the hosts running now");
  clock.now = 9_250;
  assert.equal(diagnostics.read().uptimeMs, 250);

  await mac.host.close();
  const stopped = diagnostics.read();
  assert.deepEqual(stopped.active, { phone: 0, retired: 0, hooks: 0 });
  assert.equal(stopped.sockets.phone.stopped, 1);
  assert.equal(stopped.sockets.phone.closes["1000"], 1);
  // A stopped host counts nothing more.
  const before = JSON.stringify(diagnostics.read());
  mac.host.syncHooks();
  mac.host.drop("anything");
  assert.equal(JSON.stringify(diagnostics.read()), before);
});
