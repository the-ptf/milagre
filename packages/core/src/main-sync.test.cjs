const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { syncMainBranch } = require("./main-sync.cjs");
const { createGit } = require("./git/client.cjs");

const ID = ["-c", "user.name=Milagre", "-c", "user.email=milagre@example.com"];
const gitIn =
  (dir) =>
  (...args) =>
    execFileSync("git", ["-C", dir, ...ID, ...args], { encoding: "utf8" }).trim();
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

// A clone whose main is one commit behind its remote. With `onWork`, the clone has another branch checked out.
async function fixture(t, { onWork = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-main-sync-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote");
  await fs.mkdir(remote);
  const remoteGit = gitIn(remote);
  remoteGit("init", "-q", "-b", "main");
  await fs.writeFile(path.join(remote, "README.md"), "shop\n");
  remoteGit("add", ".");
  remoteGit("commit", "-qm", "init");
  const project = path.join(root, "project");
  execFileSync("git", ["clone", "--quiet", remote, project]);
  const git = gitIn(project);
  if (onWork) git("switch", "-q", "-c", "work");
  await fs.writeFile(path.join(remote, "NEWS.md"), "shipped\n");
  remoteGit("add", ".");
  remoteGit("commit", "-qm", "ship");
  return { root, remote, project, git, behind: git("rev-parse", "main"), ahead: remoteGit("rev-parse", "main") };
}

test("main that isn't checked out anywhere fast-forwards without touching the checkout", async (t) => {
  const { project, git, ahead } = await fixture(t, { onWork: true });
  const result = await syncMainBranch(project, { now: () => 42 });
  assert.deepEqual(result, { at: 42, outcome: "updated", branch: "main", commit: ahead.slice(0, 7) });
  assert.equal(git("rev-parse", "main"), ahead);
  assert.equal(git("branch", "--show-current"), "work");
  assert.equal(await exists(path.join(project, "NEWS.md")), false);
});

test("a clean main checkout fast-forwards its files", async (t) => {
  const { project, git, ahead } = await fixture(t);
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "updated");
  assert.equal(git("rev-parse", "HEAD"), ahead);
  assert.equal(await fs.readFile(path.join(project, "NEWS.md"), "utf8"), "shipped\n");
});

test("a selected source branch with local commits is skipped", async (t) => {
  const { project, git, behind } = await fixture(t);
  git("switch", "-q", "-c", "release/v2", "--track", "origin/main");
  await fs.writeFile(path.join(project, "LOCAL.md"), "mine\n");
  git("add", ".");
  git("commit", "-qm", "local");
  const before = git("rev-parse", "release/v2");
  const result = await syncMainBranch(project, { branch: "release/v2" });
  assert.equal(result.outcome, "skipped");
  assert.equal(result.branch, "release/v2");
  assert.equal(git("rev-parse", "release/v2"), before);
  assert.equal(git("rev-parse", "main"), behind);
});

test("a source ref pattern cannot select another branch", async (t) => {
  const { project, git, behind } = await fixture(t);
  const result = await syncMainBranch(project, { branch: "*" });
  assert.equal(result.outcome, "skipped");
  assert.equal(git("rev-parse", "main"), behind);
});

test("a second sync reports up to date", async (t) => {
  const { project, ahead } = await fixture(t);
  await syncMainBranch(project);
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "up-to-date");
  assert.equal(result.commit, ahead.slice(0, 7));
});

test("main with commits of its own is skipped and left alone", async (t) => {
  const { project, git } = await fixture(t);
  await fs.writeFile(path.join(project, "LOCAL.md"), "mine\n");
  git("add", ".");
  git("commit", "-qm", "local");
  const before = git("rev-parse", "main");
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.match(result.message, /main has commits that aren't on origin/);
  assert.equal(git("rev-parse", "main"), before);
});

test("a main checkout with uncommitted changes is skipped", async (t) => {
  const { project, git, behind } = await fixture(t);
  await fs.writeFile(path.join(project, "README.md"), "edited\n");
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "The main checkout has uncommitted changes");
  assert.equal(git("rev-parse", "main"), behind);
  assert.equal(await fs.readFile(path.join(project, "README.md"), "utf8"), "edited\n");
});

test("a main checkout in the middle of a merge is skipped", async (t) => {
  const { project, git, behind } = await fixture(t);
  await fs.writeFile(path.join(project, ".git", "MERGE_HEAD"), `${behind}\n`);
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "The main checkout is in the middle of a merge");
  assert.equal(git("rev-parse", "main"), behind);
});

test("an unreachable remote fails without changing anything", async (t) => {
  const { project, remote, git, behind } = await fixture(t);
  await fs.rm(remote, { recursive: true, force: true });
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "failed");
  assert.equal(result.message, "Could not reach origin");
  assert.equal(git("rev-parse", "main"), behind);
});

test("main without an upstream is skipped", async (t) => {
  const { project, git } = await fixture(t);
  git("branch", "--unset-upstream", "main");
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "main has no remote branch");
});

test("an untracked file in the way is skipped with git's reason", async (t) => {
  const { project, git, behind } = await fixture(t);
  await fs.writeFile(path.join(project, "NEWS.md"), "my draft\n");
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.match(result.message, /would be overwritten/);
  assert.equal(git("rev-parse", "main"), behind);
  assert.equal(await fs.readFile(path.join(project, "NEWS.md"), "utf8"), "my draft\n");
});

test("main checked out in another worktree updates that worktree", async (t) => {
  const { root, project, git, ahead } = await fixture(t, { onWork: true });
  const other = path.join(root, "other");
  git("worktree", "add", "-q", other, "main");
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "updated");
  assert.equal(await fs.readFile(path.join(other, "NEWS.md"), "utf8"), "shipped\n");
  assert.equal(git("rev-parse", "main"), ahead);
});

test("a dirty other worktree is named in the skip message", async (t) => {
  const { root, project, git } = await fixture(t, { onWork: true });
  const other = path.join(root, "other");
  git("worktree", "add", "-q", other, "main");
  await fs.writeFile(path.join(other, "README.md"), "edited\n");
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "other has uncommitted changes on main");
});

test("a detached worktree named like main is not mistaken for its checkout", async (t) => {
  const { root, project, git, behind, ahead } = await fixture(t, { onWork: true });
  const decoy = path.join(root, "main");
  git("worktree", "add", "-q", "--detach", decoy, behind);
  await fs.writeFile(path.join(decoy, "README.md"), "edited\n");
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "updated");
  assert.equal(git("rev-parse", "main"), ahead);
});

test("a folder that isn't a repository resolves instead of throwing", async (t) => {
  const { root } = await fixture(t);
  const result = await syncMainBranch(root);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "No local main branch");
});

test("main in the middle of a rebase is left alone, and the rebase can still finish", async (t) => {
  const { project, git, behind } = await fixture(t);
  execFileSync("git", ["-C", project, ...ID, "rebase", "-i", "--root"], {
    env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i.bak -e s/^pick/edit/" },
    stdio: "ignore",
  });
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "main is in the middle of a rebase or bisect");
  assert.equal(git("rev-parse", "main"), behind);
  git("rebase", "--continue");
  assert.equal(git("branch", "--show-current"), "main");
});

test("a failed checkout lookup fails instead of moving main", async (t) => {
  const { project, git, behind } = await fixture(t, { onWork: true });
  const real = createGit();
  const out = (cwd, args) => (args.includes("--format=%(worktreepath)") ? Promise.resolve(null) : real.read.out(cwd, args));
  const client = { ...real, read: { ...real.read, out } };
  const result = await syncMainBranch(project, { client });
  assert.equal(result.outcome, "failed");
  assert.equal(git("rev-parse", "main"), behind);
});

// A client whose answers can be swapped for one git call, to reach states a real repository only passes through.
function clientWith({ out, run } = {}) {
  const real = createGit();
  return {
    ...real,
    read: { ...real.read, out: (cwd, args) => out?.(cwd, args) ?? real.read.out(cwd, args) },
    write: { ...real.write, run: (cwd, args, options) => run?.(cwd, args) ?? real.write.run(cwd, args, options) },
  };
}

test("a checkout that left main just before the merge is not fast-forwarded", async (t) => {
  const { project, git, behind } = await fixture(t, { onWork: true });
  const workBefore = git("rev-parse", "work");
  // The lookup still names the project as main's checkout, but its HEAD is on `work` by the time of the merge.
  const client = clientWith({ out: (_cwd, args) => (args.includes("--format=%(worktreepath)") ? Promise.resolve(project) : undefined) });
  const result = await syncMainBranch(project, { client });
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "The main checkout is no longer on main");
  assert.equal(git("rev-parse", "work"), workBefore);
  assert.equal(git("rev-parse", "main"), behind);
});

test("a rejected SSH key is reported as git says it, not as an unreachable remote", async (t) => {
  const { project } = await fixture(t);
  const message = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
  const client = clientWith({ run: (_cwd, args) => (args[0] === "fetch" ? Promise.resolve({ ok: false, message, stderr: message, stdout: "" }) : undefined) });
  const result = await syncMainBranch(project, { client });
  assert.equal(result.outcome, "failed");
  assert.equal(result.message, "git@github.com: Permission denied (publickey).");
});

test("a Project opened through a symlink still calls its checkout the main checkout", async (t) => {
  const { root, project } = await fixture(t);
  const link = path.join(root, "link");
  await fs.symlink(project, link);
  await fs.writeFile(path.join(project, "README.md"), "edited\n");
  const result = await syncMainBranch(link);
  assert.equal(result.message, "The main checkout has uncommitted changes");
});

test("a worktree that has main checked out but whose folder is gone is reported as missing", async (t) => {
  const { root, project, git, behind } = await fixture(t, { onWork: true });
  const other = path.join(root, "other");
  git("worktree", "add", "-q", other, "main");
  await fs.rm(other, { recursive: true, force: true });
  const result = await syncMainBranch(project);
  assert.equal(result.outcome, "skipped");
  assert.equal(result.message, "other is missing. Run git worktree prune to forget it");
  assert.equal(git("rev-parse", "main"), behind);
});
