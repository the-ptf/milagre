const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createGitDiff } = require("./git-diff.cjs");

async function fixture(t, { commit = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-gitdiff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "shop");
  await fs.mkdir(cwd);
  const git = (...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=Milagre", "-c", "user.email=milagre@example.com", ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  const write = (file, content) => fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }).then(() => fs.writeFile(path.join(cwd, file), content));
  if (commit) {
    await write("README.md", "one\ntwo\nthree\n");
    await write("old.txt", "keep\nme\nplease\nthanks\n");
    await write("gone.txt", "bye\n");
    git("add", ".");
    git("commit", "-m", "init");
  }
  return { cwd, git, write, diff: createGitDiff() };
}

const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file]));

test("uncommitted lists modified, added, deleted, renamed, untracked and binary files", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  await write("README.md", "one\nTWO\nthree\nfour\n");
  await write("added.txt", "a\nb\n");
  git("add", "added.txt");
  await fs.rm(path.join(cwd, "gone.txt"));
  git("mv", "old.txt", "new.txt");
  await write("scratch.txt", "x\ny\nz\n");
  await write("logo.png", Buffer.from([0, 1, 2, 3]));
  await write(".milagre/state.json", "{}\n");

  const result = await diff.listDiffFiles({ cwd, mode: "uncommitted" });
  assert.equal(result.isRepo, true);
  const files = byPath(result.files);
  assert.deepEqual(files["README.md"], { path: "README.md", status: "modified", added: 2, removed: 1, binary: false });
  assert.deepEqual(files["added.txt"], { path: "added.txt", status: "added", added: 2, removed: 0, binary: false });
  assert.deepEqual(files["gone.txt"], { path: "gone.txt", status: "deleted", added: 0, removed: 1, binary: false });
  assert.deepEqual(files["new.txt"], { path: "new.txt", oldPath: "old.txt", status: "renamed", added: 0, removed: 0, binary: false });
  assert.deepEqual(files["scratch.txt"], { path: "scratch.txt", status: "added", added: 3, removed: 0, binary: false, untracked: true });
  assert.deepEqual(files["logo.png"], { path: "logo.png", status: "added", added: 0, removed: 0, binary: true, untracked: true });
  assert.equal(files[".milagre/state.json"], undefined);
});

test("a binary tracked file is flagged from numstat", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  await write("logo.png", Buffer.from([0, 1, 2, 3]));
  git("add", "logo.png");
  const { files } = await diff.listDiffFiles({ cwd, mode: "uncommitted" });
  assert.deepEqual(byPath(files)["logo.png"], { path: "logo.png", status: "added", added: 0, removed: 0, binary: true });
  const patch = await diff.readDiffFile({ cwd, mode: "uncommitted", path: "logo.png" });
  assert.deepEqual(patch, { patch: "", binary: true, tooLarge: false });
});

test("readDiffFile returns the patch for modified, deleted, renamed and untracked files", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  await write("README.md", "one\nTWO\nthree\n");
  await fs.rm(path.join(cwd, "gone.txt"));
  git("mv", "old.txt", "new.txt");
  await write("new.txt", "keep\nme\nplease\nthanks!\n");
  await write("scratch.txt", "x\n");

  const modified = await diff.readDiffFile({ cwd, mode: "uncommitted", path: "README.md" });
  assert.match(modified.patch, /^diff --git a\/README.md b\/README.md/);
  assert.match(modified.patch, /-two\n\+TWO\n/);
  assert.equal(modified.binary, false);
  assert.match((await diff.readDiffFile({ cwd, mode: "uncommitted", path: "gone.txt" })).patch, /deleted file mode[\s\S]*-bye/);
  const renamed = await diff.readDiffFile({ cwd, mode: "uncommitted", path: "new.txt", oldPath: "old.txt" });
  assert.match(renamed.patch, /rename from old.txt\nrename to new.txt/);
  assert.match(renamed.patch, /-thanks\n\+thanks!/);
  const untracked = await diff.readDiffFile({ cwd, mode: "uncommitted", path: "scratch.txt", untracked: true });
  assert.match(untracked.patch, /new file mode[\s\S]*\+x\n/);
});

test("committed covers merge-base..HEAD only, not uncommitted edits", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  git("checkout", "-b", "feature");
  await write("README.md", "one\nTWO\nthree\n");
  git("commit", "-am", "edit");
  await write("README.md", "one\nTWO\nthree\nuncommitted\n");
  await write("scratch.txt", "x\n");

  const result = await diff.listDiffFiles({ cwd, base: "main", mode: "committed" });
  assert.equal(result.base, "main");
  assert.deepEqual(result.files, [{ path: "README.md", status: "modified", added: 1, removed: 1, binary: false }]);
  const patch = await diff.readDiffFile({ cwd, base: "main", mode: "committed", path: "README.md" });
  assert.match(patch.patch, /\+TWO/);
  assert.doesNotMatch(patch.patch, /uncommitted/);
});

test("committed diffs from the merge-base when the base has moved on", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  git("checkout", "-b", "feature");
  await write("feature.txt", "f\n");
  git("add", ".");
  git("commit", "-m", "feature");
  git("checkout", "main");
  await write("main-only.txt", "m\n");
  git("add", ".");
  git("commit", "-m", "main moves");
  git("checkout", "feature");
  const { files } = await diff.listDiffFiles({ cwd, base: "main", mode: "committed" });
  assert.deepEqual(
    files.map((file) => file.path),
    ["feature.txt"],
  );
});

test("committed with no base branch has an empty list and a null base", async (t) => {
  const { cwd, git, diff } = await fixture(t);
  git("branch", "-m", "trunk");
  assert.deepEqual(await diff.listDiffFiles({ cwd, mode: "committed" }), { isRepo: true, base: null, files: [] });
});

test("a repository with no commits lists its files against the empty tree", async (t) => {
  const { cwd, git, write, diff } = await fixture(t, { commit: false });
  await write("a.txt", "1\n2\n");
  await write("b.txt", "3\n");
  git("add", "a.txt");
  const result = await diff.listDiffFiles({ cwd, mode: "uncommitted" });
  assert.deepEqual(byPath(result.files)["a.txt"], { path: "a.txt", status: "added", added: 2, removed: 0, binary: false });
  assert.equal(byPath(result.files)["b.txt"].untracked, true);
  assert.match((await diff.readDiffFile({ cwd, mode: "uncommitted", path: "a.txt" })).patch, /\+1\n\+2/);
  assert.deepEqual(await diff.listDiffFiles({ cwd, mode: "committed" }), { isRepo: true, base: null, files: [] });
});

test("a folder that is not a repository says so", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-gitdiff-none-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await createGitDiff({ env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root) } }).listDiffFiles({
    cwd: root,
    mode: "uncommitted",
  });
  assert.equal(result.isRepo, false);
  assert.match(result.message, /git repository/);
});

test("a patch over 1 MB is tooLarge and comes back empty", async (t) => {
  const { cwd, write, diff } = await fixture(t);
  await write("big.txt", "line of text to fill the patch\n".repeat(50_000));
  const tracked = await diff.readDiffFile({ cwd, mode: "uncommitted", path: "big.txt", untracked: true });
  assert.deepEqual(tracked, { patch: "", binary: false, tooLarge: true });
});

test("readDiffFile rejects absolute paths and .. segments", async (t) => {
  const { cwd, diff } = await fixture(t);
  for (const bad of ["/etc/passwd", "../outside.txt", "a/../../b", "..", ""]) {
    await assert.rejects(diff.readDiffFile({ cwd, mode: "uncommitted", path: bad }), /inside the chat's folder/);
  }
  await assert.rejects(diff.readDiffFile({ cwd, mode: "uncommitted", path: "README.md", oldPath: "../x" }), /inside the chat's folder/);
  await assert.rejects(diff.readDiffFile({ cwd, mode: "uncommitted", path: "/etc/passwd", untracked: true }), /inside the chat's folder/);
});

test("a file name that looks like a pathspec or an option is read literally", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  await write("-n*.txt", "odd\n");
  git("add", "--", "-n*.txt");
  assert.match((await diff.readDiffFile({ cwd, mode: "uncommitted", path: "-n*.txt" })).patch, /\+odd/);
});

test("an untracked flag is not trusted: ignored files and symlinked folders read as empty", async (t) => {
  const { cwd, write, diff } = await fixture(t);
  const empty = { patch: "", binary: false, tooLarge: false };
  await write(".gitignore", ".env\n");
  await write(".env", "SECRET=1\n");
  assert.deepEqual(await diff.readDiffFile({ cwd, mode: "uncommitted", path: ".env", untracked: true }), empty);
  await write(".milagre/state.json", "{}\n");
  assert.deepEqual(await diff.readDiffFile({ cwd, mode: "uncommitted", path: ".milagre/state.json", untracked: true }), empty);

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-gitdiff-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret.txt"), "hidden\n");
  await fs.symlink(outside, path.join(cwd, "link"));
  assert.deepEqual(await diff.readDiffFile({ cwd, mode: "uncommitted", path: "link/secret.txt", untracked: true }), empty);
  assert.deepEqual(await diff.readDiffFile({ cwd, mode: "uncommitted", path: "missing.txt", untracked: true }), empty);
});

test("a base that starts with a dash is treated as not given", async (t) => {
  const { cwd, diff } = await fixture(t);
  const result = await diff.listDiffFiles({ cwd, base: "--output=/tmp/milagre-nope", mode: "committed" });
  assert.equal(result.base, "main");
  assert.deepEqual(result.files, []);
});

test("a copy entry is a plain added file with no oldPath", async (t) => {
  const { cwd } = await fixture(t);
  const real = require("node:child_process").execFile;
  const execFile = (cmd, args, options, callback) =>
    args.includes("--name-status") ? callback(null, "C100\0README.md\0copy.md\0", "") : real(cmd, args, options, callback);
  const { files } = await createGitDiff({ execFile }).listDiffFiles({ cwd, mode: "uncommitted" });
  const copy = files.find((file) => file.path === "copy.md");
  assert.equal(copy.status, "added");
  assert.equal("oldPath" in copy, false);
});

test("committed on a branch that shares no history with the base says so", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  git("checkout", "--orphan", "island");
  git("rm", "-rf", "-q", ".");
  await write("island.txt", "i\n");
  git("add", ".");
  git("commit", "-m", "island");
  assert.deepEqual(await diff.listDiffFiles({ cwd, base: "main", mode: "committed" }), {
    isRepo: true,
    base: "main",
    files: [],
    message: "This branch shares no history with main.",
  });
});

test("patch reads turn off textconv", async (t) => {
  const { cwd, write } = await fixture(t);
  await write("README.md", "one\nTWO\nthree\n");
  const real = require("node:child_process").execFile;
  const seen = [];
  const execFile = (cmd, args, options, callback) => {
    seen.push(args);
    return real(cmd, args, options, callback);
  };
  await createGitDiff({ execFile }).readDiffFile({ cwd, mode: "uncommitted", path: "README.md" });
  assert.ok(seen.some((args) => args.includes("diff") && args.includes("--no-textconv")));
});

test("comparison history excludes inherited commits with a chosen branch and includes author, full message and stats", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  git("checkout", "-b", "parent-feature");
  await write("parent.txt", "inherited\n");
  git("add", ".");
  git("commit", "-m", "Parent work");
  git("checkout", "-b", "current-feature");
  await write("current.txt", "one\ntwo\n");
  git("add", ".");
  git("commit", "-m", "Current work\n\nDetailed explanation", "--author=Maria <maria@example.com>");
  await write("scratch.txt", "uncommitted\n");
  const all = await diff.history({ cwd, base: "main" });
  assert.equal(all.commits.length, 2);
  const result = await diff.history({ cwd, base: "refs/heads/parent-feature" });
  assert.equal(result.branch, "current-feature");
  assert.equal(result.base, "parent-feature");
  assert.ok(result.branches.some((branch) => branch.ref === "refs/heads/parent-feature"));
  assert.equal(result.commits.length, 1);
  const [commit] = result.commits;
  assert.equal(commit.author, "Maria");
  assert.equal(commit.email, "maria@example.com");
  assert.equal(commit.message, "Current work\n\nDetailed explanation");
  assert.equal(commit.sha, git("rev-parse", "HEAD").trim());
  assert.ok(Number.isFinite(Date.parse(commit.date)));
  assert.equal(commit.files, 1);
  assert.equal(commit.added, 2);
  assert.equal(commit.removed, 0);
  assert.equal(result.hasMore, false);
  const limited = await diff.history({ cwd, base: "main", limit: 1 });
  assert.equal(limited.commits.length, 1);
  assert.equal(limited.hasMore, true);
  const metadata = await diff.history({ cwd, base: "main", limit: 0 });
  assert.deepEqual(metadata.commits, []);
  assert.equal(metadata.branch, "current-feature");
  const files = await diff.listDiffFiles({ cwd, base: "refs/heads/parent-feature", mode: "committed" });
  assert.deepEqual(
    files.files.map((file) => file.path),
    ["current.txt"],
  );
  assert.equal(git("branch", "--show-current").trim(), "current-feature");
});

test("history handles unborn, detached and unrelated branches", async (t) => {
  const { cwd, git, write, diff } = await fixture(t, { commit: false });
  assert.deepEqual((await diff.history({ cwd })).commits, []);
  await write("first.txt", "first\n");
  git("add", ".");
  git("commit", "-m", "first");
  git("checkout", "--detach");
  assert.equal((await diff.history({ cwd, base: "main" })).branch, null);
  git("checkout", "--orphan", "unrelated");
  git("commit", "-m", "unrelated");
  const result = await diff.history({ cwd, base: "main" });
  assert.match(result.message, /shares no history/);
  assert.deepEqual(result.commits, []);
});
