const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { startTestMac, until } = require("./relay-test-kit.cjs");

test("the daemon owns computer management with no desktop and persists headless key configuration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-headless-computers-"));
  const dataDir = path.join(root, "profile");
  await fs.mkdir(dataDir, { mode: 0o700 });
  let daemon;
  const open = async () =>
    startDaemon({
      dataDir,
      version: "test",
      runtimeOptions: { cwd: dataDir, environmentReady: Promise.resolve(), titleModels: {}, agentCli: async () => ({ command: null }) },
    });
  t.after(async () => {
    await daemon?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  daemon = await open();
  const client = await connect({ dataDir });
  try {
    assert.ok(
      !(await client.call("daemon:status")).methods.includes("computers:list"),
      "older desktops must not register proxies over their native computer handlers",
    );
    assert.ok((await client.call("daemon:status", [{ computerManagement: true }])).methods.includes("computers:list"));
    assert.deepEqual((await client.call("computers:list")).computers, []);
    await client.call("computers:setup-key", [{ file: path.join(root, "private-key") }]);
    assert.equal((await client.call("computers:vault-status")).configuredFile, true);
    const snapshots = [];
    client.on("event", ({ channel, payload }) => {
      if (channel === "computers:changed") snapshots.push(payload);
    });
    await client.call("computers:set-enabled", [true]);
    await until(() => snapshots.some((snapshot) => snapshot.enabled === true), "enabled snapshot reaches open windows");
    await client.call("computers:set-enabled", [false]);
    await until(() => snapshots.some((snapshot) => snapshot.enabled === false), "disabled snapshot reaches open windows");
    await Promise.all([client.call("computers:set-enabled", [false]), client.call("computers:set-enabled", [true])]);
  } finally {
    client.close();
  }
  await daemon.close();
  daemon = await open();
  const after = await connect({ dataDir });
  try {
    assert.equal((await after.call("computers:vault-status")).configuredFile, true);
    assert.deepEqual((await after.call("computers:list")).computers, []);
    assert.equal((await after.call("computers:list")).enabled, true, "the final accepted enablement survives restart");
  } finally {
    after.close();
  }
});

test("a headless daemon pairs over the relay, drives a remote computer and reconnects after restart", { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-headless-pair-"));
  const dataDir = path.join(root, "profile");
  await fs.mkdir(dataDir, { mode: 0o700 });
  let daemon;
  const open = () =>
    startDaemon({
      dataDir,
      version: "headless",
      computerOptions: { allowLocalRelay: true, reconnectMs: 50, checkEveryMs: 60000, networkMs: 60000 },
      runtimeOptions: { cwd: dataDir, environmentReady: Promise.resolve(), titleModels: {}, agentCli: async () => ({ command: null }) },
    });
  t.after(async () => {
    await daemon?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const remote = await startTestMac(t, { autoAllow: false });
  daemon = await open();
  let owner = await connect({ dataDir });
  try {
    await owner.call("computers:setup-key", [{ file: path.join(root, "private-key") }]);
    await owner.call("computers:set-enabled", [true]);
    const link = (await remote.client.call("phone:status")).pairingLink;
    const adding = owner.call("computers:add", [link, { name: "Studio" }]);
    void adding.catch(() => {});
    const request = await until(async () => (await remote.client.call("devices:pending"))[0], "headless computer waiting for approval");
    await remote.client.call("devices:allow", [request.key]);
    const result = await adding;
    assert.equal(result.ok, true, result.message);
    const id = result.computer.id;
    await until(async () => (await owner.call("computers:list")).computers[0]?.state === "online", "headless connection online");
    const status = await owner.call("computers:invoke", [id, "daemon:status", []]);
    assert.equal(status.version, "9.8.7");
    await until(async () => (await owner.call("computers:list")).computers[0]?.route === "lan", "headless client moves from relay to LAN");
    await assert.rejects(owner.call("computers:invoke", [id, "computers:unlock", [{ key: "untrusted" }]]), /Not available on a remote computer/);
    const identity = JSON.parse(await fs.readFile(path.join(dataDir, "computer-vault.json"), "utf8"));
    assert.ok(!JSON.stringify(identity).includes(remote.token));
    owner.close();
    await daemon.close();
    daemon = await open();
    owner = await connect({ dataDir });
    await until(async () => (await owner.call("computers:list")).computers[0]?.state === "online", "unattended reconnect");
    assert.equal((await owner.call("computers:invoke", [id, "daemon:status", []])).version, "9.8.7");
    await remote.client.call("devices:remove", [request.key]);
    await until(async () => (await owner.call("computers:list")).computers[0]?.state === "refused", "revocation stops reconnecting");
  } finally {
    owner.close();
  }
});
