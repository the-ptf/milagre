const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createRuntime } = require("./runtime.cjs");

const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(read) {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (value) return value;
    await delay();
  }
  assert.fail("The expected state did not arrive");
}

test("Auto update: the switch reaches every listener, and activity follows a turn and the background work after it", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-app-update-")));
  const events = [];
  const contexts = [];
  const finish = [];
  const runtime = createRuntime({
    dataDir: path.join(dir, "profile"),
    chatsHome: path.join(dir, "chats"),
    worktreeRoot: path.join(dir, "worktrees"),
    registryRoots: [],
    environmentReady: Promise.resolve(),
    titleModels: {},
    expandSkills: false,
    emit: (channel, payload) => events.push([channel, payload]),
    agentCli: async () => ({ command: "/fake" }),
    createSession: (_provider, context) => {
      contexts.push(context);
      return {
        turnActive: false,
        startTurn() {
          context.emit({ type: "turn-started", turnId: randomUUID() });
          finish.push(() => {
            context.emit({ type: "text-delta", messageId: "reply", text: "Done" });
            context.emit({ type: "turn-completed" });
          });
          return { turnId: "turn" };
        },
        close() {},
        interrupt() {},
      };
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  assert.deepEqual(await runtime.invoke("app-update:auto:read", []), { autoUpdate: false });
  assert.deepEqual(await runtime.invoke("app-update:auto:save", [true]), { autoUpdate: true });
  assert.deepEqual(
    events.filter(([channel]) => channel === "app-update:auto"),
    [["app-update:auto", { autoUpdate: true }]],
  );
  assert.deepEqual(await runtime.invoke("app-update:auto:read", []), { autoUpdate: true });

  const folder = path.join(dir, "app");
  await fs.mkdir(folder);
  execFileSync("git", ["init", "-qb", "main", folder]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"]);
  await runtime.openProject(folder);
  assert.deepEqual(await runtime.invoke("app-update:activity", []), { chats: 0, routines: 0 });

  const made = await runtime.invoke("worktree:create", [{ projectPath: folder, baseBranch: "main", prompt: "work" }]);
  const session = Object.values(made.project.state.sessions).find((item) => item.worktree_id === made.worktreeId);
  const chatId = `${folder}#${session.id}`;
  await runtime.invoke("chat:send", [{ projectPath: folder, sessionId: session.id, body: "Work", provider: "claude", model: "test", permissionMode: "full" }]);
  await until(async () => finish.length === 1 && (await runtime.invoke("chat:runs")).runs[chatId]);
  assert.deepEqual(await runtime.invoke("app-update:activity", []), { chats: 1, routines: 0 });

  // A background command outlives the turn: the Chat still counts until it ends.
  contexts[0].emit({ type: "background-tasks", tasks: [{ id: "dev", kind: "local_bash", title: "npm run dev", startedAt: 1 }] });
  finish.shift()();
  await until(async () => !(await runtime.invoke("chat:runs")).runs[chatId]);
  assert.deepEqual(await runtime.invoke("app-update:activity", []), { chats: 1, routines: 0 });
  contexts[0].emit({ type: "background-tasks", tasks: [] });
  await until(async () => (await runtime.invoke("app-update:activity", [])).chats === 0);
});
