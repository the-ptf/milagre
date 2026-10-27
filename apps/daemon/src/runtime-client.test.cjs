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
