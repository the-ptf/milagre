// Protocol conformance with real production Node clients and an explicitly synthetic Rust handler.
// This is not a live backend migration test and does not read or bind an installed Milagre profile.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const { socketPath } = require("../../../apps/daemon/src/paths.cjs");
const { wire } = require("../../../apps/daemon/src/protocol.cjs");
const { authenticationProof, readToken } = require("../../../apps/daemon/src/local-auth.cjs");

let stage = "startup";
const children = new Set();
const watchdog = setTimeout(() => {
  for (const child of children) child.kill("SIGKILL");
  console.error(`Isolated wire test exceeded its overall deadline at ${stage}`);
  process.exit(1);
}, 20000);
watchdog.unref();
const binary = process.argv[2];
assert.ok(binary, "Cargo supplies the fixture-server binary");
const timeout = (promise, label, ms = 5000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
async function start(auth = false) {
  const process = spawn(binary, auth ? ["--auth"] : [], { stdio: ["pipe", "pipe", "pipe"] });
  children.add(process);
  process.once("exit", () => children.delete(process));
  let stderr = "";
  process.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = once(process, "exit");
  const lines = readline.createInterface({ input: process.stdout });
  const [line] = await timeout(once(lines, "line"), "isolated fixture startup");
  const info = JSON.parse(line);
  assert.equal(info.fixture, true);
  assert.match(path.basename(info.profile), /^milagre-rust-wire-/);
  assert.equal(info.socket, socketPath(info.profile));
  assert.equal(fs.statSync(info.profile).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(info.socket)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(info.socket).mode & 0o777, 0o600);
  return {
    ...info,
    process,
    exit,
    async finish() {
      process.stdin.end();
      const [code] = await timeout(exit, "fixture shutdown");
      assert.equal(code, 0, stderr);
      lines.close();
      assert.equal(fs.existsSync(info.socket), false, "only this socket is removed");
      assert.equal(fs.existsSync(info.profile), false, "temporary profile is removed");
    },
  };
}
async function raw(profile) {
  const socket = net.createConnection(socketPath(profile));
  socket.on("error", () => {});
  await timeout(once(socket, "connect"), "raw connection");
  const received = [];
  let wake;
  const framed = wire(socket, {
    onMessage: (value) => {
      received.push(value);
      wake?.();
    },
    onInvalid: (error) => {
      throw error;
    },
  });
  async function next(predicate = () => true) {
    const read = async () => {
      while (true) {
        const index = received.findIndex(predicate);
        if (index !== -1) return received.splice(index, 1)[0];
        await new Promise((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    };
    return timeout(read(), "raw response");
  }
  return {
    socket,
    received,
    next,
    send: (value) => framed.send(value),
    async call(id, method, args = [], pages = false) {
      framed.send({ v: 1, id, method, args, pages });
      return next((message) => !message.event && message.id === id);
    },
  };
}
function nextEvent(client, channel) {
  return timeout(
    new Promise((resolve) => {
      const listen = (event) => {
        if (event.channel === channel) {
          client.off("event", listen);
          resolve(event);
        }
      };
      client.on("event", listen);
    }),
    channel,
  );
}

async function interoperability() {
  const host = await start();
  const clients = [];
  const sockets = [];
  let runtime;
  try {
    const client = await connect({ dataDir: host.profile, timeoutMs: 5000 });
    clients.push(client);
    const other = await connect({ dataDir: host.profile, timeoutMs: 5000 });
    clients.push(other);
    const status = await client.call("daemon:status");
    assert.equal((await client.call("fixture:unicode-output", [false])).text, "\ud83d", "inline domain result preserves a lone surrogate");
    assert.equal((await client.call("fixture:unicode-output", [true])).text, "\ud83d".repeat(1000), "paged domain result is not double escaped");
    const unicodeEvent = nextEvent(client, "fixture:unicode");
    await client.call("fixture:unicode-event");
    assert.equal((await unicodeEvent).payload.text, "\ud83d", "event payload uses domain serialization");
    assert.equal(status.protocolVersion, 1);
    assert.deepEqual(status.capabilities, ["snapshot-pages-v1", "result-pages-v1"]);
    assert.ok(!status.capabilities.includes("desktop-v1"), "fixture must not pass as a complete production owner");
    assert.equal(status.dataDir, host.profile);
    assert.deepEqual(await client.call("fixture:echo", [{ unicode: "Milagre 🦀", nested: [1, null, true] }]), {
      unicode: "Milagre 🦀",
      nested: [1, null, true],
    });
    await assert.rejects(client.call("fixture:failure"), { code: "FIXTURE_DENIED", message: "Deliberate fixture error" });
    await assert.rejects(client.call("fixture:large-error"), { code: "FRAME_TOO_LARGE" });
    await assert.rejects(client.call("missing:method"), { code: "COMMAND_FAILED" });
    stage = "queued requests";
    const values = await Promise.all(Array.from({ length: 70 }, (_, i) => client.call("fixture:echo", [i])));
    assert.deepEqual(
      values,
      Array.from({ length: 70 }, (_, i) => i),
      "Node queues beyond 32 pending requests",
    );
    stage = "out of order calls";
    const blocked = nextEvent(client, "fixture:blocked");
    let completed = false;
    const waiting = client.call("fixture:block", ["multiplex"]).then((value) => {
      completed = true;
      return value;
    });
    await blocked;
    assert.equal(await client.call("fixture:echo", [42]), 42, "second response may precede first");
    assert.equal(completed, false);
    await client.call("fixture:release", ["multiplex"]);
    assert.deepEqual(await waiting, { released: "multiplex" });

    stage = "large result";
    const large = await client.call("fixture:large", [4000]);
    assert.equal(large.text, '🦀"\\\n'.repeat(4000), "production Node client reassembles Unicode/escape-heavy pages");
    stage = "raw pages";
    const low = await raw(host.profile);
    sockets.push(low.socket);
    const lowOther = await raw(host.profile);
    sockets.push(lowOther.socket);
    const manifest = await low.call("large", "fixture:large", [4000], true);
    assert.equal(typeof manifest.pages.pageId, "number");
    assert.ok(manifest.pages.pageCount > 1);
    assert.equal((await lowOther.call(1, "daemon:result-page", [manifest.pages.pageId, 0])).error.code, "COMMAND_FAILED", "captures belong to one connection");
    assert.equal((await low.call(2, "daemon:result-page", [manifest.pages.pageId, 1])).error.code, "COMMAND_FAILED", "pages must be sequential");
    const chunks = [];
    for (let i = 0; i < manifest.pages.pageCount; i++) chunks.push((await low.call(100 + i, "daemon:result-page", [manifest.pages.pageId, i])).result);
    assert.deepEqual(JSON.parse(chunks.join("")), large);
    assert.equal((await low.call(3, "daemon:result-page", [manifest.pages.pageId, 0])).error.code, "COMMAND_FAILED", "last page releases capture");
    assert.equal((await low.call(4, "fixture:large", [4000])).error.code, "FRAME_TOO_LARGE", "unpaged clients get a clear bound error");
    assert.equal((await low.call("reusable", "fixture:echo", [1])).result, 1);
    assert.equal((await low.call("reusable", "fixture:echo", [2])).result, 2, "an acknowledged ID can be reused");
    const error = await low.call(5, "fixture:failure");
    assert.deepEqual(error.error.details, { fixture: true });
    low.send({ v: 2, id: "version", method: "fixture:echo", args: [] });
    assert.equal((await low.next((value) => value.id === "version")).error.code, "VERSION_MISMATCH");
    low.socket.write('{"v":1.0,"id":"decimal-version","method":"fixture:echo","args":[12]}\n');
    assert.equal((await low.next((value) => value.id === "decimal-version")).result, 12);
    low.send({ v: 1, id: false, method: "fixture:echo", args: [] });
    assert.equal((await low.next((value) => value.id === null)).error.code, "INVALID_REQUEST");

    stage = "event and snapshot";
    const event = nextEvent(client, "fixture:incremented");
    const increment = await other.call("fixture:increment");
    assert.equal((await event).seq, increment.seq);
    assert.equal((await client.call("daemon:snapshot")).unicode, "\ud83d", "inline snapshot preserves domain UTF-16");
    const snapshot = await client.call("daemon:snapshot", [{ paged: true }]);
    assert.equal(typeof snapshot.snapshotId, "number");
    const snapshotChunks = [];
    for (let i = 0; i < snapshot.pageCount; i++) snapshotChunks.push(await client.call("daemon:snapshot-page", [snapshot.snapshotId, i]));
    const restored = JSON.parse(snapshotChunks.join(""));
    assert.equal(restored.fixtureCount, 1);
    assert.equal(restored.unicode, "\ud83d", "snapshot pages preserve domain UTF-16");
    assert.equal(restored.eventSeq, increment.seq);
    const omitted = nextEvent(client, "project:state");
    await other.call("fixture:oversized-state");
    const oversized = await omitted;
    assert.equal(oversized.payload.stateTooLarge, true);
    assert.equal("state" in oversized.payload, false);
    assert.ok(oversized.seq > increment.seq);

    stage = "view scope";
    await client.call("project:open", ["/fixture-one"]);
    await other.call("project:open", ["/fixture-two"]);
    await client.call("chat:set-open", ["/fixture-one#3"]);
    await client.call("daemon:focus", [{ focused: true }]);
    assert.equal((await client.call("project:current")).path, "/fixture-one");
    assert.equal((await other.call("project:current")).path, "/fixture-two");
    assert.deepEqual((await client.call("fixture:view")).view, { focused: true, projectPath: "/fixture-one", linkId: null, chatId: "/fixture-one#3" });
    assert.equal((await other.call("fixture:view")).view.focused, false);
    await client.call("link:open", ["fixture-link"]);
    assert.equal((await client.call("fixture:view")).view.projectPath, null);
    assert.equal((await client.call("fixture:view")).view.linkId, "fixture-link");
    await assert.rejects(client.call("fixture:accepted-without-ack", ["once"]));
    assert.equal(await other.call("fixture:receipt", ["once"]), 1, "lost acknowledgement is never automatically resent");

    stage = "runtime reconnect";
    let connected;
    const reconnected = new Promise((resolve) => {
      connected = resolve;
    });
    let snapshotSeen = false;
    let hydrated;
    const hydration = new Promise((resolve) => {
      hydrated = resolve;
    });
    runtime = await connectDesktopRuntime({
      connect: () => connect({ dataDir: host.profile, timeoutMs: 5000 }),
      reconnectMs: 10,
      emit(channel, payload) {
        if (channel === "runtime:snapshot") snapshotSeen = true;
        if (channel === "runtime:connection" && payload.connected && snapshotSeen) connected();
        if (channel === "project:state" && payload.path === "/fixture") hydrated(payload);
      },
    });
    await runtime.openProject("/runtime-project");
    await runtime.invoke("link:open", ["11111111-2222-3333-4444-555555555555"]);
    await runtime.invoke("chat:set-open", ["milagre-link:11111111-2222-3333-4444-555555555555#8"]);
    await runtime.setFocused(true);
    await runtime.invoke("fixture:oversized-state");
    const hydratedState = await timeout(hydration, "production runtime omitted-state hydration");
    assert.equal(hydratedState.state.text, "x".repeat(3000));
    assert.equal("stateTooLarge" in hydratedState, false);
    await assert.rejects(runtime.invoke("fixture:disconnect"));
    await timeout(reconnected, "production runtime reconnection");
    assert.deepEqual((await runtime.invoke("fixture:view")).view, {
      focused: true,
      projectPath: null,
      linkId: "11111111-2222-3333-4444-555555555555",
      chatId: "milagre-link:11111111-2222-3333-4444-555555555555#8",
    });
    await runtime.close();
    runtime = null;

    stage = "invalid frames";
    const duplicate = await raw(host.profile);
    sockets.push(duplicate.socket);
    duplicate.send({ v: 1, id: 1, method: "fixture:block", args: ["duplicate"] });
    await duplicate.next((value) => value.event?.channel === "fixture:blocked");
    duplicate.socket.write('{"v":1,"id":1.0,"method":"fixture:echo","args":[]}\n');
    assert.equal((await duplicate.next((value) => value.error)).error.code, "TOO_MANY_REQUESTS", "1 and 1.0 are the same JS request ID");
    const excess = await raw(host.profile);
    sockets.push(excess.socket);
    for (let id = 1; id <= 33; id++) excess.send({ v: 1, id, method: "fixture:block", args: ["pending-budget"] });
    assert.equal((await excess.next((value) => value.id === 33)).error.code, "TOO_MANY_REQUESTS", "33 concurrent calls exceed the per-client bound");
    const overflow = await raw(host.profile);
    sockets.push(overflow.socket);
    const closing = once(overflow.socket, "close");
    overflow.socket.write("x".repeat(4097));
    assert.equal((await overflow.next((value) => value.error)).error.code, "FRAME_TOO_LARGE");
    await closing;
    const malformed = await raw(host.profile);
    sockets.push(malformed.socket);
    malformed.socket.write("not json\n");
    assert.equal((await malformed.next((value) => value.error)).error.code, "INVALID_REQUEST");

    stage = "shutdown drain";
    const slowStop = nextEvent(other, "fixture:blocked");
    const accepted = other.call("fixture:block", ["drain"]);
    await slowStop;
    // The release is already accepted when stop starts; shutdown must drain both before acknowledging.
    const release = other.call("fixture:release", ["drain"]);
    const stop = other.call("daemon:stop");
    await release;
    assert.deepEqual(await accepted, { released: "drain" });
    assert.deepEqual(await stop, { stopping: true });
  } finally {
    await runtime?.close();
    for (const client of clients) client.close();
    for (const socket of sockets) socket.destroy();
    await host.finish();
  }
}

async function authentication() {
  stage = "authentication";
  const host = await start(true);
  const clients = [];
  const sockets = [];
  try {
    assert.equal(fs.statSync(path.join(host.profile, "daemon-private", "token")).mode & 0o777, 0o600);
    const client = await connect({ dataDir: host.profile, timeoutMs: 5000, requireAuthentication: true });
    clients.push(client);
    assert.equal(await client.call("fixture:echo", [7]), 7, "production mutual-HMAC client authenticates");
    const unauthenticated = await raw(host.profile);
    sockets.push(unauthenticated.socket);
    await unauthenticated.call("challenge", "daemon:authenticate", [{ clientNonce: "b".repeat(64) }]);
    await client.call("fixture:increment");
    unauthenticated.send({ v: 1, id: 1, method: "daemon:status", args: [] });
    assert.equal((await unauthenticated.next((value) => value.id === 1)).error.code, "UNAUTHORIZED");
    assert.equal(
      unauthenticated.received.some((value) => value.event),
      false,
      "no events before authentication",
    );
    const old = await raw(host.profile);
    sockets.push(old.socket);
    const clientNonce = "a".repeat(64);
    const challenge = (await old.call(1, "daemon:authenticate", [{ clientNonce }])).result;
    const token = readToken(host.profile);
    assert.equal(challenge.proof, authenticationProof(token, "server", clientNonce, challenge.serverNonce));
    const oldProof = authenticationProof(token, "client", clientNonce, challenge.serverNonce);
    assert.equal((await old.call(2, "daemon:authenticate", [{ proof: oldProof }])).result.authenticated, true);
    const fresh = await raw(host.profile);
    sockets.push(fresh.socket);
    const newChallenge = (await fresh.call(1, "daemon:authenticate", [{ clientNonce }])).result;
    assert.notEqual(newChallenge.serverNonce, challenge.serverNonce);
    assert.equal(
      (await fresh.call(2, "daemon:authenticate", [{ proof: oldProof }])).error.code,
      "UNAUTHORIZED",
      "proof cannot be replayed on another connection",
    );
    const idle = await raw(host.profile);
    sockets.push(idle.socket);
    await timeout(once(idle.socket, "close"), "unauthenticated connection deadline", 2000);
    await client.call("daemon:stop");
  } finally {
    for (const client of clients) client.close();
    for (const socket of sockets) socket.destroy();
    await host.finish();
  }
}

void (async () => {
  await interoperability();
  await authentication();
  console.log("Node client + runtime-client conformance passed against isolated Rust fixture sockets; no production owner was used.");
})().catch((error) => {
  for (const child of children) child.stdin.end();
  console.error(`Stage: ${stage}`, error);
  process.exitCode = 1;
});
