const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");

const DAY = 24 * 60 * 60 * 1000;

async function fixture(t) {
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
    agentCli: async () => ({ command: "fixture" }),
    createSession(_provider, options) {
      return {
        turnActive: false,
        startTurn: async () => {
          options.emit({ type: "turn-started", turnId: "turn" });
          options.emit({ type: "turn-completed" });
          return { turnId: "turn" };
        },
        close: async () => {},
      };
    },
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
    return { id: session.id, worktreeId: made.worktreeId, path: made.project.state.worktrees[made.worktreeId].path };
  };
  const age = () => {
    Date.now = () => realNow() + 31 * DAY;
  };
  const list = async () => (await runtime.invoke("storage:worktrees", [])).worktrees;
  const remove = (item, extra = {}) => runtime.invoke("storage:remove-worktree", [{ ...item, seen: item.status, ...extra }]);
  const state = async () => (await runtime.invoke("project:current")).state;
  const send = async (chat, extra = {}) => {
    const result = await runtime.invoke("chat:send", [
      { projectPath: folder, sessionId: chat.id, worktreeId: chat.worktreeId, body: "Recent activity", provider: "codex", model: "test", ...extra },
    ]);
    for (let i = 0; i < 200; i++) {
      if ((await state()).sessions[result.sessionId]?.summary?.lastOutcome === "completed") return result;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("the test turn did not complete");
  };
  return { runtime, folder, chatOn, age, list, remove, state, send };
}

test("Clean up worktrees lists idle Milagre worktrees with what each loses, and removes them with their Chats", async (t) => {
  const { runtime, folder, chatOn, age } = await fixture(t);
  const clean = await chatOn("clean work");
  const dirty = await chatOn("dirty work");
  await fs.writeFile(path.join(dirty.path, "notes.txt"), "unsaved");

  assert.deepEqual((await runtime.invoke("storage:worktrees", [])).worktrees, [], "nothing new is offered");
  age();
  const { worktrees } = await runtime.invoke("storage:worktrees", []);
  const byPath = Object.fromEntries(worktrees.map((item) => [item.path, item]));
  assert.deepEqual(Object.keys(byPath).sort(), [clean.path, dirty.path].sort());
  assert.equal(byPath[clean.path].status.removable, true);
  assert.equal(byPath[dirty.path].status.uncommitted, 1);
  assert.equal(byPath[clean.path].projectPath, folder);
  assert.equal(byPath[clean.path].chats, 1);

  // Unsaved work only goes forced, against the status the user saw.
  await assert.rejects(
    runtime.invoke("storage:remove-worktree", [{ projectPath: folder, path: dirty.path, ...byPath[dirty.path], seen: byPath[dirty.path].status }]),
  );
  let state = (await runtime.invoke("project:current")).state;
  assert.equal(state.sessions[dirty.id].archived, undefined, "a refused removal brings its Chat back");
  assert.equal(existsSync(dirty.path), true);

  const removed = await runtime.invoke("storage:remove-worktree", [
    { projectPath: folder, path: clean.path, ...byPath[clean.path], seen: byPath[clean.path].status },
  ]);
  assert.equal(removed.removed, true);
  const forced = await runtime.invoke("storage:remove-worktree", [
    { projectPath: folder, path: dirty.path, ...byPath[dirty.path], seen: byPath[dirty.path].status, force: true },
  ]);
  assert.equal(forced.removed, true);
  state = (await runtime.invoke("project:current")).state;
  assert.equal(existsSync(clean.path), false);
  assert.equal(existsSync(dirty.path), false);
  assert.equal(state.sessions[clean.id], undefined, "its Chats go with the worktree");
  assert.equal(state.sessions[dirty.id], undefined);
  await assert.rejects(runtime.invoke("chat:git-note", [`${folder}#${clean.id}`, "Too late"]), /note was not saved/);
  await assert.rejects(
    runtime.invoke("chat:send", [{ projectPath: folder, sessionId: clean.id, body: "Too late", provider: "codex", model: "test" }]),
    /no longer exists|no longer in the project/,
  );
  const again = await runtime.invoke("storage:remove-worktree", [
    { projectPath: folder, path: clean.path, ...byPath[clean.path], seen: byPath[clean.path].status },
  ]);
  assert.equal(again.alreadyRemoved, true, "a second removal finds it gone");
  assert.deepEqual((await runtime.invoke("storage:worktrees", [])).worktrees, []);
});

test("cleanup refuses a completed turn after listing without archiving or removing its Chat", async (t) => {
  const f = await fixture(t);
  const chat = await f.chatOn("kept after turn");
  f.age();
  const [item] = await f.list();
  await f.send(chat);
  assert.equal((await f.list()).length, 0);
  await assert.rejects(f.remove(item), /changed after it was listed/);
  assert.equal(existsSync(chat.path), true);
  assert.equal((await f.state()).sessions[chat.id].archived, undefined);
});

test("cleanup refuses a new Chat on the listed worktree even if the old Chat is unchanged", async (t) => {
  const f = await fixture(t);
  const chat = await f.chatOn("kept with new chat");
  await f.runtime.invoke("chat:git-note", [`${f.folder}#${chat.id}`, "Old activity"]);
  f.age();
  const [item] = await f.list();
  // An explicit new Chat uses the worktree, not the previously selected Chat.
  const next = await f.send(chat, { sessionId: null });
  assert.notEqual(next.sessionId, chat.id);
  await assert.rejects(f.remove(item), /changed after it was listed/);
  const state = await f.state();
  assert.equal(state.sessions[chat.id].archived, undefined);
  assert.equal(state.sessions[next.sessionId].archived, undefined);
  assert.equal(existsSync(chat.path), true);
});

test("activity arriving during removal's filesystem checks keeps the Chat and worktree", async (t) => {
  const f = await fixture(t);
  const chat = await f.chatOn("kept during removal");
  f.age();
  const [item] = await f.list();
  const realpath = fs.realpath;
  let calls = 0;
  let reached;
  let release;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // openAsProject reads it first. The second read is removeWorktree, after the activity validation.
  t.mock.method(fs, "realpath", async (...args) => {
    if (args[0] === chat.path && ++calls === 2) {
      reached();
      await gate;
    }
    return realpath(...args);
  });
  const removing = assert.rejects(f.remove(item), /in use now/);
  await ready;
  const note = f.runtime.invoke("chat:git-note", [`${f.folder}#${chat.id}`, "Activity while removal checks Git"]);
  release();
  await removing;
  await note;
  assert.equal(existsSync(chat.path), true);
  const state = await f.state();
  assert.equal(state.sessions[chat.id].archived, undefined);
  assert.ok(state.messages.some((message) => message.body === "Activity while removal checks Git"));
});

test("cleanup rejects requests without the reviewed activity or with a newer idle cutoff", async (t) => {
  const f = await fixture(t);
  const chat = await f.chatOn("kept on invalid request");
  f.age();
  const [item] = await f.list();
  await assert.rejects(f.remove(item, { activity: undefined }), /changed after it was listed/);
  await assert.rejects(f.remove(item, { idleBefore: Date.now() }), /changed after it was listed/);
  assert.equal(existsSync(chat.path), true);
});
