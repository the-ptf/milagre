const test = require("node:test");
const assert = require("node:assert/strict");
const { deadlineFor } = require("./client.cjs");

test("slow mutations get the time core allows them, others keep the default", () => {
  assert.equal(deadlineFor("artifact:share-page", 30000), 420000);
  assert.equal(deadlineFor("artifact:revoke-page-share", 30000), 120000);
  assert.equal(deadlineFor("artifact:revoke-saved-page-share", 30000), 120000);
  assert.equal(deadlineFor("git:push", 30000), 330000);
  assert.equal(deadlineFor("git:commit", 30000), 330000);
  assert.equal(deadlineFor("agent:update-cli", 30000), 1200000);
  assert.equal(deadlineFor("linear:connect", 30000), 330000, "a sign-in waits five minutes for the browser");
  assert.equal(deadlineFor("daemon:status", 30000), 30000);
  assert.equal(deadlineFor("git:push", 600000), 600000, "a longer caller deadline is kept");
});

test("calls past MAX_PENDING wait for a free slot instead of failing", async (t) => {
  const fs = require("node:fs");
  const net = require("node:net");
  const os = require("node:os");
  const path = require("node:path");
  const { connect } = require("./client.cjs");
  const { socketPath, prepareSocketDirectory } = require("./paths.cjs");
  const { VERSION, MAX_PENDING, wire } = require("./protocol.cjs");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-client-"));
  const socket = socketPath(dataDir);
  prepareSocketDirectory(socket);
  fs.rmSync(socket, { force: true });
  // Holds every request, like a busy daemon, and records the most it ever had in flight.
  const held = [];
  let most = 0;
  const server = net.createServer((peer) => {
    const connection = wire(peer, {
      onInvalid: () => peer.destroy(),
      onMessage(message) {
        held.push({ connection, id: message.id, method: message.method });
        most = Math.max(most, held.length);
      },
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const client = await connect({ dataDir, requireAuthentication: false });
  t.after(() => client.close());
  const calls = Array.from({ length: MAX_PENDING + 8 }, (_, index) => client.call(`test:${index}`));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(held.length, MAX_PENDING, "the daemon never sees more than MAX_PENDING at once");
  while (held.length > 0) {
    const request = held.shift();
    request.connection.send({ v: VERSION, id: request.id, result: request.method });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(
    await Promise.all(calls),
    calls.map((_, index) => `test:${index}`),
  );
  assert.equal(most, MAX_PENDING);
});

test("a connection that takes no events drops them unread and still gets its answers", async (t) => {
  const fs = require("node:fs");
  const net = require("node:net");
  const os = require("node:os");
  const path = require("node:path");
  const { connect } = require("./client.cjs");
  const { socketPath, prepareSocketDirectory } = require("./paths.cjs");
  const { VERSION, wire, isEventFrame } = require("./protocol.cjs");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-client-"));
  const socket = socketPath(dataDir);
  prepareSocketDirectory(socket);
  fs.rmSync(socket, { force: true });
  // Every answer follows two events, as on a busy daemon: one written as server.cjs eventFrame does, one as a notice to
  // a single connection is (connection.send).
  const server = net.createServer((peer) => {
    const connection = wire(peer, {
      onInvalid: () => peer.destroy(),
      onMessage(message) {
        peer.write(`{"v":${VERSION},"event":{"channel":"agent:event","payload":{"chatId":"/p#1"},"seq":7}}\n`);
        connection.send({ v: VERSION, event: { channel: "computers:pending" } });
        connection.send({ v: VERSION, id: message.id, result: message.method });
      },
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const quiet = await connect({ dataDir, requireAuthentication: false, events: false });
  const listening = await connect({ dataDir, requireAuthentication: false });
  t.after(() => {
    quiet.close();
    listening.close();
  });
  const heard = { quiet: [], listening: [] };
  quiet.on("event", (event) => heard.quiet.push(event.channel));
  listening.on("event", (event) => heard.listening.push(event.channel));
  assert.equal(await quiet.call("test:one"), "test:one");
  assert.equal(await listening.call("test:two"), "test:two");
  assert.deepEqual(heard.quiet, []);
  assert.deepEqual(heard.listening, ["agent:event", "computers:pending"]);
  assert.equal(isEventFrame(Buffer.from(`{"v":${VERSION},"id":3,"result":{"event":1}}`)), false, "an answer is never taken for an event");
});
