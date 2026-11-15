const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");

const HOUR = 60 * 60 * 1000;

test("a snoozed Chat wakes when its time comes, unread; Done takes it out of the Snoozed list", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-snooze-")));
  const folder = path.join(dir, "app");
  await fs.mkdir(folder);
  execFileSync("git", ["init", "-qb", "main", folder]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "Initial"]);
  const runtime = createRuntime({
    cwd: folder,
    titleModels: {},
    expandSkills: false,
    dataDir: path.join(dir, "profile"),
    chatsHome: path.join(dir, "chats"),
    worktreeRoot: path.join(dir, "worktrees"),
    registryRoots: [],
    environmentReady: Promise.resolve(),
    emit: () => {},
  });
  const realNow = Date.now;
  t.after(async () => {
    Date.now = realNow;
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await runtime.openProject(folder);
  const chatOn = async (prompt) => {
    const made = await runtime.invoke("worktree:create", [{ projectPath: folder, baseBranch: "main", prompt }]);
    return Object.values(made.project.state.sessions).find((item) => item.worktree_id === made.worktreeId).id;
  };
  const sleeper = await chatOn("sleep");
  const later = await chatOn("later");
  const finished = await chatOn("finished");
  const until = realNow() + HOUR;
  for (const id of [sleeper, finished]) await runtime.invoke("chat:patch", [folder, id, { snoozed_until: until }]);
  await runtime.invoke("chat:patch", [folder, later, { snoozed_until: until + 2 * HOUR }]);
  await runtime.invoke("chat:patch", [folder, finished, { done: true }]);

  let state = (await runtime.invoke("project:current")).state;
  assert.equal(state.sessions[sleeper].snoozed_until, until);
  assert.equal(state.sessions[finished].snoozed_until, undefined, "Done takes a Chat out of the Snoozed list");

  assert.deepEqual(await runtime.sweepSnoozed(), [], "nothing wakes before its time");
  Date.now = () => until + 1000;
  assert.deepEqual(await runtime.sweepSnoozed(), [`${folder}#${sleeper}`]);
  state = (await runtime.invoke("project:current")).state;
  assert.equal(state.sessions[sleeper].snoozed_until, undefined);
  assert.equal(state.sessions[sleeper].unread, true, "a woken Chat comes back unread");
  assert.equal(state.sessions[later].snoozed_until, until + 2 * HOUR, "a later one sleeps on");

  await runtime.invoke("chat:patch", [folder, later, { snoozed_until: false }]);
  state = (await runtime.invoke("project:current")).state;
  assert.equal(state.sessions[later].snoozed_until, undefined, "Wake takes it out at once");
});

// From the Snooze statechart (#1039): a question or a failure that reached the host while a Snooze waited to be saved
// found the Chat awake and woke nothing, so it slept with the user's question until its timer.
test("a question or failure that comes while a Snooze is being saved wakes the Chat; one already open waits", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-snooze-race-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-qb", "main", project]);
  const sessions = [];
  const runtime = createRuntime({
    cwd: project,
    dataDir: path.join(dir, "profile"),
    chatsHome: path.join(dir, "chats"),
    version: "9.8.7",
    environmentReady: Promise.resolve(),
    emit: () => {},
    titleModels: {},
    agentCli: async () => ({ command: "/fake" }),
    createSession(provider, options) {
      const session = {
        provider,
        options,
        closed: false,
        startTurn: async () => {
          options.emit({ type: "turn-started", turnId: "t" });
          return { turnId: "t" };
        },
        interrupt: async () => {},
        close: async () => {
          session.closed = true;
        },
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const opened = await runtime.openProject(project);
  const chat = Object.values(opened.state.sessions)[0];
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: chat.id, body: "Work", provider: "claude", model: "claude-opus-5-5" }]);
  for (let i = 0; i < 200 && !sessions.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const emit = sessions[0].options.emit;
  const snoozedUntil = async () => (await runtime.invoke("project:snapshot", [project])).state.sessions[chat.id].snoozed_until;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  for (const event of [
    { type: "question-request", requestId: "q1", questions: [{ id: "0", question: "Which one?", options: [] }] },
    { type: "turn-failed", message: "boom" },
  ]) {
    const saving = runtime.invoke("chat:patch", [project, chat.id, { snoozed_until: Date.now() + HOUR }]);
    emit(event);
    await saving;
    await settle();
    assert.equal(await snoozedUntil(), undefined, `${event.type} during the save wakes the Chat`);
  }

  // Snoozing a Chat that already asked is "ask me later": it stays snoozed.
  emit({ type: "turn-started", turnId: "t2" });
  emit({ type: "question-request", requestId: "q2", questions: [{ id: "0", question: "Again?", options: [] }] });
  await settle();
  const until = Date.now() + HOUR;
  await runtime.invoke("chat:patch", [project, chat.id, { snoozed_until: until }]);
  await settle();
  assert.equal(await snoozedUntil(), until);
});
