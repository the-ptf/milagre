const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { socketPath, prepareSocketDirectory } = require("./paths.cjs");
const { ensureDaemon } = require("./bootstrap.cjs");

async function stopClients(clients) {
  for (const client of clients) {
    try {
      // The stop reply precedes the phone/push shutdown. The socket closes after those final profile writes finish.
      await Promise.all([client.call("daemon:stop"), once(client, "close", { signal: AbortSignal.timeout(5000) })]);
    } catch {}
    client.close();
  }
}

test("two detached starts attach to one daemon and reconnect preserves its PID", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-bootstrap-")));
  const clients = [];
  t.after(async () => {
    await stopClients(clients);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const options = { dataDir, version: "9.8.7", cwd: dataDir };
  clients.push(...(await Promise.all([ensureDaemon(options), ensureDaemon(options)])));
  const [a, b] = await Promise.all(clients.map((client) => client.call("daemon:status")));
  assert.equal(a.pid, b.pid);
  assert.notEqual(a.pid, process.pid);
  assert.equal(a.version, "9.8.7");
  clients[0].close();
  const again = await ensureDaemon(options);
  clients.push(again);
  assert.equal((await again.call("daemon:status")).pid, a.pid);
});

test("a live owner's lock is reported and never removed", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-bootstrap-live-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, "runtime.lock"));
  // This test's own process: alive, and started before the lock was taken.
  const record = JSON.stringify({ pid: process.pid, token: "preserve-me", startedAt: new Date().toISOString() });
  await fs.writeFile(path.join(dataDir, "runtime.lock/owner.json"), record);
  await assert.rejects(ensureDaemon({ dataDir, version: "1", cwd: dataDir, startupTimeoutMs: 300 }), /owned|ownership|start|lock/i);
  assert.equal(await fs.readFile(path.join(dataDir, "runtime.lock/owner.json"), "utf8"), record);
});

test("a host that crashed is started again over its lock and socket", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-bootstrap-crashed-")));
  const clients = [];
  t.after(async () => {
    await stopClients(clients);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const options = { dataDir, version: "1", cwd: dataDir };
  const first = await ensureDaemon(options);
  const { pid } = await first.call("daemon:status");
  const closed = once(first, "close");
  process.kill(pid, "SIGKILL");
  await closed;
  // A crash leaves both behind.
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "runtime.lock/owner.json"), "utf8")).pid, pid);
  assert.ok(await fs.stat(socketPath(dataDir)));
  const again = await ensureDaemon(options);
  clients.push(again);
  const status = await again.call("daemon:status");
  assert.notEqual(status.pid, pid);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "runtime.lock/owner.json"), "utf8")).pid, status.pid);
});

test("a host that is still exiting when the start begins is started again once it has", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-bootstrap-exiting-")));
  const clients = [];
  t.after(async () => {
    await stopClients(clients);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  // Stands in for a crashed host the kernel hasn't finished with: its lock still names a live process, for a moment.
  const exiting = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "ignore" });
  await once(exiting, "spawn");
  await fs.mkdir(path.join(dataDir, "runtime.lock"));
  const record = { pid: exiting.pid, token: "exiting", startedAt: new Date().toISOString() };
  await fs.writeFile(path.join(dataDir, "runtime.lock/owner.json"), JSON.stringify(record));
  const again = await ensureDaemon({ dataDir, version: "1", cwd: dataDir });
  clients.push(again);
  assert.notEqual((await again.call("daemon:status")).pid, exiting.pid);
});

test("a host that drops each connection while it exits is started again", async (t) => {
  const clients = [];
  const dataDir = await dataDirFor(t, "dropping", clients);
  const socket = socketPath(dataDir);
  prepareSocketDirectory(socket);
  // Stands in for a host left exiting by a force quit: it accepts, then closes before replying. Depending on timing the
  // desktop sees EPIPE, ECONNRESET or a plain close; each used to end the launch with that error.
  let dropped = 0;
  const server = net.createServer((connection) => {
    dropped++;
    connection.on("error", () => {});
    connection.destroy();
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const again = await ensureDaemon({ dataDir, version: "1", cwd: dataDir });
  clients.push(again);
  assert.ok(dropped >= 1);
  assert.notEqual((await again.call("daemon:status")).pid, process.pid);
});

test("a reachable older daemon is rejected without starting a competing runtime", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-bootstrap-old-")));
  const socket = socketPath(dataDir);
  prepareSocketDirectory(socket);
  const server = net.createServer((connection) => {
    connection.on("data", (data) => {
      const request = JSON.parse(String(data));
      connection.write(JSON.stringify({ v: 1, id: request.id, result: { version: "old", capabilities: ["desktop-v1"], methods: [] } }) + "\n");
    });
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await assert.rejects(ensureDaemon({ dataDir, version: "new", executable: "/never-run" }), { code: "INCOMPATIBLE_DAEMON" });
  await assert.rejects(fs.stat(path.join(dataDir, "runtime.lock")), { code: "ENOENT" });
});

async function dataDirFor(t, label, clients = []) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `milagre-bootstrap-${label}-`)));
  t.after(async () => {
    await stopClients(clients);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

// A host that answers daemon:status with the given result and, on daemon:stop, exits (closes) unless `stubborn`.
async function fakeHost(t, dataDir, status, { stubborn = false } = {}) {
  const socket = socketPath(dataDir);
  prepareSocketDirectory(socket);
  const connections = new Set();
  const calls = [];
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    connection.on("data", (data) => {
      const request = JSON.parse(String(data));
      calls.push(request.method);
      const result = request.method === "daemon:status" ? status : { stopping: true };
      connection.write(JSON.stringify({ v: 1, id: request.id, result }) + "\n");
      if (request.method === "daemon:stop" && !stubborn) {
        server.close();
        for (const open of connections) open.destroy();
      }
    });
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(() => {
    for (const open of connections) open.destroy();
    server.close();
  });
  return calls;
}

const compatible = { capabilities: ["desktop-v1", "snapshot-pages-v1"], methods: [] };

test("a host from an older app version is stopped and replaced by one from this app", async (t) => {
  const clients = [];
  const dataDir = await dataDirFor(t, "upgrade", clients);
  const old = await ensureDaemon({ dataDir, version: "0.101.0", cwd: dataDir });
  clients.push(old);
  const oldStatus = await old.call("daemon:status");
  const closed = once(old, "close");
  const next = await ensureDaemon({ dataDir, version: "0.104.1", cwd: dataDir });
  clients.push(next);
  await closed;
  const status = await next.call("daemon:status");
  assert.equal(status.version, "0.104.1");
  assert.notEqual(status.pid, oldStatus.pid);
});

test("a host that reports no app version is stopped and replaced", async (t) => {
  const clients = [];
  const dataDir = await dataDirFor(t, "unversioned", clients);
  const calls = await fakeHost(t, dataDir, { ...compatible, pid: 1 });
  const next = await ensureDaemon({ dataDir, version: "1.2.3", cwd: dataDir });
  clients.push(next);
  assert.ok(calls.includes("daemon:stop"));
  assert.equal((await next.call("daemon:status")).version, "1.2.3");
});

test("a host from the same app version is reused and left running", async (t) => {
  const clients = [];
  const dataDir = await dataDirFor(t, "same", clients);
  const first = await ensureDaemon({ dataDir, version: "3.0.0", cwd: dataDir });
  clients.push(first);
  const { pid } = await first.call("daemon:status");
  const again = await ensureDaemon({ dataDir, version: "3.0.0", cwd: dataDir, executable: "/never-run" });
  clients.push(again);
  assert.equal((await again.call("daemon:status")).pid, pid);
});

test("a host from a newer app version is reused by an older desktop", async (t) => {
  const clients = [];
  const dataDir = await dataDirFor(t, "newer", clients);
  const first = await ensureDaemon({ dataDir, version: "2.0.0", cwd: dataDir });
  clients.push(first);
  const { pid } = await first.call("daemon:status");
  const again = await ensureDaemon({ dataDir, version: "1.9.9", cwd: dataDir, executable: "/never-run" });
  clients.push(again);
  assert.equal((await again.call("daemon:status")).pid, pid);
});

test("a host whose close failed is stopped again and replaced, even from the same app version", async (t) => {
  const clients = [];
  const dataDir = await dataDirFor(t, "closing", clients);
  const calls = await fakeHost(t, dataDir, { ...compatible, version: "1.2.3", closing: true });
  const next = await ensureDaemon({ dataDir, version: "1.2.3", cwd: dataDir });
  clients.push(next);
  assert.ok(calls.includes("daemon:stop"));
  const status = await next.call("daemon:status");
  assert.equal(status.closing, false);
  assert.notEqual(status.pid, undefined);
});

test("a closing host that does not stop is reported instead of connected to", async (t) => {
  const dataDir = await dataDirFor(t, "closing-stubborn");
  const calls = await fakeHost(t, dataDir, { ...compatible, version: "0.2.0", closing: true }, { stubborn: true });
  await assert.rejects(ensureDaemon({ dataDir, version: "0.2.0", executable: "/never-run", startupTimeoutMs: 300 }), { code: "STALE_DAEMON" });
  assert.ok(calls.includes("daemon:stop"));
});

test("an older host that does not stop is reported instead of connected to", async (t) => {
  const dataDir = await dataDirFor(t, "stubborn");
  const calls = await fakeHost(t, dataDir, { ...compatible, version: "0.1.0" }, { stubborn: true });
  await assert.rejects(ensureDaemon({ dataDir, version: "0.2.0", executable: "/never-run", startupTimeoutMs: 300 }), {
    code: "STALE_DAEMON",
    message: /A previous Milagre host is still running and did not stop\. Quit Milagre, then run: pkill -f 'milagre\.\* serve'/,
  });
  assert.ok(calls.includes("daemon:stop"));
});
