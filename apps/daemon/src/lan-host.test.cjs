const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { b64url, boxKeyPair } = require("@milagre/shared/relay-crypto");
const { readIdentity } = require("./relay-identity.cjs");
const { createDevices } = require("./devices.cjs");
const { startLanHost } = require("./lan-host.cjs");
const { random, startFakeBridge, connectPhone, connectDesktop, fakePeerDaemon, until } = require("./relay-test-kit.cjs");

/** What devices.json holds now, or "" before it exists. */
const onDisk = (dir) => fs.readFile(path.join(dir, "devices.json"), "utf8").catch(() => "");

async function lanMac(t, { knownPhone = true, knownKind = "phone", ...hostOptions } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lan-host-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const identity = await readIdentity(dir);
  const phones = createDevices(dir);
  await phones.load();
  const key = boxKeyPair(random);
  if (knownPhone) await phones.add(b64url(key.publicKey), { kind: knownKind });
  const bridge = await startFakeBridge(t);
  const host = await startLanHost({ port: 0, hostname: "127.0.0.1", identity, phones, token: "a".repeat(64), bridgeUrl: bridge.url, ...hostOptions });
  t.after(() => host.close());
  return { identity, key, bridge, host, phones, dir, url: `ws://127.0.0.1:${host.port}` };
}

test("/v1/hello names this Mac and nothing else", async (t) => {
  const { identity, host } = await lanMac(t);
  const response = await fetch(`http://127.0.0.1:${host.port}/v1/hello`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { v: 1, hostId: identity.hostId });
  assert.equal((await fetch(`http://127.0.0.1:${host.port}/rpc`)).status, 404);
});

test("a new phone can pair directly during the owner's pairing window", async (t) => {
  const { identity, key, phones, url } = await lanMac(t, { knownPhone: false, canPair: () => true });
  const phone = connectPhone({ relayUrl: url, identity, key });
  t.after(() => phone.ws.close());
  assert.ok((await phone.hello()).channel);
  assert.equal(phones.isKnown(b64url(key.publicKey)), true);
  phone.request(1, { path: "/rpc" });
  assert.equal((await phone.response(1)).status, 200);
});

test("a known phone calls /rpc over the LAN socket", async (t) => {
  const { identity, key, bridge, url } = await lanMac(t);
  const phone = connectPhone({ relayUrl: url, identity, key });
  t.after(() => phone.close());
  const result = await phone.hello();
  assert.ok(result.channel, JSON.stringify(result));
  phone.request(1, { method: "POST", path: "/rpc", headers: { "content-type": "application/json" }, body: '{"v":1,"method":"daemon:status","args":[]}' });
  const response = await phone.response(1);
  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(response.body), '{"v":1,"result":"pong"}');
  assert.equal(bridge.seen.requests.at(-1).authorization, `Bearer ${"a".repeat(64)}`);
});

test("an unknown phone is refused: the LAN never opens pairing", async (t) => {
  const { identity, url } = await lanMac(t, { knownPhone: false });
  const phone = connectPhone({ relayUrl: url, identity });
  t.after(() => phone.close());
  assert.deepEqual((await phone.hello()).error, { t: "error", code: "unknown-phone" });
});

test("a phone pinning another Mac's key cannot finish the hello", async (t) => {
  const { identity, key, url } = await lanMac(t);
  const other = { ...identity, box: boxKeyPair(random) };
  const phone = connectPhone({ relayUrl: url, identity: other, key });
  t.after(() => phone.close());
  // The hello is sealed to a key this Mac does not hold: it can't open it and refuses.
  assert.deepEqual((await phone.hello()).error, { t: "error", code: "bad-hello" });
});

test("a wrong host id gets no socket", async (t) => {
  const { url } = await lanMac(t);
  const { WebSocket } = require("ws");
  const ws = new WebSocket(`${url}/v1/phone?id=${"A".repeat(22)}`);
  const outcome = await new Promise((resolve) => {
    ws.on("open", () => resolve("open"));
    ws.on("error", () => resolve("refused"));
  });
  assert.equal(outcome, "refused");
});

test("closing the host closes its phones", async (t) => {
  const { identity, key, host, url } = await lanMac(t);
  const phone = connectPhone({ relayUrl: url, identity, key });
  assert.ok((await phone.hello()).channel);
  await host.close();
  await until(async () => (await Promise.race([phone.closed, new Promise((r) => setTimeout(() => r(null), 50))])) !== null, "phone closed");
});

/** Writes raw bytes to the listener and waits for it to answer or hang up. */
function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk;
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve(answer));
    setTimeout(() => socket.destroy(), 1000).unref();
  });
}

const helloStatus = async (port) => (await fetch(`http://127.0.0.1:${port}/v1/hello`)).status;

test("a request line that is not a URL gets a 404 and cannot crash the daemon", async (t) => {
  const { host } = await lanMac(t);
  assert.match(await rawRequest(host.port, "GET http://[ HTTP/1.1\r\nHost: lan\r\n\r\n"), /^HTTP\/1\.1 404/);
  assert.equal(await helloStatus(host.port), 200);
});

test("an upgrade whose request line is not a URL is refused and cannot crash the daemon", async (t) => {
  const { host } = await lanMac(t);
  const upgrade =
    "GET http://[ HTTP/1.1\r\nHost: lan\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
  assert.match(await rawRequest(host.port, upgrade), /^HTTP\/1\.1 404/);
  assert.equal(await helloStatus(host.port), 200);
});

test("a phone socket that stops answering pings is terminated; one that answers stays", async (t) => {
  const { identity, url } = await lanMac(t, { pingMs: 50 });
  const { WebSocket } = require("ws");
  const silent = new WebSocket(`${url}/v1/phone?id=${identity.hostId}`, { autoPong: false });
  const live = new WebSocket(`${url}/v1/phone?id=${identity.hostId}`);
  t.after(() => {
    silent.terminate();
    live.terminate();
  });
  const silentClosed = new Promise((resolve) => silent.on("close", () => resolve(true)));
  let liveClosed = false;
  live.on("close", () => (liveClosed = true));
  assert.equal(await Promise.race([silentClosed, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]), true);
  assert.equal(liveClosed, false);
});

test("a fifth socket from one address is refused while four are open", async (t) => {
  const { identity, url } = await lanMac(t);
  const { WebSocket } = require("ws");
  const open = [];
  t.after(() => open.forEach((ws) => ws.terminate()));
  const dial = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${url}/v1/phone?id=${identity.hostId}`);
      ws.on("open", () => {
        open.push(ws);
        resolve("open");
      });
      ws.on("error", () => resolve("refused"));
    });
  for (let index = 0; index < 4; index++) assert.equal(await dial(), "open");
  assert.equal(await dial(), "refused");
  // Closing one makes room again.
  open.pop().close();
  await until(async () => (await dial()) === "open", "a free slot after a close");
});

test("closing the host with a request in flight resolves and leaves nothing running", async (t) => {
  const { identity, key, bridge, host, url } = await lanMac(t);
  const phone = connectPhone({ relayUrl: url, identity, key });
  t.after(() => phone.close());
  assert.ok((await phone.hello()).channel);
  phone.request(1, { path: "/slow" });
  await until(() => bridge.waiting() === 1, "a request in flight");
  await host.close();
  bridge.release();
});

test("a port that is taken rejects without leaving a liveness timer behind", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lan-host-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const identity = await readIdentity(dir);
  const phones = createDevices(dir);
  await phones.load();
  const taken = net.createServer();
  await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => taken.close(resolve)));
  const created = [];
  const cleared = [];
  const { setInterval: realSet, clearInterval: realClear } = globalThis;
  globalThis.setInterval = (...args) => {
    const timer = realSet(...args);
    created.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    cleared.push(timer);
    realClear(timer);
  };
  try {
    await assert.rejects(
      startLanHost({ port: taken.address().port, hostname: "127.0.0.1", identity, phones, token: "a".repeat(64), bridgeUrl: "http://127.0.0.1:1" }),
      { code: "EADDRINUSE" },
    );
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  assert.deepEqual(
    created.filter((timer) => !cleared.includes(timer)),
    [],
  );
});

/** Resolves once the server ends a raw socket, or false after `ms`. */
function endsWithin(socket, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("a TCP socket that sends nothing is destroyed after the idle timeout", async (t) => {
  const { host } = await lanMac(t, { idleMs: 100 });
  const socket = net.connect(host.port, "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  assert.equal(await endsWithin(socket, 3000), true);
  assert.equal(await helloStatus(host.port), 200);
});

test("the idle timeout does not touch a phone socket, which the liveness ping watches instead", async (t) => {
  const { identity, key, url } = await lanMac(t, { idleMs: 100 });
  const phone = connectPhone({ relayUrl: url, identity, key });
  t.after(() => phone.close());
  assert.ok((await phone.hello()).channel);
  await new Promise((resolve) => setTimeout(resolve, 400));
  phone.request(1, { method: "POST", path: "/rpc", headers: { "content-type": "application/json" }, body: '{"v":1,"method":"daemon:status","args":[]}' });
  assert.equal((await phone.response(1)).status, 200);
});

test("a first message over 4 KiB closes the socket", async (t) => {
  const { identity, url } = await lanMac(t);
  const { WebSocket } = require("ws");
  const ws = new WebSocket(`${url}/v1/phone?id=${identity.hostId}`);
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const closed = new Promise((resolve) => ws.on("close", () => resolve(true)));
  let answers = 0;
  ws.on("message", () => answers++);
  ws.send(Buffer.alloc(4 * 1024 + 1, 1));
  assert.equal(await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]), true);
  assert.equal(answers, 0, "an oversize hello is dropped before it is even parsed, with no refusal to read");
});

test("a phone that finished its hello may send messages over 4 KiB", async (t) => {
  const { identity, key, bridge, url } = await lanMac(t);
  const phone = connectPhone({ relayUrl: url, identity, key });
  t.after(() => phone.close());
  assert.ok((await phone.hello()).channel);
  phone.request(1, { method: "POST", path: "/attachments", headers: { "content-type": "application/json" }, body: "x".repeat(100_000) });
  const response = await phone.response(1);
  assert.equal(response.status, 200);
  assert.equal(bridge.seen.uploads.at(-1).body.length, 100_000);
});

test("no more than 64 sockets are held at once", async (t) => {
  const { host } = await lanMac(t);
  const held = [];
  t.after(() => held.forEach((socket) => socket.destroy()));
  for (let index = 0; index < 64; index++) {
    const socket = net.connect(host.port, "127.0.0.1");
    socket.on("error", () => {});
    held.push(socket);
    await new Promise((resolve) => socket.once("connect", resolve));
  }
  const extra = net.connect(host.port, "127.0.0.1");
  extra.on("error", () => {});
  t.after(() => extra.destroy());
  assert.equal(await endsWithin(extra, 3000), true);
});

test("a known phone on the LAN shows as connected, is seen with its name, and drop closes it", async (t) => {
  const { identity, key, host, phones, dir, url } = await lanMac(t);
  const id = b64url(key.publicKey);
  const phone = connectPhone({ relayUrl: url, identity, key, name: "Victor's iPhone" });
  t.after(() => phone.close());
  assert.ok((await phone.hello()).channel);
  assert.deepEqual(host.connectedKeys(), [id]);
  await until(() => phones.list()[0].name === "Victor's iPhone", "the name from the hello");
  // The hello does not wait for the write, so wait for the file before the test's cleanup removes the directory.
  await until(async () => (await onDisk(dir)).includes("Victor's iPhone"), "the name written to devices.json");
  host.drop(id);
  await phone.closed;
  await until(() => host.connectedKeys().length === 0, "dropped");
});

test("a known computer speaks rpc over the LAN, in parts past 768 KiB, and closing the host closes its daemon connection", async (t) => {
  const daemon = fakePeerDaemon();
  const { identity, key, host, url } = await lanMac(t, { knownKind: "computer", openPeer: daemon.openPeer });
  const desktop = connectDesktop({ relayUrl: url, identity, key });
  t.after(() => desktop.close());
  assert.ok((await desktop.hello()).channel);
  assert.deepEqual(host.connectedKeys(), [b64url(key.publicKey)]);
  const big = "ação🙂".repeat(150_000);
  assert.deepEqual((await desktop.call("echo", [big])).result, { echo: [big] });
  await host.close();
  await desktop.closed;
  assert.equal(daemon.connections[0].closed, true);
});

test("an unknown desktop is refused on the LAN, which never pairs", async (t) => {
  const daemon = fakePeerDaemon();
  const { identity, url } = await lanMac(t, { knownPhone: false, openPeer: daemon.openPeer });
  const desktop = connectDesktop({ relayUrl: url, identity });
  t.after(() => desktop.close());
  assert.deepEqual((await desktop.hello()).error, { t: "error", code: "unknown-phone" });
  assert.equal(daemon.connections.length, 0);
});
