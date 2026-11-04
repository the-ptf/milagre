const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");

const DAY = 24 * 60 * 60 * 1000;

test("Clean up worktrees lists idle Milagre worktrees with what each loses, and removes them with their Chats", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-storage-")));
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
  await fs.writeFile(path.join(dirty.path, "notes.txt"), "unsaved");

  assert.deepEqual((await runtime.invoke("storage:worktrees", [])).worktrees, [], "nothing new is offered");
  Date.now = () => realNow() + 31 * DAY;
  const { worktrees } = await runtime.invoke("storage:worktrees", []);
  const byPath = Object.fromEntries(worktrees.map((item) => [item.path, item]));
  assert.deepEqual(Object.keys(byPath).sort(), [clean.path, dirty.path].sort());
  assert.equal(byPath[clean.path].status.removable, true);
  assert.equal(byPath[dirty.path].status.uncommitted, 1);
  assert.equal(byPath[clean.path].projectPath, folder);
  assert.equal(byPath[clean.path].chats, 1);

  // Unsaved work only goes forced, against the status the user saw.
  await assert.rejects(runtime.invoke("storage:remove-worktree", [{ projectPath: folder, path: dirty.path, seen: byPath[dirty.path].status }]));
  let state = (await runtime.invoke("project:current")).state;
  assert.equal(state.sessions[dirty.id].archived, undefined, "a refused removal brings its Chat back");
  assert.equal(existsSync(dirty.path), true);

  const removed = await runtime.invoke("storage:remove-worktree", [{ projectPath: folder, path: clean.path, seen: byPath[clean.path].status }]);
  assert.equal(removed.removed, true);
  const forced = await runtime.invoke("storage:remove-worktree", [{ projectPath: folder, path: dirty.path, seen: byPath[dirty.path].status, force: true }]);
  assert.equal(forced.removed, true);
  state = (await runtime.invoke("project:current")).state;
  assert.equal(existsSync(clean.path), false);
  assert.equal(existsSync(dirty.path), false);
  assert.equal(state.sessions[clean.id], undefined, "its Chats go with the worktree");
  assert.equal(state.sessions[dirty.id], undefined);
  const again = await runtime.invoke("storage:remove-worktree", [{ projectPath: folder, path: clean.path, seen: byPath[clean.path].status }]);
  assert.equal(again.alreadyRemoved, true, "a second removal finds it gone");
  assert.deepEqual((await runtime.invoke("storage:worktrees", [])).worktrees, []);
});
