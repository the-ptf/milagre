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
  assert.equal(metadata.total, 2);
  assert.equal(metadata.head, commit.sha);
  assert.equal(metadata.automatic.name, "main");
  assert.equal(metadata.projectDefault.ref, "refs/heads/main");
  const recorded = await diff.history({ cwd, base: "main", recordedBase: "parent-feature", limit: 0 });
  assert.equal(recorded.automatic.name, "parent-feature");
  assert.equal(recorded.automatic.reason, "the recorded base");
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
  const detached = await diff.history({ cwd, base: "main", limit: 0 });
  assert.equal(detached.branch, null);
  assert.equal(detached.head, git("rev-parse", "HEAD").trim());
  git("checkout", "--orphan", "unrelated");
  git("commit", "-m", "unrelated");
  const result = await diff.history({ cwd, base: "main" });
  assert.match(result.message, /shares no history/);
  assert.deepEqual(result.commits, []);
  assert.match((await diff.history({ cwd, base: "main", limit: 0 })).message, /shares no history/);
});

test("history suggests the branch's creation source and resolves automatic independently of a manual selection", async (t) => {
  const { cwd, git, diff } = await fixture(t);
  git("checkout", "-b", "parent");
  git("checkout", "-b", "feature", "parent");
  const metadata = await diff.history({ cwd, base: "main", limit: 0 });
  assert.equal(metadata.suggested, "refs/heads/parent");
  assert.equal(metadata.automatic.name, "parent");
  assert.equal(metadata.automatic.reason, "the branch it was created from");
  git("branch", "-D", "parent");
  const after = await diff.history({ cwd, base: "refs/heads/parent", limit: 0 });
  assert.equal(after.suggested, null);
  assert.equal(after.automatic.name, "main");
});

test("history counts merge changes against the first parent without Git 2.31 options", async (t) => {
  const { cwd, git, write } = await fixture(t);
  git("checkout", "-b", "feature");
  await write("first.txt", "first\n");
  git("add", ".");
  git("commit", "-m", "First change");
  git("checkout", "-b", "side");
  await write("side.txt", "one\ntwo\n");
  git("add", ".");
  git("commit", "-m", "Side change");
  git("checkout", "feature");
  await write("own.txt", "own\n");
  git("add", ".");
  git("commit", "-m", "Own change");
  git("merge", "--no-ff", "side", "-m", "Merge side");
  const real = require("node:child_process").execFile;
  const diff = createGitDiff({
    execFile(command, args, options, callback) {
      if (args.some((arg) => arg.startsWith("--diff-merges"))) {
        callback(Object.assign(new Error("unsupported Git option"), { code: 129 }), "", "unsupported Git option");
        return;
      }
      return real(command, args, options, callback);
    },
  });
  const result = await diff.history({ cwd, base: "main" });
  assert.equal(result.commits.length, 4);
  const merge = result.commits.find((commit) => commit.message === "Merge side");
  assert.equal(merge.files, 1);
  assert.equal(merge.added, 2);
  assert.equal(merge.removed, 0);
  assert.equal("parent" in merge, false);
});

test("history caches catalogue/reflog reads, omits unchanged branches and checks a deleted base live", async (t) => {
  const { cwd, git } = await fixture(t);
  git("checkout", "-b", "feature", "main");
  git("branch", "parent");
  const head = git("rev-parse", "HEAD").trim();
  execFileSync("git", ["-C", cwd, "update-ref", "--stdin"], {
    input: Array.from({ length: 1200 }, (_, index) => `create refs/remotes/origin/topic-${index} ${head}\n`).join(""),
    encoding: "utf8",
  });
  const real = require("node:child_process").execFile;
  let clock = 0,
    lists = 0,
    reflogs = 0;
  const diff = createGitDiff({
    now: () => clock,
    execFile(command, args, options, callback) {
      if (args.includes("--format=%(refname)")) lists++;
      if (args.includes("--walk-reflogs")) reflogs++;
      return real(command, args, options, callback);
    },
  });
  const [first] = await Promise.all([diff.history({ cwd, limit: 0 }), diff.history({ cwd, limit: 0 })]);
  assert.equal(lists, 1);
  assert.equal(reflogs, 1);
  assert.ok(first.branches.some((branch) => branch.name === "parent"));
  const same = await diff.history({ cwd, limit: 0, branchesVersion: first.branchesVersion });
  assert.equal(same.branches, undefined);
  assert.equal(same.branchesVersion, first.branchesVersion);
  assert.ok(first.branches.length > 1200);
  t.diagnostic(`Catalogue payload: ${Buffer.byteLength(JSON.stringify(first))} bytes cold, ${Buffer.byteLength(JSON.stringify(same))} bytes warm.`);
  assert.ok(JSON.stringify(first).length > JSON.stringify(same).length * 20, "warm phone polls do not resend thousands of choices");
  assert.equal(lists, 1);
  assert.equal(reflogs, 1);
  git("branch", "-D", "parent");
  git("branch", "added-after-poll");
  const deleted = await diff.history({ cwd, base: "refs/heads/parent", limit: 0, branchesVersion: first.branchesVersion });
  assert.equal(deleted.baseMissing, true, "deletion recovery never waits for catalogue expiry");
  assert.equal(deleted.branches, undefined);
  clock += 31000;
  const updated = await diff.history({ cwd, limit: 0, branchesVersion: first.branchesVersion });
  assert.notEqual(updated.branchesVersion, first.branchesVersion);
  assert.ok(updated.branches.some((branch) => branch.name === "added-after-poll"));
  assert.equal(
    updated.branches.some((branch) => branch.name === "parent"),
    false,
  );
  assert.equal(lists, 2);
  assert.equal(reflogs, 2);
  git("checkout", "main");
  await diff.history({ cwd, limit: 0 });
  assert.equal(reflogs, 3, "checkout invalidates the cached creation source immediately");
  const other = await fixture(t);
  await diff.history({ cwd: other.cwd, limit: 0 });
  assert.equal(lists, 4, "folders never share catalogues");
});

for (const [reason, failure] of [
  ["timeout", { killed: true }],
  ["tooLarge", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
]) {
  test(`history retains every commit when numstat hits ${reason}, then retries after backoff`, async (t) => {
    const { cwd, git, write } = await fixture(t);
    git("checkout", "-b", "feature");
    await write("large.txt", "large\n");
    git("add", ".");
    git("commit", "-m", "Large commit with body\n\nExplanation");
    const large = git("rev-parse", "HEAD").trim();
    await write("small.txt", "small\n");
    git("add", ".");
    git("commit", "-m", "Small commit");
    const real = require("node:child_process").execFile;
    let clock = 0,
      attempts = 0,
      limited = true;
    const diff = createGitDiff({
      now: () => clock,
      execFile(command, args, options, callback) {
        if (args.includes("--numstat") && args[args.indexOf("--") - 1] === large) {
          attempts++;
          if (limited) {
            callback(Object.assign(new Error("read limit"), failure), "1\t0\tpartial.txt\0", "");
            return;
          }
        }
        return real(command, args, options, callback);
      },
    });
    const first = await diff.history({ cwd, base: "main" });
    assert.equal(first.commits.length, 2);
    const row = first.commits.find((commit) => commit.sha === large);
    assert.equal(row.statsUnavailable, reason);
    assert.equal(row.files, null);
    assert.equal(row.added, null);
    assert.equal(row.removed, null);
    assert.equal(row.message, "Large commit with body\n\nExplanation");
    assert.equal(row.author, "Milagre");
    assert.equal(first.commits[0].files, 1);
    await diff.history({ cwd, base: "main" });
    assert.equal(attempts, 1, "repeated polls do not repeat an expensive failed read");
    limited = false;
    clock += 31000;
    const retried = (await diff.history({ cwd, base: "main" })).commits.find((commit) => commit.sha === large);
    assert.equal(attempts, 2);
    assert.equal(retried.files, 1);
    assert.equal(retried.added, 1);
    assert.equal(retried.statsUnavailable, undefined);
  });
}

test("commit inspection is immutable, keeps renames/binaries/deletions, and excludes later or local changes", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  git("mv", "old.txt", "renamed.txt");
  await fs.rm(path.join(cwd, "gone.txt"));
  await write("README.md", "one\ncommit version\nthree\n");
  await write("logo.png", Buffer.from([0, 1, 2]));
  git("add", ".");
  git("commit", "-m", "selected");
  const commit = git("rev-parse", "HEAD").trim();
  await write("README.md", "later commit\n");
  await write("later.txt", "later\n");
  git("add", ".");
  git("commit", "-m", "later");
  await write("README.md", "uncommitted\n");
  await write("local.txt", "untracked\n");
  const result = await diff.listDiffFiles({ cwd, mode: "committed", commit });
  assert.equal(result.commit, commit);
  const files = byPath(result.files);
  assert.deepEqual(Object.keys(files).sort(), ["README.md", "gone.txt", "logo.png", "renamed.txt"]);
  assert.equal(files["gone.txt"].status, "deleted");
  assert.equal(files["logo.png"].binary, true);
  assert.equal(files["renamed.txt"].oldPath, "old.txt");
  const patch = await diff.readDiffFile({ cwd, mode: "committed", commit, path: "README.md" });
  assert.match(patch.patch, /\+commit version/);
  assert.doesNotMatch(patch.patch, /later commit|uncommitted/);
  const renamed = await diff.readDiffFile({ cwd, mode: "committed", commit, path: "renamed.txt", oldPath: "old.txt" });
  assert.match(renamed.patch, /rename from old.txt/);
});

test("commit inspection supports the root commit and compares merges to their first parent", async (t) => {
  const { cwd, git, write, diff } = await fixture(t);
  const root = git("rev-parse", "HEAD").trim();
  const initial = await diff.listDiffFiles({ cwd, mode: "committed", commit: root });
  assert.equal(initial.files.length, 3);
  assert.equal(initial.commitParent, null);
  assert.ok(initial.files.every((file) => file.status === "added"));
  const patch = await diff.readDiffFile({ cwd, mode: "committed", commit: root, path: "README.md" });
  assert.match(patch.patch, /\+one/);
  git("checkout", "-b", "side");
  await write("side.txt", "side\n");
  git("add", ".");
  git("commit", "-m", "side");
  git("checkout", "main");
  await write("main.txt", "main\n");
  git("add", ".");
  git("commit", "-m", "main");
  git("merge", "--no-ff", "side", "-m", "merge");
  const commit = git("rev-parse", "HEAD").trim();
  const merged = await diff.listDiffFiles({ cwd, mode: "committed", commit });
  assert.equal(merged.commitParent, git("rev-parse", "HEAD^1").trim());
  assert.deepEqual(
    merged.files.map((file) => file.path),
    ["side.txt"],
  );
});

test("commit inspection rejects refs, options, nonexistent commits and the uncommitted mode", async (t) => {
  const { cwd, git, diff } = await fixture(t);
  for (const commit of ["HEAD", "--output=/tmp/unsafe", "a".repeat(8), "f".repeat(40)]) {
    await assert.rejects(diff.listDiffFiles({ cwd, mode: "committed", commit }));
    await assert.rejects(diff.readDiffFile({ cwd, mode: "committed", commit, path: "README.md" }));
  }
  await assert.rejects(diff.listDiffFiles({ cwd, mode: "uncommitted", commit: git("rev-parse", "HEAD").trim() }));
});

test("null commit behaves like an omitted commit for lists, tracked patches, and untracked patches", async (t) => {
  const { cwd, write, diff } = await fixture(t);
  await write("README.md", "changed\n");
  await write("new.txt", "untracked\n");
  for (const mode of ["uncommitted", "committed"]) {
    const request = { cwd, base: "main", mode };
    assert.deepEqual(await diff.listDiffFiles({ ...request, commit: null }), await diff.listDiffFiles(request));
    assert.deepEqual(await diff.readDiffFile({ ...request, path: "README.md", commit: null }), await diff.readDiffFile({ ...request, path: "README.md" }));
  }
  const request = { cwd, mode: "uncommitted", path: "new.txt", untracked: true };
  assert.deepEqual(await diff.readDiffFile({ ...request, commit: null }), await diff.readDiffFile(request));
  assert.match((await diff.readDiffFile({ ...request, commit: null })).patch, /\+untracked/);
});

test("lists report truncation only when files were omitted, including untracked files", async (t) => {
  const { cwd, git } = await fixture(t);
  const commit = git("rev-parse", "HEAD").trim();
  const real = require("node:child_process").execFile;
  for (const size of [1000, 1001]) {
    const names = Array.from({ length: size }, (_, index) => `file-${index}.txt`);
    const diff = createGitDiff({
      execFile: (cmd, args, options, callback) => {
        if (args.includes("--name-status")) return callback(null, names.map((name) => `A\0${name}\0`).join(""), "");
        if (args.includes("--numstat")) return callback(null, names.map((name) => `1\t0\t${name}\0`).join(""), "");
        return real(cmd, args, options, callback);
      },
    });
    const listed = await diff.listDiffFiles({ cwd, mode: "committed", commit });
    assert.equal(listed.files.length, 1000);
    assert.equal(!!listed.truncated, size > 1000);
  }
  const untracked = createGitDiff({
    execFile: (cmd, args, options, callback) => {
      if (args.includes("--name-status")) return callback(null, Array.from({ length: 1000 }, (_, index) => `A\0file-${index}.txt\0`).join(""), "");
      if (args.includes("--numstat")) return callback(null, "", "");
      if (args.includes("ls-files")) return callback(null, "extra.txt\0", "");
      return real(cmd, args, options, callback);
    },
  });
  assert.equal((await untracked.listDiffFiles({ cwd, mode: "uncommitted" })).truncated, true);
});

test("file list Git errors and timeouts reject instead of appearing as an empty comparison", async (t) => {
  const { cwd } = await fixture(t);
  const real = require("node:child_process").execFile;
  for (const field of ["--name-status", "--numstat"]) {
    for (const failure of [Object.assign(new Error("Git failed"), { code: 128 }), Object.assign(new Error("Read timed out"), { killed: true })]) {
      const diff = createGitDiff({
        execFile: (cmd, args, options, callback) => (args.includes(field) ? callback(failure, "", failure.message) : real(cmd, args, options, callback)),
      });
      await assert.rejects(diff.listDiffFiles({ cwd, mode: "uncommitted" }), new RegExp(failure.message));
    }
  }
});
