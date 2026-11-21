const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter, once } = require("node:events");
const { WebSocketServer } = require("ws");
const { createBaguette, withBaguette, cabledPhones } = require("./baguette.cjs");
const { createEnvelopeReader } = require("./simlock-channel.cjs");

const UDID = "00008150-00050D003C20401C";
const LIST = [
  `{"udid":"1ED8C612-8403-432D-AB18-B4C6FA76F15D","name":"iPhone 17","state":"Booted","runtime":"iOS 27.2"}`,
  `{"udid":"${UDID}","name":"Ana's iPhone","state":"ready","runtime":"","reality":"physical","model":"iPhone 17 Pro Max"}`,
  `{"udid":"00008160-000A11112222333C","name":"Old iPhone","state":"unavailable","runtime":"","reality":"physical","model":"iPhone 15"}`,
  `{"udid":"R5CT1234567","name":"Pixel","state":"ready","runtime":"","reality":"physical","model":"Pixel 9"}`,
  `{"udid":"Milagre_Pixel9","name":"Milagre_Pixel9","state":"off","runtime":"","reality":"emulated","model":"Milagre_Pixel9"}`,
  "not json",
].join("\n");

const until = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** A stand-in for `baguette serve`: its device list, a phone's definition and its stream socket. */
async function fakeServe() {
  const received = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url === "/devices.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ devices: [{ id: UDID, name: "Ana's iPhone", kind: { reality: "physical", os: "iOS 27.3", platform: "iOS" } }] }));
    } else if (request.url === `/devices/${UDID}/definition.json`) {
      response.end(JSON.stringify({ screen: { rect: { width: 438, height: 954, x: 18, y: 18 } } }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  const wss = new WebSocketServer({ server, path: `/devices/${UDID}/stream` });
  wss.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.requestPath = request.url;
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    received,
    sockets,
    send: (tag, bytes = []) => {
      for (const socket of sockets) socket.send(Buffer.from([tag, ...bytes]));
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function fakeHost(port, overrides = {}) {
  const spawned = [];
  const host = createBaguette({
    env: { PATH: "/usr/bin:/fake/bin" },
    executable: async (file) => file === "/fake/bin/baguette",
    execFile: async (_file, args) => ({ stdout: args[0] === "--version" ? "0.3.0\n" : LIST }),
    freePort: async () => port,
    spawn: (binary, args) => {
      const child = new EventEmitter();
      child.kill = () => setImmediate(() => child.emit("exit", 0));
      spawned.push({ binary, args, child });
      return child;
    },
    idleMs: 20,
    pollMs: 5,
    ...overrides,
  });
  return { host, spawned };
}

test("only ready iPhones and iPads on a cable are listed, never simulators, emulators or Android phones", () => {
  assert.deepEqual(cabledPhones(LIST), [{ udid: UDID, name: "Ana's iPhone", model: "iPhone 17 Pro Max" }]);
});

test("Baguette is found on PATH or Homebrew, and too old a version lists nothing", async () => {
  const missing = createBaguette({ env: { PATH: "/usr/bin" }, executable: async () => false });
  assert.deepEqual(await missing.detect(), { found: false, supported: false, minVersion: "0.3.0", serving: false });
  assert.deepEqual(await missing.list(), []);

  const brew = createBaguette({
    env: { PATH: "/usr/bin" },
    executable: async (file) => file === "/opt/homebrew/bin/baguette",
    execFile: async (_file, args) => ({ stdout: args[0] === "--version" ? "0.2.15\n" : LIST }),
  });
  const old = await brew.detect();
  assert.equal(old.path, "/opt/homebrew/bin/baguette");
  assert.equal(old.version, "0.2.15");
  assert.equal(old.supported, false);
  assert.deepEqual(await brew.list(), []);
  await assert.rejects(brew.connect(`baguette:${UDID}`), /Update Baguette to 0\.3\.0/);
});

test("a cabled iPhone lists under its own id, and its OS once serve has reported it", async () => {
  const serve = await fakeServe();
  const { host } = fakeHost(serve.port);
  try {
    assert.deepEqual(await host.list(), [
      { id: `baguette:${UDID}`, name: "Ana's iPhone", platform: "ios", version: "", deviceType: "iPhone 17 Pro Max", capabilities: ["touch", "home"] },
    ]);
    assert.equal(host.isDevice(`baguette:${UDID}`), true);
    assert.equal(host.isDevice(UDID), false);
    await assert.rejects(host.connect("baguette:../../simulators"), /Invalid iPhone id/);
  } finally {
    await host.stop();
    await serve.close();
  }
});

test("one loopback serve runs while phones are viewed and stops after the last viewer closes", async () => {
  const serve = await fakeServe();
  const { host, spawned } = fakeHost(serve.port);
  try {
    const first = await host.connect(`baguette:${UDID}`);
    const second = await host.connect(`baguette:${UDID}`);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].binary, "/fake/bin/baguette");
    assert.deepEqual(spawned[0].args, ["serve", "--host", "127.0.0.1", "--port", String(serve.port), "--no-plugins"]);
    assert.equal((await host.detect()).serving, true);
    await first.close();
    assert.equal((await host.detect()).serving, true);
    await second.close();
    await until(() => spawned[0].child.listenerCount("exit") === 0);
    assert.equal((await host.detect()).serving, false);
    assert.equal((await host.list())[0].version, "27.3");
  } finally {
    await host.stop();
    await serve.close();
  }
});

test("the phone's AVCC stream relays as frames, and touches go up in device points", async () => {
  const serve = await fakeServe();
  const { host } = fakeHost(serve.port);
  try {
    const channel = await host.connect(`baguette:${UDID}`);
    await until(() => serve.sockets.size === 1 && serve.received.length === 3);
    assert.match([...serve.sockets][0].requestPath, /\?format=avcc$/);
    assert.deepEqual(
      serve.received.map((message) => message.type),
      ["set_scale", "set_fps", "set_bitrate"],
    );
    assert.equal(channel.status().ready, false);
    serve.send(4, [0xff, 0xd8]);
    serve.send(1, [1, 0x64, 0, 0x1f]);
    serve.send(2, [0, 0, 0, 1, 0x65]);
    serve.send(3, [0, 0, 0, 1, 0x41]);
    await until(() => channel.status().ready && channel.status().width === 438);
    assert.deepEqual(channel.status(), { width: 438, height: 954, orientation: "portrait", ready: true, capabilities: ["touch", "home"] });
    const frame = await channel.frame(0, AbortSignal.timeout(2000));
    assert.equal(frame.mimeType, "video/avcc");
    assert.equal(frame.reset, true);
    const envelopes = createEnvelopeReader()(Buffer.from(frame.data, "base64"));
    assert.deepEqual(
      envelopes.map((e) => e.tag),
      [1, 2, 3],
    );
    assert.deepEqual([...envelopes[0].payload], [1, 0x64, 0, 0x1f]);

    serve.received.length = 0;
    await channel.send({ kind: "touch", phase: "begin", points: [{ x: 0.5, y: 0.5 }] });
    await channel.send({ kind: "touch", phase: "end", points: [{ x: 0.5, y: 0.5 }] });
    await channel.send({
      kind: "touch",
      phase: "begin",
      points: [
        { x: 0.25, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ],
    });
    await channel.send({
      kind: "touch",
      phase: "end",
      points: [
        { x: 0.25, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ],
    });
    await until(() => serve.received.length === 4);
    assert.deepEqual(serve.received, [
      { type: "touch1-down", x: 219, y: 477, width: 438, height: 954 },
      { type: "touch1-up", x: 219, y: 477, width: 438, height: 954 },
      { type: "touch2-down", x1: 109.5, y1: 477, x2: 328.5, y2: 477, width: 438, height: 954 },
      { type: "touch2-up", x1: 109.5, y1: 477, x2: 328.5, y2: 477, width: 438, height: 954 },
    ]);
    await channel.close();
  } finally {
    await host.stop();
    await serve.close();
  }
});

test("a drag in from the bottom edge goes Home, a tap there stays a tap, and Home swipes up", async () => {
  const serve = await fakeServe();
  const { host } = fakeHost(serve.port);
  try {
    const channel = await host.connect(`baguette:${UDID}`);
    await until(() => serve.received.length === 3);
    serve.send(1, [1, 0x64, 0, 0x1f]);
    await until(() => channel.status().width === 438 && channel.status().ready);
    const sent = () => serve.received.slice(3).map(({ type, edge }) => (edge ? `${type}:${edge}` : type));

    await channel.send({ kind: "touch", phase: "begin", points: [{ x: 0.5, y: 0.97 }] });
    await channel.send({ kind: "touch", phase: "end", points: [{ x: 0.5, y: 0.97 }] });
    await until(() => sent().length === 2);
    assert.deepEqual(sent(), ["touch1-down", "touch1-up"]);

    await channel.send({ kind: "touch", phase: "begin", points: [{ x: 0.5, y: 0.97 }] });
    await channel.send({ kind: "touch", phase: "move", points: [{ x: 0.5, y: 0.965 }] });
    await channel.send({ kind: "touch", phase: "move", points: [{ x: 0.5, y: 0.6 }] });
    await channel.send({ kind: "touch", phase: "end", points: [{ x: 0.5, y: 0.5 }] });
    await until(() => sent().length === 5);
    assert.deepEqual(sent().slice(2), ["touch1-down:bottom", "touch1-move:bottom", "touch1-up:bottom"]);

    await channel.send({ kind: "button", button: "home" });
    await until(() => sent().length === 11);
    assert.deepEqual(sent().slice(5), [
      "touch1-down:bottom",
      "touch1-move:bottom",
      "touch1-move:bottom",
      "touch1-move:bottom",
      "touch1-move:bottom",
      "touch1-up:bottom",
    ]);
    await assert.rejects(channel.send({ kind: "rotate", orientation: "landscape-left" }), /takes touches only/);
    await assert.rejects(channel.send({ kind: "key", phase: "down", usage: 4 }), /takes touches only/);
    await channel.close();
  } finally {
    await host.stop();
    await serve.close();
  }
});

test("a phone Baguette can't stream says why, and a closed socket ends the stream", async () => {
  const serve = await fakeServe();
  const { host } = fakeHost(serve.port);
  try {
    const channel = await host.connect(`baguette:${UDID}`);
    await until(() => serve.sockets.size === 1);
    for (const socket of serve.sockets)
      socket.send(
        JSON.stringify({
          ok: false,
          error:
            'CoreDeviceError(errorCode: 4000, errorUserInfo: ["NSLocalizedDescription": "A connection to a remote process could not be established.", "NSUnderlyingError": x])',
        }),
      );
    await until(() => !!channel.status().error);
    assert.equal(
      channel.status().error,
      "Baguette could not stream this iPhone: A connection to a remote process could not be established. Unlock it, keep it on its cable, and retry.",
    );
    await assert.rejects(channel.frame(0, AbortSignal.timeout(500)), /remote process/);
    await assert.rejects(channel.send({ kind: "touch", phase: "begin", points: [{ x: 0.5, y: 0.5 }] }), /remote process/);
    await channel.close();

    const next = await host.connect(`baguette:${UDID}`);
    await until(() => serve.sockets.size === 2);
    for (const socket of serve.sockets) socket.terminate();
    await until(() => !!next.status().error);
    assert.match(next.status().error, /stream stopped/);
    await next.close();
  } finally {
    await host.stop();
    await serve.close();
  }
});

test("phones join the simulator list without breaking it, and stream through Milagre only", async () => {
  const phone = { id: `baguette:${UDID}`, name: "Ana's iPhone", platform: "ios", version: "27.3" };
  const sim = { id: "1ED8C612-8403-432D-AB18-B4C6FA76F15D", name: "iPhone 17", platform: "ios", version: "27.2" };
  const calls = [];
  const local = {
    list: async () => [sim],
    connect: async (id) => (calls.push(["local", id]), {}),
    offer: async () => ({ type: "answer", sdp: "v=0" }),
    closeViewer: async () => calls.push(["close"]),
    repairInput: async () => calls.push(["repair"]),
    stop: async () => calls.push(["stop-local"]),
  };
  const host = {
    list: async () => [phone],
    isDevice: (id) => id.startsWith("baguette:"),
    connect: async (id) => (calls.push(["phone", id]), {}),
    stop: async () => calls.push(["stop-phone"]),
  };
  const adapter = withBaguette(local, host);
  assert.deepEqual(await adapter.list(), [sim, phone]);
  assert.deepEqual(await withBaguette({ ...local, list: async () => Promise.reject(new Error("xcrun")) }, host).list(), [phone]);
  await assert.rejects(withBaguette({ ...local, list: async () => Promise.reject(new Error("xcrun")) }, { ...host, list: async () => [] }).list(), /xcrun/);
  assert.deepEqual(await withBaguette(local, { ...host, list: async () => Promise.reject(new Error("baguette")) }).list(), [sim]);
  await adapter.connect(phone.id);
  await adapter.connect(sim.id);
  await assert.rejects(adapter.offer(phone.id, "s", "v=0"), /through Milagre only/);
  await assert.rejects(adapter.repairInput(phone.id), /not available/);
  await adapter.closeViewer(phone.id, "s");
  await adapter.stop();
  assert.deepEqual(calls, [["phone", phone.id], ["local", sim.id], ["stop-local"], ["stop-phone"]]);
});
