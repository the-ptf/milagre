const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

const pr = { number: 12, title: "Faster PR panel", url: "https://github.com/example/project/pull/12", state: "OPEN", readyToMerge: false, hasConflicts: false };

test("pull-requests:snapshot answers for the Worktrees whose Chats have messages", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-pr-snapshot-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const reads = [];
  const turns = [];
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    readPullRequest: async (folder) => {
      reads.push(folder);
      return pr;
    },
    readPullRequests: async (_folder, refs) => refs.map(() => null),
    createSession(_provider, options) {
      return {
        turnActive: false,
        startTurn: async (request) => {
          turns.push(request);
          options.emit({ type: "turn-started", turnId: "turn" });
          return { turnId: "turn" };
        },
        interrupt: async () => options.emit({ type: "turn-cancelled" }),
        close: async () => {},
      };
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project);
  const sessionId = Object.values(opened.state.sessions)[0].id;

  assert.deepEqual(
    await runtime.invoke("pull-requests:snapshot", [project]),
    { worktrees: {}, chats: {}, pending: false },
    "a Chat without messages has no PR row",
  );
  assert.deepEqual(await runtime.invoke("pull-requests:snapshot", [path.join(dir, "elsewhere")]), { worktrees: {}, chats: {}, pending: false });

  await runtime.invoke("chat:send", [
    {
      projectPath: project,
      sessionId,
      body: "Open a PR",
      prompt: "Open a PR",
      images: [],
      files: [],
      provider: "codex",
      model: "test",
      permissionMode: "full",
    },
  ]);
  await waitUntil(() => turns.length === 1);
  const snapshot = await runtime.invoke("pull-requests:snapshot", [project]);
  assert.deepEqual(snapshot, { worktrees: { [project]: pr }, chats: {}, pending: false });
  assert.deepEqual(reads, [project]);
});

test("pull-requests:open lists the repository's open PRs, once a minute at most", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-pr-open-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const lists = [];
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    listOpenPullRequests: async (folder) => {
      lists.push(folder);
      return [{ ...pr, updatedAt: "2026-11-08T10:00:00Z" }];
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await runtime.openProject(project);
  assert.deepEqual(await runtime.invoke("pull-requests:open", [project]), [{ ...pr, updatedAt: "2026-11-08T10:00:00Z" }]);
  await runtime.invoke("pull-requests:open", [project]);
  assert.deepEqual(lists, [project]);
  assert.deepEqual(await runtime.invoke("pull-requests:open", [path.join(dir, "elsewhere")]), []);
  assert.deepEqual(lists, [project]);
});
