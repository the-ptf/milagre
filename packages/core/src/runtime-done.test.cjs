const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");

const HOUR = 60 * 60 * 1000;

test("the Done sweep archives Chats past their retention, removes a clean worktree, keeps unsaved work and leaves a reopened Chat", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-done-")));
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
    const session = Object.values(made.project.state.sessions).find((item) => item.worktree_id === made.worktreeId);
    return { id: session.id, path: made.project.state.worktrees[made.worktreeId].path };
  };
  const clean = await chatOn("clean work");
  const dirty = await chatOn("dirty work");
  const reopened = await chatOn("reopened work");
  await fs.writeFile(path.join(dirty.path, "notes.txt"), "unsaved");
  await runtime.invoke("done:settings:save", [{ retentionHours: 1 }]);
  for (const chat of [clean, dirty, reopened]) await runtime.invoke("chat:patch", [folder, chat.id, { done: true }]);
  await runtime.invoke("chat:patch", [folder, reopened.id, { done: false }]);

  assert.deepEqual(await runtime.sweepDone(), [], "nothing is due before its retention");
  Date.now = () => realNow() + HOUR + 60_000;
  const archived = await runtime.sweepDone();
  assert.deepEqual(archived.sort(), [`${folder}#${clean.id}`, `${folder}#${dirty.id}`].sort());

  const state = (await runtime.invoke("project:current")).state;
  assert.equal(existsSync(clean.path), false, "a clean worktree goes with its Chat");
  assert.equal(state.sessions[clean.id], undefined, "its Chat leaves with the worktree, as an archive's does");
  assert.equal(existsSync(path.join(dirty.path, "notes.txt")), true, "unsaved work is kept");
  assert.equal(state.sessions[dirty.id].archived, true);
  assert.equal(state.sessions[reopened.id].archived, undefined, "a reopened Chat stays");
  assert.equal(existsSync(reopened.path), true);
});
