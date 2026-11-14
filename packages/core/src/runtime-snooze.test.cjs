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
