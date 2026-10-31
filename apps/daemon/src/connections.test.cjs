const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startDaemon } = require("./server.cjs");
const { peerPolicy } = require("./peer-policy.cjs");

async function waitFor(read) {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out");
}

async function daemonFixture(t, options = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-connections-")));
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    ...options,
    // No test may dial the real relay or bind the LAN port.
    phoneOptions: { localPort: 0, lanPort: null, startRelay: () => ({ close: async () => {}, status: () => "online" }) },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  t.after(async () => {
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return daemon;
}

/** A daemon client with no socket: every frame the daemon sends lands in `frames`, even after close. */
function virtualClient(daemon, options = {}) {
  const frames = [];
  const waiters = new Map();
  let ended = false;
  let nextId = 0;
  const connection = daemon.acceptConnection({
    send(message, json) {
      const frame = JSON.parse(json ?? JSON.stringify(message));
      frames.push(frame);
      if (frame.id != null) waiters.get(frame.id)?.(frame);
      return true;
    },
    end: () => {
      ended = true;
    },
    destroy: () => {
      ended = true;
    },
    isClosed: () => ended,
    ...options,
  });
  return {
    frames,
    events: () => frames.filter((frame) => frame.event).map((frame) => frame.event),
    call(method, args = []) {
      const id = ++nextId;
      const reply = new Promise((resolve) => waiters.set(id, resolve));
      connection.receive({ v: 1, id, method, args });
      return reply;
    },
    receive: (request) => connection.receive(request),
    close: () => connection.close(),
  };
}

test("the paired-desktop policy denies pairing, device management, push, stopping the daemon and signing in to Linear on this Mac, and nothing else", () => {
  for (const method of [
    "phone:status",
    "phone:reset",
    "phone:open-pairing",
    "devices:list",
    "devices:remove",
    "devices:pending",
    "devices:allow",
    "devices:deny",
    "devices:take-notices",
    "devices:confirm-notices",
    "devices:acknowledge",
    "push:register",
    "push:focus",
    "daemon:stop",
    "linear:connect",
    "linear:disconnect",
  ])
    assert.equal(peerPolicy.denies(method), true, method);
  for (const method of [
    "daemon:status",
    "daemon:snapshot",
    "daemon:state-patches",
    "state:read",
    "project:open",
    "project:recent",
    "git:push",
    "chat:set-open",
    "linear:status",
  ])
    assert.equal(peerPolicy.denies(method), false, method);
});

test("a virtual connection without a policy runs any method and gets events until it closes", async (t) => {
  const daemon = await daemonFixture(t);
  const client = virtualClient(daemon);
  const status = (await client.call("daemon:status")).result;
  assert.ok(status.methods.includes("phone:set-enabled"));
  assert.equal((await client.call("phone:set-enabled", [true])).result.state, "starting");
  await waitFor(() => client.events().some((event) => event.channel === "phone:status" && event.payload.state === "on"));
  client.close();
  const before = client.frames.length;
  const other = virtualClient(daemon);
  await other.call("phone:set-enabled", [false]);
  await waitFor(() => other.events().some((event) => event.channel === "phone:status" && event.payload.state === "off"));
  assert.equal(client.frames.length, before, "a closed connection gets nothing more");
});

test("a policy refuses what it denies before it runs, and daemon:status leaves those methods out", async (t) => {
  const daemon = await daemonFixture(t);
  const peer = virtualClient(daemon, { policy: peerPolicy });
  for (const [method, args] of [
    ["phone:set-enabled", [true]],
    ["phone:reset", []],
    ["push:register", [{}]],
    ["daemon:stop", []],
  ]) {
    const reply = await peer.call(method, args);
    assert.deepEqual(reply.error, { code: "NOT_AVAILABLE_REMOTELY", message: "Not available on a remote computer" }, method);
  }
  const peerStatus = (await peer.call("daemon:status")).result;
  const methods = peerStatus.methods;
  assert.equal(peerStatus.capabilities.includes("mobile-push-v1"), false, "push is denied, so its capability is not advertised");
  assert.ok(peerStatus.capabilities.includes("desktop-v1"), "the rest stay");
  assert.equal(
    methods.some((method) => peerPolicy.denies(method)),
    false,
  );
  assert.ok(methods.includes("project:recent"));
  const local = virtualClient(daemon);
  assert.equal((await local.call("phone:status")).result.state, "off", "the denied phone:set-enabled never ran");
  const localStatus = (await local.call("daemon:status")).result;
  assert.ok(localStatus.methods.includes("phone:set-enabled"), "the socket's own view is unchanged");
  assert.ok(localStatus.capabilities.includes("mobile-push-v1"), "and so are its capabilities");
});

test("a request that arrives after close is dropped, and the connection is not registered again", async (t) => {
  const daemon = await daemonFixture(t);
  const client = virtualClient(daemon);
  await client.call("daemon:status");
  client.close();
  const before = client.frames.length;
  client.receive({ v: 1, id: 99, method: "daemon:state-patches", args: [{ messages: true }] });
  client.receive({ v: 1, id: 100, method: "daemon:status", args: [] });
  await delay(50);
  const other = virtualClient(daemon);
  await other.call("phone:set-enabled", [true]);
  await waitFor(() => other.events().some((event) => event.channel === "phone:status" && event.payload.state === "on"));
  await other.call("phone:set-enabled", [false]);
  await waitFor(() => other.events().some((event) => event.channel === "phone:status" && event.payload.state === "off"));
  assert.equal(client.frames.length, before, "no reply, and no later broadcast reaches it");
});

test("a connection that must authenticate needs a daemon with an authentication token", async (t) => {
  const daemon = await daemonFixture(t, { requireAuthentication: false });
  const carrier = { send: () => true, end() {}, destroy() {}, isClosed: () => false };
  assert.throws(() => daemon.acceptConnection({ ...carrier, requireAuthentication: true }), /authentication token/);
});

test("a paired desktop hears no phone:* event, which carries the pairing link and its token, and still hears the rest", async (t) => {
  const daemon = await daemonFixture(t);
  const peer = virtualClient(daemon, { policy: peerPolicy });
  const local = virtualClient(daemon);
  await local.call("phone:set-enabled", [true]);
  await waitFor(() => local.events().some((event) => event.channel === "phone:status" && event.payload.state === "on"));
  await daemon.close();
  assert.ok(
    peer.events().some((event) => event.channel === "daemon:stopping"),
    "other events still reach it",
  );
  assert.deepEqual(
    peer.events().filter((event) => event.channel.startsWith("phone:")),
    [],
  );
});

test("daemon:status advertises desktop-peer-v1 and peer:routes, which a paired desktop may call", async (t) => {
  const daemon = await daemonFixture(t);
  const status = (await virtualClient(daemon, { policy: peerPolicy }).call("daemon:status")).result;
  assert.ok(status.capabilities.includes("desktop-peer-v1"));
  assert.ok(status.methods.includes("peer:routes"));
  assert.equal(peerPolicy.denies("peer:routes"), false);
  const reply = await virtualClient(daemon, { policy: peerPolicy }).call("peer:routes");
  assert.deepEqual(reply.error, { code: "COMMAND_FAILED", message: "Phone access is starting. Try again." }, "phone access is off here");
});

test("a paired desktop may list folders in the daemon's home folder, and only there", async (t) => {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-home-")));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(homeDir, "Code"));
  const daemon = await daemonFixture(t, { homeDir });
  const desktop = virtualClient(daemon, { policy: peerPolicy });
  const status = (await desktop.call("daemon:status")).result;
  assert.ok(status.capabilities.includes("remote-files-v1"));
  assert.ok(status.methods.includes("fs:list-dirs"));
  const listing = (await desktop.call("fs:list-dirs", [{}])).result;
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ["Code"],
  );
  assert.deepEqual((await desktop.call("fs:list-dirs", [{ path: "/etc" }])).error, {
    code: "OUTSIDE_HOME",
    message: "Only folders in the home folder can be listed.",
  });
});

test("a paired desktop may call media:read, which refuses a file outside the scope's roots", async (t) => {
  const daemon = await daemonFixture(t);
  const desktop = virtualClient(daemon, { policy: peerPolicy });
  assert.ok((await desktop.call("daemon:status")).result.methods.includes("media:read"));
  const reply = await desktop.call("media:read", [{ scope: "/nowhere", path: "/etc/hosts.png" }]);
  assert.equal(reply.error?.code, "NOT_SERVED");
});

test("a paired desktop reads, checks and installs this Mac's desktop app update, never the desktop commands behind it", async (t) => {
  const daemon = await daemonFixture(t);
  const peer = virtualClient(daemon, { policy: peerPolicy });
  const status = (await peer.call("daemon:status")).result;
  for (const method of ["app-update:state", "app-update:check", "app-update:install"]) {
    assert.ok(status.methods.includes(method), method);
    assert.equal(peerPolicy.denies(method), false, method);
  }
  assert.equal((await peer.call("app-update:state")).result, null, "no desktop app is open on this Mac yet");
  // This Mac's window registers its updater (main.cjs, through desktop-commands.cjs) and answers each request.
  let state = { status: "downloaded", version: "0.233.0", progress: 100 };
  const asked = [];
  const answers = {
    "update:state": () => state,
    "update:check": () => state,
    "update:install": () => {
      state = { ...state, status: "installing" };
      return null;
    },
    "app:version": () => "0.232.0",
    "editor:list": () => [],
  };
  const window = virtualClient(daemon, {
    send(message, json) {
      const frame = JSON.parse(json ?? JSON.stringify(message));
      if (frame.event?.channel === "desktop:request") {
        const { id, method } = frame.event.payload;
        asked.push(method);
        window.receive({ v: 1, id: `answer-${id}`, method: "desktop:respond", args: [{ id, result: answers[method]() }] });
      }
      return true;
    },
  });
  window.receive({ v: 1, id: "register", method: "desktop:register", args: [{ methods: Object.keys(answers) }] });
  assert.deepEqual(await waitFor(async () => (await peer.call("app-update:state")).result), {
    status: "downloaded",
    version: "0.233.0",
    progress: 100,
    current: "0.232.0",
  });
  assert.equal((await peer.call("app-update:install")).result.status, "installing");
  assert.ok(asked.includes("update:install"));
  assert.equal(asked.includes("editor:list"), false);
  assert.equal((await peer.call("desktop:invoke", [{ method: "editor:list", args: [] }])).error.code, "NOT_AVAILABLE_REMOTELY");
});
