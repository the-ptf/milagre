// What opening and switching costs the host in Git processes, which a busy Mac pays for in every switch: a switch back
// to an open Project lists its Worktrees once and reads no diff stats, a Chat switch reads at most that Chat's own
// Worktree, and the Project list, the Links and a Link's open check nothing with Git between writes.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const childProcess = require("node:child_process");

// Every git process the host starts, as { folder, command }. Wrapped before the host's modules take execFile.
const started = [];
const execFile = childProcess.execFile;
childProcess.execFile = function (file, args, ...rest) {
  if (file === "git" && Array.isArray(args) && args[0] === "-C") {
    const command = args.slice(2).filter((arg, index, list) => arg !== "-c" && list[index - 1] !== "-c");
    started.push({ folder: args[1], command: command.slice(0, 2).join(" ") });
  }
  return execFile.call(this, file, args, ...rest);
};
childProcess.execFile[util.promisify.custom] = execFile[util.promisify.custom];
const { execFileSync } = childProcess;
const { createRuntime } = require("./runtime.cjs");

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    stdio: "ignore",
  });
async function repository(folder, linked = 0) {
  await fs.mkdir(folder, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  await fs.writeFile(path.join(folder, "README.md"), "x\n");
  git(folder, "add", "README.md");
  git(folder, "commit", "-qm", "Initial");
  for (let index = 0; index < linked; index++) git(folder, "worktree", "add", "-qb", `feature-${index}`, `${folder}-feature-${index}`);
}
// Waits until no git process has started for `quiet` ms, so what a call sets going in the background counts with it.
async function settled(quiet = 300) {
  let count = started.length;
  let since = Date.now();
  while (Date.now() - since < quiet) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (started.length !== count) {
      count = started.length;
      since = Date.now();
    }
  }
}
async function gitDuring(work) {
  await settled();
  const from = started.length;
  await work();
  await settled();
  return started.slice(from);
}
const commands = (calls) => calls.map((call) => call.command);

// Two Projects, `project` with two linked Worktrees, opened in that order (so `project` is first in every list), and
// every Chat with a message, so a diff stat read would read each Worktree. The sidebar has listed the Projects once
// (the registry's first list looks for Projects and checks each with git).
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-open-cost-")));
  const project = path.join(dir, "project");
  const other = path.join(dir, "other");
  await repository(project, 2);
  await repository(other);
  const runtime = createRuntime({
    dataDir: path.join(dir, "profile"),
    cwd: project,
    version: "9.8.7",
    environmentReady: Promise.resolve(),
    registryRoots: [],
    worktreeRoot: path.join(dir, "worktrees"),
    chatsHome: path.join(dir, "chats"),
  });
  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  for (const folder of [other, project]) {
    const { state } = await runtime.openProject(folder);
    for (const id of Object.keys(state.sessions)) await runtime.invoke("chat:git-note", [`${folder}#${id}`, "A note"]);
  }
  await runtime.invoke("project:registry");
  await settled();
  return { project, other, runtime, chatsHome: path.join(dir, "chats") };
}

test("a switch back to an open Project lists its Worktrees once and reads no diff stats, and still follows git", async (t) => {
  const { project, other, runtime } = await fixture(t);
  assert.deepEqual(commands(await gitDuring(() => runtime.invoke("canvas:open-project", [project]))), ["worktree list"]);
  assert.deepEqual(commands(await gitDuring(() => runtime.invoke("canvas:open-project", [other]))), ["worktree list"]);
  assert.deepEqual(commands(await gitDuring(() => runtime.invoke("project:read", [project]))), ["worktree list"]);
  // A Worktree added outside Milagre, and one removed, are matched on the next open, which reads no more than before.
  git(project, "worktree", "add", "-qb", "added", `${project}-added`);
  git(project, "worktree", "remove", `${project}-feature-0`);
  assert.deepEqual(commands(await gitDuring(() => runtime.invoke("canvas:open-project", [project]))), ["worktree list"]);
  const { state } = await runtime.invoke("project:snapshot", [project]);
  assert.deepEqual(
    Object.values(state.worktrees)
      .map((worktree) => worktree.path)
      .toSorted(),
    [project, `${project}-added`, `${project}-feature-1`],
  );
  // The lists keep the order of the opens.
  assert.deepEqual(
    (await runtime.invoke("project:recent")).map((entry) => entry.path),
    [project, other],
  );
  assert.deepEqual(
    (await runtime.invoke("project:registry")).map((entry) => entry.path),
    [project, other],
  );
});

test("a Chat a window opens reads its own Worktree's diff stat, at most every few seconds, never the Project's others", async (t) => {
  const { project, runtime } = await fixture(t);
  const { state } = await runtime.invoke("project:snapshot", [project]);
  const session = Object.values(state.sessions).find((item) => state.worktrees[item.worktree_id].path === `${project}-feature-1`);
  const chatId = `${project}#${session.id}`;
  const opened = await gitDuring(() => runtime.chatOpened(chatId));
  assert.ok(opened.length > 0, "its Worktree is read");
  assert.deepEqual([...new Set(opened.map((call) => call.folder))], [`${project}-feature-1`]);
  assert.deepEqual(await gitDuring(() => runtime.chatOpened(chatId)), [], "and not again within seconds");
  // Focus on the window reads the whole Project, as before.
  const focused = await gitDuring(() => runtime.focused({ projectPath: project, chatId }));
  assert.deepEqual([...new Set(focused.map((call) => call.folder))].toSorted(), [project, `${project}-feature-0`, `${project}-feature-1`]);
});

test("the Project list, the Links and a Link's open check nothing with git between writes", async (t) => {
  const { project, other, runtime } = await fixture(t);
  assert.deepEqual(await gitDuring(() => runtime.invoke("project:registry")), []);
  // The first read looks for Links whose Worktree went away; another within seconds doesn't look again.
  await runtime.invoke("canvas:links");
  assert.deepEqual(await gitDuring(() => runtime.invoke("canvas:links")), []);
  const ids = Object.fromEntries((await runtime.invoke("project:registry")).map((entry) => [entry.path, entry.id]));
  const link = await runtime.invoke("link:create", [{ name: "Both", projectIds: [ids[project], ids[other]] }]);
  let opened;
  assert.deepEqual(
    await gitDuring(async () => {
      opened = await runtime.invoke("link:open", [link.id]);
    }),
    [],
  );
  assert.deepEqual(
    opened.projects.map((entry) => entry.path),
    [project, other],
  );
});

test("the @ menu finds nothing in a new Chats home: Milagre's own metadata is never a file to mention", async (t) => {
  const { runtime, chatsHome } = await fixture(t);
  const home = (await runtime.invoke("chats:ensure")).path;
  assert.equal(home, chatsHome);
  assert.deepEqual(await runtime.invoke("project:files", [home, ""]), []);
});

test("chats:ensure makes the Chats home without taking the shown Project from the window", async (t) => {
  const { project, runtime, chatsHome } = await fixture(t);
  assert.equal((await runtime.invoke("chats:ensure")).path, chatsHome);
  await settled();
  // Focus on the window still reads the Project it showed: picking another computer's No project made that
  // computer's home, but only its own window's switch moves what it shows.
  const focused = await gitDuring(() => runtime.focused(null));
  const folders = new Set(focused.map((call) => call.folder));
  assert.ok(folders.has(project), "the shown Project is read");
  assert.ok(![...folders].some((folder) => folder.startsWith(chatsHome)), "the Chats home is not");
});

test("with no Project, launch opens the Chats home an onboarding skip made, and nothing before it", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-skip-")));
  const make = () =>
    createRuntime({
      dataDir: path.join(dir, "profile"),
      cwd: "/",
      version: "9.8.7",
      environmentReady: Promise.resolve(),
      registryRoots: [],
      worktreeRoot: path.join(dir, "worktrees"),
      chatsHome: path.join(dir, "chats"),
    });
  const first = make();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await first.invoke("project:current"), null);
  await first.invoke("chats:ensure");
  await first.close();
  const second = make();
  try {
    const opened = await second.invoke("project:current");
    assert.equal(opened.path, path.join(dir, "chats"));
    assert.equal(opened.kind, "chats");
  } finally {
    await second.close();
  }
});
