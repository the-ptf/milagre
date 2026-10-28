const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorktreeSetups, outputTail, resolveSetupCommand, runSetupCommand, setupCompleted, setupNote } = require("./worktree-setup.cjs");
const { createWorktree } = require("./worktrees.cjs");

async function tempDir(t, prefix = "milagre-setup-") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeRepoFile(project, text) {
  await fs.mkdir(path.join(project, ".milagre"), { recursive: true });
  await fs.writeFile(path.join(project, ".milagre", "worktree.json"), text);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the repo file wins over the setting, which wins over nothing", async (t) => {
  const project = await tempDir(t);
  assert.deepEqual(await resolveSetupCommand(project, ""), { source: "none", command: null });
  assert.deepEqual(await resolveSetupCommand(project, "  npm ci "), { source: "setting", command: "npm ci" });
  await writeRepoFile(project, JSON.stringify({ setup: "pnpm install --frozen-lockfile" }));
  assert.deepEqual(await resolveSetupCommand(project, "npm ci"), { source: "repo", command: "pnpm install --frozen-lockfile" });
  // An empty `setup` is the repo saying "run nothing", not a gap for the setting to fill.
  await writeRepoFile(project, JSON.stringify({ setup: "" }));
  assert.deepEqual(await resolveSetupCommand(project, "npm ci"), { source: "repo", command: null });
  // A file without `setup` leaves the choice to the setting.
  await writeRepoFile(project, JSON.stringify({ other: true }));
  assert.deepEqual(await resolveSetupCommand(project, "npm ci"), { source: "setting", command: "npm ci" });
});

test("an invalid repo file is ignored with a note", async (t) => {
  const project = await tempDir(t);
  await writeRepoFile(project, "{ setup: npm ci");
  assert.deepEqual(await resolveSetupCommand(project, "uv sync"), {
    source: "setting",
    command: "uv sync",
    note: ".milagre/worktree.json isn't valid JSON, so Milagre ignored it.",
  });
  assert.deepEqual(await resolveSetupCommand(project, ""), {
    source: "none",
    command: null,
    note: ".milagre/worktree.json isn't valid JSON, so Milagre ignored it.",
  });
  await writeRepoFile(project, JSON.stringify({ setup: ["npm", "ci"] }));
  assert.match((await resolveSetupCommand(project, "")).note, /"setup" in \.milagre\/worktree\.json must be a string/);
});

test("the note for the agent names the command, why it failed, and the last 40 lines", () => {
  const output = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
  const note = setupNote("npm ci", { status: "failed", exitCode: 1, signal: null, output: `${output}\n\n` });
  assert.ok(note.startsWith("Note: the worktree setup command `npm ci` failed with exit code 1. Last output:\nline 11\n"));
  assert.ok(note.endsWith("\nline 50"));
  assert.equal(
    setupNote("npm ci", { status: "timed-out", exitCode: null, signal: "SIGTERM", output: "" }),
    "Note: the worktree setup command `npm ci` timed out after 10m 0s.",
  );
  assert.equal(setupNote("npm ci", { status: "done", exitCode: 0, output: "ok" }), "");
  assert.equal(setupNote("npm ci", { status: "cancelled", exitCode: null, output: "x" }), "");
  assert.equal(outputTail("\u001b[31mred\u001b[0m\nnext\n", 1), "next");
  assert.equal(outputTail("\u001b[31mred\u001b[0m", 5), "red");
});

test("the setup step is a setup step with how it ended", () => {
  const done = setupCompleted("s1", "npm ci", { status: "done", exitCode: 0, output: "added 3 packages\n", durationMs: 12_400 });
  assert.deepEqual(done, {
    type: "step-completed",
    id: "s1",
    status: "done",
    title: "Ran setup `npm ci`",
    note: "12s",
    detail: "$ npm ci\nadded 3 packages\n",
    durationMs: 12_400,
  });
  const failed = setupCompleted("s1", "npm ci", { status: "failed", exitCode: 1, output: "boom\n", durationMs: 2000 });
  assert.equal(failed.status, "failed");
  assert.equal(failed.title, "Setup failed `npm ci`");
  assert.equal(failed.note, "exited with code 1 after 2s");
  assert.equal(setupCompleted("s1", "npm ci", { status: "failed", exitCode: null, error: "spawn ENOENT", output: "", durationMs: 10 }).note, "failed after 1s");
  assert.equal(setupCompleted("s1", "npm ci", { status: "timed-out", exitCode: null, output: "", durationMs: 10 }, 600_000).note, "timed out after 10m 0s");
  assert.equal(failed.detail, "$ npm ci\nboom\n\nExited with code 1");
});

test("a command runs in the login shell in its folder and streams its output", async (t) => {
  const dir = await tempDir(t);
  const streamed = [];
  const result = await runSetupCommand({ command: "pwd; echo out; echo err >&2; exit 3", cwd: dir, onOutput: (text) => streamed.push(text) });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 3);
  assert.match(result.output, new RegExp(`${dir}\\n`));
  assert.match(result.output, /out\n/);
  assert.match(result.output, /err\n/);
  assert.equal(streamed.join(""), result.output);
  assert.equal((await runSetupCommand({ command: "true", cwd: dir })).status, "done");
});

test("a timeout stops the command and everything it started", async (t) => {
  const dir = await tempDir(t);
  const result = await runSetupCommand({ command: "sleep 30 & echo $! > child.pid; wait", cwd: dir, timeoutMs: 300 });
  assert.equal(result.status, "timed-out");
  const pid = Number(await fs.readFile(path.join(dir, "child.pid"), "utf8"));
  assert.equal(alive(pid), false);
  assert.ok(result.durationMs < 5000);
});

test("cancelling a chat's setup stops the tree and the turn reports it", async (t) => {
  const dir = await tempDir(t);
  const events = [];
  const setups = new WorktreeSetups({ send: (chatId, event) => events.push({ chatId, event }), batchMs: 5 });
  assert.deepEqual(
    await setups.prepare({ worktreePath: dir, projectPath: "/work/shop", resolved: { source: "repo", command: "sleep 30 & echo $! > child.pid; wait" } }),
    { command: "sleep 30 & echo $! > child.pid; wait", source: "repo" },
  );
  const turn = setups.beforeTurn("chat#1", dir);
  // A second message while it runs waits for the same run.
  const steer = setups.beforeTurn("chat#1", dir);
  for (let n = 0; n < 100 && !(await fs.stat(path.join(dir, "child.pid")).catch(() => null)); n++) await new Promise((resolve) => setTimeout(resolve, 20));
  await setups.cancel("chat#1");
  assert.deepEqual(await turn, { cancelled: true, note: "" });
  assert.deepEqual(await steer, { cancelled: true, note: "" });
  const pid = Number(await fs.readFile(path.join(dir, "child.pid"), "utf8"));
  assert.equal(alive(pid), false);
  assert.equal(events[0].event.type, "step-started");
  assert.equal(events[0].event.step.title, "Running setup `sleep 30 & echo $! > child.pid; wait`");
  assert.equal(events[0].event.step.kind, "setup");
  const end = events.at(-1).event;
  assert.equal(end.type, "step-completed");
  assert.equal(end.status, "failed");
  assert.equal(end.title, "Setup failed `sleep 30 & echo $! > child.pid; wait`");
  assert.match(end.note, /stopped after/);
  // It ran once: the next turn finds nothing to run.
  assert.deepEqual(await setups.beforeTurn("chat#1", dir), { cancelled: false, note: "" });
});

test("a project with no command runs nothing; a repo or typed command always runs", async () => {
  const ran = [];
  const setups = new WorktreeSetups({
    send: () => {},
    run: async ({ command }) => (ran.push(command), { status: "done", exitCode: 0, output: "", durationMs: 1 }),
  });
  assert.deepEqual(await setups.prepare({ worktreePath: "/w/a", projectPath: "/p", resolved: { source: "repo", command: "make a" } }), {
    command: "make a",
    source: "repo",
  });
  assert.deepEqual(await setups.beforeTurn("p#1", "/w/a"), { cancelled: false, note: "" });
  assert.deepEqual(await setups.prepare({ worktreePath: "/w/b", projectPath: "/p", resolved: { source: "setting", command: "make b" } }), {
    command: "make b",
    source: "setting",
  });
  assert.deepEqual(await setups.beforeTurn("p#2", "/w/b"), { cancelled: false, note: "" });
  assert.equal(await setups.prepare({ worktreePath: "/w/c", projectPath: "/p", resolved: { source: "none", command: null } }), null);
  assert.deepEqual(await setups.beforeTurn("p#3", "/w/c"), { cancelled: false, note: "" });
  assert.deepEqual(ran, ["make a", "make b"]);
});

test("a worktree made through a symlink still runs its setup when the chat names its real path", async (t) => {
  const real = await tempDir(t);
  const link = path.join(await tempDir(t, "milagre-link-"), "worktrees");
  await fs.symlink(real, link);
  const ran = [];
  const setups = new WorktreeSetups({ send: () => {}, run: async ({ cwd }) => (ran.push(cwd), { status: "done", exitCode: 0, output: "", durationMs: 1 }) });
  await setups.prepare({ worktreePath: link, projectPath: "/p", resolved: { source: "repo", command: "npm ci" } });
  await setups.beforeTurn("p#1", real);
  assert.deepEqual(ran, [real]);
});

test("a failed setup lets the turn run with a note", async () => {
  const events = [];
  const setups = new WorktreeSetups({
    send: (_chatId, event) => events.push(event),
    run: async ({ onOutput }) => {
      onOutput("npm ERR! missing lockfile\n");
      return { status: "failed", exitCode: 1, signal: null, output: "npm ERR! missing lockfile\n", durationMs: 900 };
    },
    batchMs: 1,
  });
  await setups.prepare({ worktreePath: "/w/a", projectPath: "/p", resolved: { source: "repo", command: "npm ci" } });
  assert.deepEqual(await setups.beforeTurn("p#1", "/w/a"), {
    cancelled: false,
    note: "Note: the worktree setup command `npm ci` failed with exit code 1. Last output:\nnpm ERR! missing lockfile",
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["step-started", "step-output", "step-completed"],
  );
});

test("a new worktree's setup command runs inside the worktree", async (t) => {
  const root = await tempDir(t, "milagre-setup-worktree-");
  const project = path.join(root, "shop");
  await fs.mkdir(project);
  const git = (...args) =>
    execFileSync("git", ["-C", project, "-c", "user.name=Milagre", "-c", "user.email=milagre@example.com", ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  await writeRepoFile(project, JSON.stringify({ setup: `node -e "require('fs').writeFileSync('ok','1')"` }));
  git("add", ".");
  git("commit", "-m", "init");
  const created = await createWorktree({
    projectPath: project,
    baseBranch: "main",
    prompt: "Set things up",
    root: path.join(root, "worktrees"),
    suffix: "st01",
  });
  const events = [];
  const setups = new WorktreeSetups({ send: (_chatId, event) => events.push(event) });
  const plan = await setups.prepare({ worktreePath: created.path, projectPath: project, resolved: await resolveSetupCommand(project, "") });
  assert.deepEqual(plan, { command: `node -e "require('fs').writeFileSync('ok','1')"`, source: "repo" });
  assert.deepEqual(await setups.beforeTurn(`${project}#1`, created.path), { cancelled: false, note: "" });
  assert.equal(await fs.readFile(path.join(created.path, "ok"), "utf8"), "1");
  await assert.rejects(fs.access(path.join(project, "ok")));
  assert.equal(events.at(-1).status, "done");
});

test("Stop cancels a second Chat waiting for the same Worktree without cancelling its owner's review", async () => {
  let decide;
  let ownerSignal;
  const setups = new WorktreeSetups({
    send() {},
    review: ({ signal }) => {
      ownerSignal = signal;
      return new Promise((resolve) => {
        decide = resolve;
      });
    },
    run: () => assert.fail("Skipped setup must not run"),
  });
  await setups.prepare({ worktreePath: "/w/shared", projectPath: "/p", resolved: { source: "repo", command: "npm ci" } });
  const owner = setups.beforeTurn("p#1", "/w/shared");
  const waiting = setups.beforeTurn("p#2", "/w/shared");
  await setups.cancel("p#2");
  assert.equal(ownerSignal.aborted, false);
  decide({ skipped: true, command: "npm ci" });
  assert.equal((await owner).cancelled, false);
  assert.equal((await waiting).cancelled, true);
});
