const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { startMobileBridge } = require("./mobile-bridge.cjs");

const TARGET = "0b5c2e5e-1111-4222-8333-944444444444:" + "A".repeat(32);

async function fixture(t, source = "agent") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-browser-rpc-"));
  const calls = [],
    disconnected = [];
  const browsers = {
    async list(request) {
      calls.push(["list", request]);
      return { supported: true, targets: [{ id: TARGET, title: "Login", url: "https://example.com/", browser: "Chrome 141", source }], others: [] };
    },
    async attach(request) {
      calls.push(["attach", request]);
      return { supported: true, targets: [], others: [] };
    },
    async open(request, owner) {
      calls.push(["open", request, owner]);
      return { viewerId: "private-viewer", target: {} };
    },
    async frame(request, owner) {
      calls.push(["frame", request, owner]);
      return { sequence: 1, data: "jpeg", viewport: { width: 800, height: 600 }, generation: 1 };
    },
    async closeViewer() {
      return null;
    },
    async disconnect(owner) {
      disconnected.push(owner);
    },
    async close() {},
  };
  const daemon = await startDaemon({ dataDir, version: "test", runtimeOptions: { environmentReady: Promise.resolve(), browsers } });
  const clients = [],
    bridges = [];
  t.after(async () => {
    for (const bridge of bridges) await bridge.close();
    for (const client of clients) client.close();
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return {
    calls,
    disconnected,
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

test("browser viewers belong to the server-assigned connection, never a caller-supplied owner", async (t) => {
  const f = await fixture(t);
  const a = await f.client(),
    b = await f.client();
  assert.equal((await a.call("browser:list", [{ chatId: "chat" }])).targets[0].id, TARGET);
  await a.call("browser:open", [{ chatId: "chat", targetId: TARGET, owner: "forged" }]);
  await b.call("browser:open", [{ chatId: "chat", targetId: TARGET }]);
  const [first, second] = f.calls.filter(([method]) => method === "open").map(([, , owner]) => owner);
  assert.ok(first.length >= 16);
  assert.notEqual(first, "forged");
  assert.notEqual(first, second);
  a.close();
  for (let i = 0; i < 100 && !f.disconnected.includes(first); i++) await delay(10);
  assert.ok(f.disconnected.includes(first));
});

test("a paired phone reaches browser commands; unauthenticated and confined clients are refused", async (t) => {
  const f = await fixture(t);
  const paired = await f.bridge();
  assert.equal((await (await paired("browser:list", [{ chatId: "chat" }])).json()).result.targets.length, 1);
  assert.equal((await paired("browser:open", [{ chatId: "chat", targetId: TARGET }])).status, 200);
  assert.equal((await (await paired("browser:frame", [{ viewerId: "private-viewer", after: 0 }])).json()).result.data, "jpeg");
  assert.equal((await paired("browser:list", [{ chatId: "chat" }], false)).status, 401);
  const confined = await f.bridge(true);
  for (const method of ["list", "attach", "open", "open-page", "frame", "status", "control", "input", "close"]) {
    assert.equal((await confined(`browser:${method}`, [{ chatId: "chat", viewerId: "private-viewer" }])).status, 403, method);
  }
});

test("a paired phone opens a web link in its Chat's desktop panel", async (t) => {
  const f = await fixture(t, "panel");
  const paired = await f.bridge();
  const response = await paired("browser:open-page", [{ chatId: "chat", url: "https://example.com" }]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.id, TARGET);
  assert.equal((await paired("browser:open-page", [{ chatId: "chat", url: "https://example.com" }], false)).status, 401);
  const invalid = await paired("browser:open-page", [{ chatId: "chat", url: "file:///tmp/private" }]);
  assert.notEqual(invalid.status, 200);
});
