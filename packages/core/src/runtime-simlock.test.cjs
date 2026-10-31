const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");

// A Simlock lease installs from the Chat's own Worktree, resolved from the saved Chat, never from the client.
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-simlock-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const leased = [];
  const simlock = {
    isDevice: (id) => typeof id === "string" && id.startsWith("simlock:"),
    get: () => null,
    leases: () => [],
    models: async () => [],
    identity: async () => ({}),
    upstream: () => null,
    release: async () => ({}),
    stop: async () => {},
    async lease(request) {
      leased.push(request);
      return { deviceId: "simlock:l1", leaseId: "l1", platform: "ios", name: "iPhone 17", version: "27.0", chatId: request.chatId };
    },
  };
  const device = { id: "simlock:l1", name: "iPhone 17 (Simlock)", platform: "ios", version: "27.0" };
  const simulators = {
    list: async () => ({ devices: leased.length ? [device] : [], supported: true }),
    closeViewer: async () => {},
    disconnect: async () => {},
    close: async () => {},
  };
  const runtime = createRuntime({
    dataDir: path.join(dir, "profile"),
    cwd: project,
    chatsHome: path.join(dir, "chats"),
    version: "1.0.0",
    environmentReady: Promise.resolve(),
    simlock,
    simulators,
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { runtime, project, leased };
}

test("a lease installs from the Chat's Worktree, and an unknown Chat leases nothing", async (t) => {
  const { runtime, project, leased } = await fixture(t);
  const opened = await runtime.openProject(project);
  const chat = Object.values(opened.state.sessions)[0];
  const worktree = opened.state.worktrees[chat.worktree_id].path;
  const context = { clientId: "client" };
  await runtime.invoke("simlock:lease", [{ chatId: `${project}#${chat.id}`, platform: "ios" }], context);
  assert.equal(leased.length, 1);
  assert.equal(leased[0].installDirectory, worktree);
  assert.equal(leased[0].chatId, `${project}#${chat.id}`);
  // A client can't name the folder: an extra field is ignored and the Chat's own is used.
  await runtime.invoke("simlock:lease", [{ chatId: `${project}#${chat.id}`, platform: "ios", installDirectory: "/etc" }], context);
  assert.equal(leased[1].installDirectory, worktree);
  await assert.rejects(runtime.invoke("simlock:lease", [{ chatId: `${project}#999`, platform: "ios" }], context), /existing Chat/);
  await assert.rejects(runtime.invoke("simlock:lease", [{ chatId: `${project}#${chat.id}`, platform: "ios" }]), /authenticated/);
  assert.equal(leased.length, 2);
});
