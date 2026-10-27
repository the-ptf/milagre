const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("@milagre/daemon/client");
const { socketPath, prepareSocketDirectory } = require("@milagre/daemon/paths");
const { VERSION, MAX_PENDING, wire } = require("@milagre/daemon/protocol");
const { createComputersLane } = require("./computers-lane.cjs");

const CAPABILITIES = ["computer-management-v1", "chat-pages-v1", "subagent-tails-v1", "archived-subagent-summaries-v1"];

/**
 * A daemon that answers at once, except computers:invoke, which it holds like a computer over the relay until
 * `release()`. Like the real one it refuses a connection that sends more than MAX_PENDING, and it sends every
 * connection an event with each answer.
 */
async function fakeDaemon(t, { capabilities = CAPABILITIES } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-lane-"));
  const socket = socketPath(dataDir);
  prepareSocketDirectory(socket);
  fs.rmSync(socket, { force: true });
  const daemon = { connections: [], held: [], forms: [], most: 0, refused: 0 };
  daemon.release = () => {
    for (const { connection, peer, id, args } of daemon.held.splice(0)) {
      peer.inflight--;
      connection.send({ v: VERSION, id, result: args });
    }
  };
  const server = net.createServer((socket) => {
    const peer = { socket, inflight: 0, methods: [] };
    daemon.connections.push(peer);
    const connection = wire(socket, {
      onInvalid: () => socket.destroy(),
      onMessage(message) {
        peer.methods.push(message.method);
        if (peer.inflight >= MAX_PENDING) {
          daemon.refused++;
          socket.destroy();
          return;
        }
        if (message.method === "computers:invoke") {
          peer.inflight++;
          daemon.most = Math.max(daemon.most, peer.inflight);
          daemon.held.push({ connection, peer, id: message.id, args: message.args });
          return;
        }
        if (message.method === "daemon:state-patches") daemon.forms.push(message.args);
        const result = message.method === "daemon:status" ? { methods: [], capabilities } : message.method;
        for (const other of daemon.connections)
          if (!other.socket.destroyed) other.socket.write(`{"v":${VERSION},"event":{"channel":"agent:event","payload":{},"seq":1}}\n`);
        connection.send({ v: VERSION, id: message.id, result });
      },
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => {
    for (const { socket } of daemon.connections) socket.destroy();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, daemon };
}

async function until(check, label) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("on one connection, calls past MAX_PENDING wait behind remote calls: a local read waits for a computer", async (t) => {
  const { dataDir, daemon } = await fakeDaemon(t);
  const window = await connect({ dataDir, requireAuthentication: false });
  t.after(() => window.close());
  const remote = Array.from({ length: MAX_PENDING }, (_, index) => window.call("computers:invoke", ["c1", "media:read", [{ index }]]));
  await until(() => daemon.held.length === MAX_PENDING, "the remote calls to fill the slots");
  let answered = false;
  const local = window.call("chat:messages", ["/p", 1]).then(() => (answered = true));
  await delay(50);
  assert.equal(answered, false, "the local read waits for a slot");
  daemon.release();
  await Promise.all([local, ...remote]);
});

test("remote calls take a connection of their own, so this Mac's calls never wait behind them", async (t) => {
  const { dataDir, daemon } = await fakeDaemon(t);
  const window = await connect({ dataDir, requireAuthentication: false });
  t.after(() => window.close());
  const fallbacks = [];
  const lane = createComputersLane({
    dataDir,
    available: () => true,
    fallback: (method, args) => {
      fallbacks.push(method);
      return window.call(method, args);
    },
  });
  t.after(() => lane.close());
  assert.equal(lane.handles("computers:invoke"), true);
  assert.equal(lane.handles("chat:messages"), false);
  const remote = Array.from({ length: MAX_PENDING + 8 }, (_, index) => lane.invoke("computers:invoke", ["c1", "media:read", [{ index }]]));
  await until(() => daemon.held.length === MAX_PENDING, "the lane to fill its slots");
  const started = performance.now();
  assert.equal(await window.call("chat:messages", ["/p", 1]), "chat:messages");
  assert.ok(performance.now() - started < 200, "the local read is answered while every remote call still waits");
  assert.equal(daemon.most, MAX_PENDING, "the lane, like any connection, never has more than MAX_PENDING at the daemon");
  while (daemon.held.length) {
    daemon.release();
    await delay(5);
  }
  assert.deepEqual(
    (await Promise.all(remote)).map((args) => args[2][0].index),
    remote.map((_, index) => index),
  );
  assert.equal(daemon.refused, 0);
  assert.deepEqual(fallbacks, []);
  // The lane asked for the window's lean form of events, so the daemon encodes none of its own for it.
  assert.deepEqual(daemon.forms, [[{ messages: false, transcripts: false, archivedSubagents: false }]]);
  assert.equal(daemon.connections.length, 2, "one lane, opened once");
});

test("while the window's runtime is away, or the host can't take a lane, calls go over the window's connection", async (t) => {
  const { dataDir, daemon } = await fakeDaemon(t, { capabilities: ["chat-pages-v1"] });
  let available = false;
  let clock = 0;
  const fallbacks = [];
  const lane = createComputersLane({
    dataDir,
    available: () => available,
    now: () => clock,
    fallback: async (method, args) => {
      fallbacks.push([method, args]);
      return "fallback";
    },
  });
  t.after(() => lane.close());
  assert.equal(await lane.invoke("computers:invoke", ["c1", "chat:inbox", []]), "fallback");
  assert.equal(daemon.connections.length, 0, "no lane while the runtime is disconnected");
  available = true;
  assert.equal(await lane.invoke("computers:invoke", ["c1", "chat:inbox", []]), "fallback");
  assert.equal(daemon.connections.length, 1, "a host without computer commands takes no lane");
  await until(() => daemon.connections[0].socket.destroyed, "the refused lane to close");
  assert.equal(await lane.invoke("computers:invoke", ["c1", "chat:inbox", []]), "fallback");
  assert.equal(daemon.connections.length, 1, "it isn't tried again at once");
  clock += 10_000;
  await lane.invoke("computers:invoke", ["c1", "chat:inbox", []]);
  assert.equal(daemon.connections.length, 2, "it is tried again later");
  lane.reset();
  await lane.invoke("computers:invoke", ["c1", "chat:inbox", []]);
  assert.equal(daemon.connections.length, 3, "and when the host was started again");
  assert.equal(fallbacks.length, 5);
});

test("a lane whose host went away is opened again, and none is opened once closed", async (t) => {
  const { dataDir, daemon } = await fakeDaemon(t);
  const lane = createComputersLane({ dataDir, available: () => true, fallback: async () => "fallback" });
  const first = lane.invoke("computers:invoke", ["c1", "project:recent", []]);
  await until(() => daemon.held.length === 1, "the call to reach the daemon");
  daemon.connections[0].socket.destroy();
  await assert.rejects(first, /closed/);
  const second = lane.invoke("computers:invoke", ["c1", "project:recent", []]);
  await until(() => daemon.held.length === 2, "the call to reach the daemon again");
  assert.equal(daemon.connections.length, 2);
  daemon.release();
  assert.deepEqual(await second, ["c1", "project:recent", []]);
  lane.close();
  assert.equal(await lane.invoke("computers:invoke", ["c1", "project:recent", []]), "fallback");
  assert.equal(daemon.connections.length, 2);
});
