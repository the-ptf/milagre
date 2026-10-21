const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { agentFolders } = require("./agent-folders.cjs");

async function session(file, cwd, at) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ type: "queue-operation" })}\n${JSON.stringify({ type: "user", cwd })}\n`);
  await fs.utimes(file, at, at);
}

test("onboarding lists the folders agent sessions ran in, newest first, as the Projects they open as", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-agent-folders-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const [web, notes, gone] = ["web", "notes", "gone"].map((name) => path.join(home, "Code", name));
  await fs.mkdir(web, { recursive: true });
  await fs.mkdir(notes, { recursive: true });
  execFileSync("git", ["init", "-b", "main", web], { stdio: "ignore" });
  execFileSync("git", ["-C", web, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "start"], { stdio: "ignore" });
  const side = path.join(home, ".milagre", "worktrees", "web-side");
  execFileSync("git", ["-C", web, "worktree", "add", "-b", "side", side], { stdio: "ignore" });
  const claude = path.join(home, ".claude");
  const codex = path.join(home, ".codex");
  await session(path.join(claude, "projects", "-web", "a.jsonl"), web, new Date("2026-10-18T10:00:00Z"));
  // A Milagre Worktree lists as its repository, once, at its newest use.
  await session(path.join(claude, "projects", "-web-side", "b.jsonl"), side, new Date("2026-10-20T10:00:00Z"));
  await session(path.join(codex, "sessions", "2026", "10", "19", "rollout-1.jsonl"), notes, new Date("2026-10-19T10:00:00Z"));
  // A folder that no longer exists and the home folder itself are left out.
  await session(path.join(codex, "sessions", "2026", "10", "20", "rollout-2.jsonl"), gone, new Date("2026-10-20T11:00:00Z"));
  await session(path.join(claude, "projects", "-home", "c.jsonl"), home, new Date("2026-10-20T12:00:00Z"));

  const folders = await agentFolders({ homeDir: home, claudeHome: claude, codexHome: codex, ignore: [] });
  assert.deepEqual(
    folders.map(({ path: folder, provider, git }) => [folder, provider, git]),
    [
      [web, "claude", true],
      [notes, "codex", false],
    ],
  );
  assert.equal(folders[0].lastUsed, "2026-10-20T10:00:00.000Z");
  assert.deepEqual(await agentFolders({ homeDir: home, claudeHome: path.join(base, "none"), codexHome: path.join(base, "none") }), []);
});

test("onboarding makes a new folder with Git, sets Git up in a plain folder, and refuses bad names and addresses", async (t) => {
  const { createOnboardingProjects } = require("./onboarding-projects.cjs");
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-onboarding-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const projects = createOnboardingProjects({ root: path.join(base, "Code") });
  const made = await projects.create("hello");
  assert.equal(made.path, path.join(base, "Code", "hello"));
  await fs.access(path.join(made.path, ".git"));
  await assert.rejects(projects.create("hello"), /already exists/);
  for (const name of ["", "a/b", "..", ".hidden"]) await assert.rejects(projects.create(name), /folder name/, name);
  await assert.rejects(projects.clone("file:///etc"), /https:\/\/ or git@/);
  const notes = path.join(base, "notes");
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, "todo.md"), "- milk\n");
  assert.equal((await projects.initGit(notes)).path, notes);
  await fs.access(path.join(notes, ".git"));
  await assert.rejects(projects.initGit(notes), /already has Git/);
});
