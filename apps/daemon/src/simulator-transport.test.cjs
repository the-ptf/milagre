const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { execFileSync } = require("node:child_process");
const { startMobileBridge } = require("./mobile-bridge.cjs");

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-simulator-rpc-"));
  const frames = [],
    opens = [],
    disconnected = [];
  const simulators = {
    async list() {
      return { devices: [{ id: "test-device", name: "Test iPhone", platform: "ios", version: "iOS 27" }], supported: true };
    },
    async open(request, owner) {
      opens.push({ request, owner });
      return { viewerId: "private-viewer" };
    },
    async frame(request, owner) {
      frames.push({ request, owner });
      return {
        sequence: 1,
        data: "cGl4ZWxz",
        mimeType: "image/jpeg",
        status: { width: 1, height: 1, generation: 1, ready: true, controlling: true, orientation: "portrait" },
      };
    },
    async closeViewer() {
      return null;
    },
    async disconnect(owner) {
      disconnected.push(owner);
    },
    async close() {},
  };
  const daemon = await startDaemon({ dataDir, version: "test", runtimeOptions: { environmentReady: Promise.resolve(), simulators } });
  const clients = [],
    bridges = [];
  t.after(async () => {
    for (const bridge of bridges) await bridge.close();
    for (const client of clients) client.close();
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const project = path.join(dataDir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-q", project]);
  const setup = await connect({ dataDir });
  clients.push(setup);
  const openedProject = await setup.call("project:open", [project]);
  const chatId = `${openedProject.path}#${Object.values(openedProject.state.sessions)[0].id}`;
  return {
    dataDir,
    opens,
    frames,
    disconnected,
    chatId,
    async client() {
      const client = await connect({ dataDir });
      clients.push(client);
      return client;
    },
    async bridge(confined = false) {
      const bridge = await startMobileBridge({ dataDir, port: 0, token: "a".repeat(64), ...(confined ? { allowedRoot: dataDir } : {}) });
      bridges.push(bridge);
      return (method, args = [], authorized = true) =>
        fetch(bridge.url + "/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer " + "a".repeat(64) } : {}) },
          body: JSON.stringify({ v: 1, method, args }),
        });
    },
  };
}

test("simulator commands receive distinct server identities and disconnect releases their viewers", async (t) => {
  const f = await fixture(t);
  const a = await f.client(),
    b = await f.client();
  assert.equal((await a.call("simulator:list", [{ chatId: f.chatId }])).devices.length, 0);
  await a.call("simulator:attach", [{ chatId: f.chatId, deviceId: "test-device" }]);
  await a.call("simulator:open", [{ chatId: f.chatId, deviceId: "test-device", owner: "forged" }]);
  await b.call("simulator:open", [{ chatId: f.chatId, deviceId: "test-device" }]);
  assert.equal(typeof f.opens[0].owner, "string");
  assert.ok(f.opens[0].owner.length >= 16);
  assert.notEqual(f.opens[0].owner, "forged");
  assert.notEqual(f.opens[0].owner, f.opens[1].owner);
  a.close();
  for (let i = 0; i < 100 && !f.disconnected.includes(f.opens[0].owner); i++) await delay(10);
  assert.ok(f.disconnected.includes(f.opens[0].owner));
});

test("paired mobile reaches the same simulator service; unauthenticated and confined clients are refused", async (t) => {
  const f = await fixture(t);
  const paired = await f.bridge();
  const listed = await paired("simulator:list", [{ chatId: f.chatId }]);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.available[0].name, "Test iPhone");
  assert.equal((await paired("simulator:attach", [{ chatId: f.chatId, deviceId: "test-device" }])).status, 200);
  assert.equal((await paired("simulator:open", [{ chatId: f.chatId, deviceId: "test-device" }])).status, 200);
  assert.equal(typeof f.opens[0].owner, "string");
  const frame = await paired("simulator:frame", [{ viewerId: "private-viewer", after: 0 }]);
  assert.equal(frame.status, 200);
  assert.equal((await frame.json()).result.data, "cGl4ZWxz");
  assert.equal(f.frames[0].owner, f.opens[0].owner);
  assert.equal((await paired("simulator:list", [], false)).status, 401);
  const confined = await f.bridge(true);
  for (const method of ["list", "attach", "detach", "open", "offer", "frame", "status", "control", "input", "repair", "close"]) {
    assert.equal((await confined(`simulator:${method}`, [{ viewerId: "private-viewer" }])).status, 403, method);
  }
});

test("simulator images cross the encrypted phone relay without a direct media connection", async (t) => {
  const { startTestMac, connectPhone } = require("./relay-test-kit.cjs");
  const bytes = Buffer.alloc(600000, 17).toString("base64");
  const owners = [];
  const mac = await startTestMac(t, {
    lan: false,
    runtime: {
      simulators: {
        list: async () => ({ devices: [{ id: "relay-device", name: "iPhone", platform: "ios", version: "27" }], supported: true }),
        open: async (_request, owner) => {
          owners.push(owner);
          return { viewerId: "relay-viewer", transport: "frames" };
        },
        frame: async (_request, owner) => {
          owners.push(owner);
          return { sequence: 1, data: bytes, mimeType: "image/jpeg" };
        },
        closeViewer: async () => null,
        disconnect: async () => {},
        close: async () => {},
      },
    },
  });
  const opened = await mac.client.call("project:open", [mac.project]);
  const chatId = `${opened.path}#${Object.values(opened.state.sessions)[0].id}`;
  await mac.client.call("simulator:attach", [{ chatId, deviceId: "relay-device" }]);
  const phone = mac.dial(connectPhone, { name: "Simulator relay test" });
  assert.ok((await phone.hello()).channel);
  const call = async (id, method, args) => {
    phone.request(id, { path: "/rpc", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, method, args }) });
    const response = await phone.response(id, 15000);
    assert.equal(response.status, 200);
    return JSON.parse(Buffer.from(response.body).toString());
  };
  assert.equal((await call(1, "simulator:open", [{ chatId, deviceId: "relay-device" }])).result.transport, "frames");
  assert.equal((await call(2, "simulator:frame", [{ viewerId: "relay-viewer", after: 0 }])).result.data, bytes);
  assert.equal(owners[0], owners[1]);
});
