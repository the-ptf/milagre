const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { b64url, boxKeyPair, fromB64url } = require("@milagre/shared/relay-crypto");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { connectPhone, random, until } = require("./relay-test-kit.cjs");

// Nothing may dial relay.milagre.cloud.
const startRelay = () => ({ status: () => "online", close: async () => {} });

// A throwaway daemon: its own data dir and ports picked by the OS (port 0). Never Victor's data dir or 8797/8798.
test("a phone learns the LAN route over the bridge, then calls the daemon over the LAN socket", async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lan-e2e-")));
  const dataDir = path.join(directory, "profile");
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  let daemon;
  let client;
  const phones = [];
  // One hook, registered before anything can fail, in this order: hooks run in the order they were added, and the
  // folder must outlive the daemon.
  t.after(async () => {
    for (const phone of phones) phone.close();
    client?.close();
    try {
      await daemon?.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  daemon = await startDaemon({
    dataDir,
    homeDir: dataDir,
    version: "9.8.7",
    runtimeOptions: { cwd: project, environmentReady: Promise.resolve(), titleModels: {} },
    phoneOptions: { localPort: 0, lanPort: 0, lanHostname: "127.0.0.1", addresses: () => ["127.0.0.1"], startRelay },
  });
  client = await connect({ dataDir });

  await client.call("phone:set-enabled", [true]);
  // Turning it on returns while the bridge and the LAN listener are still starting.
  const status = await until(async () => {
    const current = await client.call("phone:status");
    return current.state === "on" && current;
  }, "phone access to be on");
  const token = JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).token;

  const key = boxKeyPair(random);
  const routes = await fetch(`${status.localUrl}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ v: 1, method: "phone:routes", args: [{ phoneKey: b64url(key.publicKey) }] }),
    signal: AbortSignal.timeout(5000),
  }).then((response) => response.json());
  assert.equal(routes.error, undefined, `phone:routes failed: ${JSON.stringify(routes)}`);
  assert.equal(routes.result.lan.length, 1);
  assert.match(routes.result.lan[0], /^ws:\/\/127\.0\.0\.1:\d+$/);

  const identity = { hostId: routes.result.hostId, box: { publicKey: fromB64url(routes.result.key) } };
  const phone = connectPhone({ relayUrl: routes.result.lan[0], identity, key, token });
  phones.push(phone);
  assert.ok((await phone.hello()).channel);
  phone.request(1, { method: "POST", path: "/rpc", headers: { "content-type": "application/json" }, body: '{"v":1,"method":"daemon:status","args":[]}' });
  const response = await phone.response(1);
  assert.equal(response.status, 200);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  assert.equal(body.v, 1);
  assert.equal(body.result.version, "9.8.7");
});
