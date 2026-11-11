const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { connectDesktopRuntime } = require("./runtime-client.cjs");

async function waitFor(read) {
  for (let i = 0; i < 300; i++) {
    const result = read();
    if (result) return result;
    await delay(10);
  }
  throw new Error("Timed out waiting for the desktop");
}

// A desktop on its own host with two Projects; `other` was opened by another client, so the desktop knows it only from
// the sidebar's open (canvas:open-project).
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-runtime-client-")));
  const project = path.join(root, "project");
  const other = path.join(root, "other");
  for (const folder of [project, other]) {
    await fs.mkdir(folder);
    execFileSync("git", ["init", "-b", "main", folder], { stdio: "ignore" });
  }
  const dataDir = path.join(root, "profile");
  const runtimeOptions = { cwd: project, environmentReady: Promise.resolve(), titleModels: {}, registryRoots: [] };
  const daemons = [];
  const start = async () => {
    const daemon = await startDaemon({ dataDir, version: "test", runtimeOptions });
    daemons.push(daemon);
    return daemon;
  };
  const daemon = await start();
  const events = [];
  const desktop = await connectDesktopRuntime({
    dataDir,
    version: "test",
    cwd: project,
    reconnectMs: 20,
    emit: (channel, payload) => events.push({ channel, payload }),
  });
  t.after(async () => {
    await desktop.close().catch(() => {});
    for (const item of daemons) await item.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const another = await connect({ dataDir });
  await another.call("project:open", [other]);
  another.close();
  await desktop.openProject(project);
  assert.equal((await desktop.invoke("canvas:open-project", [other])).path, other);
  const restart = async () => {
    await daemon.close();
    await waitFor(() => events.some((event) => event.channel === "runtime:connection" && !event.payload.connected));
    const from = events.length;
    await start();
    await waitFor(() => events.slice(from).some((event) => event.channel === "runtime:connection" && event.payload.connected));
  };
  return { project, other, desktop, restart };
}

test("a Project the sidebar opened is the one a reconnect opens again for the window", async (t) => {
  const { other, desktop, restart } = await fixture(t);
  await restart();
  assert.equal((await desktop.invoke("project:current")).path, other);
});

test("a reconnect goes on when the Project the sidebar opened was deleted meanwhile", async (t) => {
  const { project, other, desktop, restart } = await fixture(t);
  await fs.rm(other, { recursive: true, force: true });
  await restart();
  assert.equal((await desktop.invoke("project:current")).path, project);
});

// Isolate reopening failures from the real host's Project storage and locks.
for (const method of ["project:open", "link:open"])
  test(`reconnect drops a broken ${method} and delivers the snapshot`, async (t) => {
    const { EventEmitter } = require("node:events");
    const events = [];
    const calls = [];
    let generation = 0;
    let first;
    let latest;
    const snapshot = { eventSeq: 0, projects: [{ path: "/healthy" }] };
    const broken = method === "link:open" ? "12345678-1234-1234-1234-123456789abc" : "/broken";
    const connect = async () => {
      const index = generation++;
      const connection = new EventEmitter();
      connection.status = { methods: [], capabilities: ["result-pages-v1"] };
      connection.close = () => connection.emit("close");
      connection.call = async (name, args = []) => {
        calls.push({ index, name, args });
        if (index > 0 && name === method && args[0] === broken) throw new Error("state file unreadable");
        if (name === "link:open") return { link: { id: args[0] } };
        if (name === "project:open") return { path: args[0] };
        if (name === "daemon:snapshot") return { snapshotId: 1, pageCount: 1 };
        if (name === "daemon:snapshot-page") return JSON.stringify(snapshot);
        return {};
      };
      first ??= connection;
      latest = connection;
      return connection;
    };
    const desktop = await connectDesktopRuntime({ connect, reconnectMs: 10, emit: (channel, payload) => events.push({ channel, payload }) });
    t.after(() => desktop.close());
    const warn = t.mock.method(console, "warn", () => {});
    await desktop.openProject("/healthy");
    await desktop.invoke(method, [broken]);
    await desktop.invoke("chat:set-open", ["broken-chat"]);
    first.close();
    await waitFor(() => events.some((event) => event.channel === "runtime:snapshot"));
    assert.deepEqual(events.find((event) => event.channel === "runtime:snapshot").payload, snapshot);
    assert.ok(calls.some(({ index, name, args }) => index === 1 && name === "project:open" && args[0] === "/healthy"));
    assert.ok(calls.some(({ index, name, args }) => index === 1 && name === "chat:set-open" && args[0] === null));
    assert.ok(warn.mock.calls.some(({ arguments: args }) => args[1].endsWith(broken) && args[2] === "state file unreadable"));
    latest.close();
    await waitFor(() => events.filter((event) => event.channel === "runtime:snapshot").length === 2);
    assert.equal(
      calls.some(({ index, name, args }) => index === 2 && name === method && args[0] === broken),
      false,
    );
  });

for (const failure of [
  Object.assign(new Error("closed"), { code: "DAEMON_CLOSED" }),
  Object.assign(new Error("closing"), { code: "CLOSING" }),
  Object.assign(new Error("unauthorized"), { code: "UNAUTHORIZED" }),
  Object.assign(new Error("reset"), { code: "ECONNRESET" }),
  Object.assign(new Error("invalid frame"), { code: "FRAME_TOO_LARGE" }),
  new Error("Daemon connection closed"),
  new Error("Timed out: project:open. It may still be running; do not retry a mutation without checking state."),
])
  test(`reconnect retries connection failures without dropping the Project: ${failure.message}`, async (t) => {
    const { EventEmitter } = require("node:events");
    const events = [];
    const reopened = [];
    let generation = 0;
    let first;
    const desktop = await connectDesktopRuntime({
      reconnectMs: 10,
      emit: (channel, payload) => events.push({ channel, payload }),
      connect: async () => {
        const index = generation++;
        const connection = new EventEmitter();
        connection.status = { methods: [], capabilities: ["result-pages-v1"] };
        connection.close = () => connection.emit("close");
        connection.call = async (name, args = []) => {
          if (name === "project:open") {
            reopened.push(index);
            if (index === 1) throw failure;
            return { path: args[0] };
          }
          if (name === "daemon:snapshot") return { snapshotId: 1, pageCount: 1 };
          if (name === "daemon:snapshot-page") return JSON.stringify({ eventSeq: 0 });
          return {};
        };
        first ??= connection;
        return connection;
      },
    });
    t.after(() => desktop.close());
    await desktop.openProject("/project");
    first.close();
    await waitFor(() => events.some((event) => event.channel === "runtime:snapshot"));
    assert.ok(events.some(({ channel, payload }) => channel === "runtime:connection" && payload.message === `Host unavailable: ${failure.message}`));
    assert.ok(reopened.includes(2), "the Project is still remembered on the next reconnect");
  });
