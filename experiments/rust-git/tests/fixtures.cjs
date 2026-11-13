// Node is the oracle. Every mutation here targets a newly-created disposable repo.
// No production repo, remote fetch/push, network command or global config write.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createGitDiff } = require("../../../packages/core/src/git-diff.cjs");
const { createGitActions } = require("../../../packages/core/src/git-actions.cjs");
const root = process.argv[2];
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith("milagre-rust-git-")) throw new Error("Disposable fixture root required");
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
};
const git = (cwd, ...args) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Milagre", "-c", "user.email=milagre@example.com", ...args],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const write = (cwd, file, value) => {
  const dest = path.join(cwd, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, value);
};
const commit = (cwd, message = "Saved work") => {
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};
const roots = [],
  cases = [];
function repo(name, born = true) {
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd);
  roots.push(cwd);
  git(cwd, "init", "-b", "main");
  // Read behavior does not depend on the host's user preferences.
  git(cwd, "config", "core.quotePath", "true");
  git(cwd, "config", "core.autocrlf", "false");
  git(cwd, "config", "diff.algorithm", "myers");
  if (born) {
    write(cwd, "README.md", "one\ntwo\nthree\n");
    write(cwd, "old.txt", "keep\nme\nplease\nthanks\n");
    write(cwd, "gone.txt", "bye\n");
    commit(cwd, "Initial");
  }
  return cwd;
}
async function record(name, cwd, method, args = {}, oracle) {
  const request = { cwd, ...args };
  const diff = oracle || createGitDiff({ env });
  let expected;
  try {
    if (method === "git:changes") {
      // A nonexistent executable is intentional: fixture reads never call GitHub.
      expected = await createGitActions({ env, gh: "/nonexistent/milagre-fixture-gh" }).readChanges(request);
      if (expected.hasOrigin && expected.branch && !expected.onBase) {
        expected.ghMessage = "GitHub PR lookup is not available in the read-only Rust Git adapter.";
        delete expected.ghCode; // Deliberate unported adapter, not a missing installed gh binary.
      }
    } else expected = await diff[{ "git:diff-files": "listDiffFiles", "git:diff-file": "readDiffFile", "git:history": "history" }[method]](request);
    cases.push({ name, method, args: request, expected });
    return expected;
  } catch (error) {
    cases.push({ name, method, args: request, error: error.message });
  }
}
async function main() {
  const dirty = repo("dirty files");
  write(dirty, "README.md", "one\nTWO\nthree\nfour\n");
  fs.unlinkSync(path.join(dirty, "gone.txt"));
  git(dirty, "mv", "old.txt", "renamed é\nwith space.txt");
  write(dirty, "renamed é\nwith space.txt", "keep\nme\nplease\nthanks!\n");
  for (const file of ["space file.txt", "newline\nfile.txt", "é漢😀.txt", "-n*.txt", ":literal.txt"]) {
    write(dirty, file, `${file}\nsecond\n`);
    git(dirty, "add", "--", `:(literal)${file}`);
  }
  write(dirty, "staged binary.bin", Buffer.from([0, 1, 2]));
  git(dirty, "add", "staged binary.bin");
  write(dirty, "scratch\nµ.txt", "new\nlines\n");
  write(dirty, "untracked.bin", Buffer.from([0, 1, 3]));
  write(dirty, ".milagre/state.json", "{}\n");
  write(dirty, ".env.local", "do-not-read-this\n");
  write(dirty, ".env.example", "example\n");
  await record("dirty list", dirty, "git:diff-files", { mode: "uncommitted" });
  await record("dirty changes and secrets", dirty, "git:changes");
  for (const [file, extra] of [
    ["README.md", {}],
    ["gone.txt", {}],
    ["renamed é\nwith space.txt", { oldPath: "old.txt" }],
    ["-n*.txt", {}],
    [":literal.txt", {}],
    ["newline\nfile.txt", {}],
    ["é漢😀.txt", {}],
    ["staged binary.bin", {}],
    ["scratch\nµ.txt", { untracked: true }],
    ["untracked.bin", { untracked: true }],
  ])
    await record(`patch ${file}`, dirty, "git:diff-file", { mode: "uncommitted", path: file, ...extra });
  await record("null commit list", dirty, "git:diff-files", { mode: "uncommitted", commit: null });
  for (const file of ["../outside", "/etc/passwd", "a/../../b", "", "x\0y", "a\\..\\b"])
    await record(`invalid path ${JSON.stringify(file)}`, dirty, "git:diff-file", { path: file });
  await record("invalid old path", dirty, "git:diff-file", { path: "README.md", oldPath: "../outside" });
  await record("option base", dirty, "git:diff-files", { mode: "committed", base: "--output=/tmp/milagre-should-not-exist" });
  await record("internal range not admitted", dirty, "git:diff-files", { mode: "range" });

  const blocked = repo("ignored and symlinks");
  write(blocked, ".gitignore", ".env\n");
  write(blocked, ".env", "hidden\n");
  write(blocked, ".milagre/state.json", "{}\n");
  const outside = path.join(root, "not admitted");
  fs.mkdirSync(outside);
  write(outside, "secret.txt", "outside\n");
  fs.symlinkSync(outside, path.join(blocked, "link"));
  for (const file of [".env", ".milagre/state.json", "link/secret.txt", "missing.txt"])
    await record(`untracked guard ${file}`, blocked, "git:diff-file", { mode: "uncommitted", path: file, untracked: true });

  const unborn = repo("unborn", false);
  write(unborn, "a.txt", "1\n2\n");
  git(unborn, "add", "a.txt");
  write(unborn, "b.txt", "3\n");
  for (const method of ["git:changes", "git:history", "git:diff-files"]) await record(`unborn ${method}`, unborn, method, { mode: "uncommitted" });
  await record("unborn committed", unborn, "git:diff-files", { mode: "committed" });
  await record("unborn patch", unborn, "git:diff-file", { path: "a.txt" });

  const stack = repo("stack");
  const initial = git(stack, "rev-parse", "HEAD");
  git(stack, "checkout", "-b", "parent-feature");
  write(stack, "parent.txt", "inherited\n");
  commit(stack, "Parent work");
  git(stack, "checkout", "-b", "feature", "parent-feature");
  write(stack, "current.txt", "one\ntwo\n");
  const selected = commit(stack, "Current work\n\nDetailed explanation");
  git(stack, "mv", "old.txt", "renamed.txt");
  fs.unlinkSync(path.join(stack, "gone.txt"));
  write(stack, "logo.png", Buffer.from([0, 1, 2]));
  const inspection = commit(stack, "Rename and binary");
  write(stack, "current.txt", "later\n");
  commit(stack, "Later change");
  write(stack, "current.txt", "uncommitted\n");
  write(stack, "local.txt", "local\n");
  for (const base of [undefined, "main", "refs/heads/parent-feature", "missing", "--bad"])
    for (const limit of [0, 1, 30]) await record(`history ${base} ${limit}`, stack, "git:history", { base, limit });
  await record("recorded source independent", stack, "git:history", { base: "main", recordedBase: "parent-feature", limit: 0 });
  const unicodeMessage = repo("unicode message trim");
  git(unicodeMessage, "checkout", "-b", "feature");
  write(unicodeMessage, "new.txt", "new\n");
  commit(unicodeMessage, "\ufeffMessage\n\nBody\u0085");
  await record("history uses JavaScript message trim", unicodeMessage, "git:history", { base: "main" });
  const oracle = createGitDiff({ env });
  const cold = await record("catalog cold", stack, "git:history", { limit: 0 }, oracle);
  await record("catalog warm omission", stack, "git:history", { limit: 0, branchesVersion: cold.branchesVersion }, oracle);
  await record("committed excludes local", stack, "git:diff-files", { mode: "committed", base: "main" });
  for (const selectedCommit of [initial, selected, inspection]) {
    await record(`immutable list ${selectedCommit}`, stack, "git:diff-files", { mode: "committed", commit: selectedCommit });
    await record(`immutable patch ${selectedCommit}`, stack, "git:diff-file", { mode: "committed", commit: selectedCommit, path: "current.txt" });
  }
  for (const invalidCommit of ["HEAD", "--output=/tmp/unsafe", "a".repeat(8), "f".repeat(40)])
    await record(`bad commit ${invalidCommit}`, stack, "git:diff-files", { mode: "committed", commit: invalidCommit });
  await record("bad mode with commit", stack, "git:diff-files", { mode: "uncommitted", commit: initial });

  const merge = repo("merge");
  git(merge, "checkout", "-b", "feature");
  write(merge, "first.txt", "first\n");
  commit(merge, "First change");
  git(merge, "checkout", "-b", "side");
  write(merge, "side.txt", "one\ntwo\n");
  commit(merge, "Side change");
  git(merge, "checkout", "feature");
  write(merge, "own.txt", "own\n");
  commit(merge, "Own change");
  git(merge, "merge", "--no-ff", "side", "-m", "Merge side");
  await record("merge history first parent", merge, "git:history", { base: "main" });
  await record("merge inspection first parent", merge, "git:diff-files", { mode: "committed", commit: git(merge, "rev-parse", "HEAD") });

  const detached = repo("detached");
  git(detached, "checkout", "--detach");
  await record("detached history", detached, "git:history");
  await record("detached changes", detached, "git:changes");
  const unrelated = repo("unrelated");
  git(unrelated, "checkout", "--orphan", "island");
  commit(unrelated, "Island");
  await record("unrelated diff", unrelated, "git:diff-files", { mode: "committed", base: "main" });
  await record("unrelated history", unrelated, "git:history", { base: "main" });
  const trunk = repo("no comparison branch");
  git(trunk, "branch", "-m", "trunk");
  await record("no base history", trunk, "git:history");
  await record("no base committed", trunk, "git:diff-files", { mode: "committed" });

  const remote = repo("symbolic remote refs");
  const before = git(remote, "rev-parse", "HEAD");
  git(remote, "remote", "add", "origin", path.join(root, "nonexistent-remote"));
  write(remote, "remote.txt", "ahead\n");
  const after = commit(remote, "Remote ahead");
  git(remote, "update-ref", "refs/remotes/origin/trunk", after);
  git(remote, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  git(remote, "branch", "local-base", before);
  git(remote, "config", "branch.local-base.remote", "origin");
  git(remote, "config", "branch.local-base.merge", "refs/heads/trunk");
  git(remote, "checkout", "-b", "feature", "local-base");
  write(remote, "feature.txt", "feature\n");
  commit(remote, "Local feature");
  const worktree = path.join(root, "linked Worktree\nµ");
  git(remote, "worktree", "add", "-b", "linked", worktree, "main");
  roots.push(worktree);
  write(worktree, "linked.txt", "worktree\n");
  await record("symbolic remote default", remote, "git:history", { limit: 0 });
  await record("lagging local prefers upstream", remote, "git:history", { base: "local-base" });
  await record("origin status without network", remote, "git:changes", { base: "local-base" });
  await record("linked worktree list", worktree, "git:diff-files", { mode: "uncommitted" });
  await record("linked worktree status", worktree, "git:changes");

  for (const divergent of [false, true]) {
    const cwd = repo(divergent ? "diverged base" : "local base ahead");
    const base = git(cwd, "rev-parse", "HEAD");
    git(cwd, "checkout", "-b", "remote-side");
    write(cwd, "remote.txt", "remote\n");
    const remoteTip = commit(cwd, "Remote side");
    git(cwd, "checkout", "main");
    write(cwd, "local.txt", "local\n");
    commit(cwd, "Local side");
    git(cwd, "update-ref", "refs/remotes/origin/main", divergent ? remoteTip : base);
    git(cwd, "checkout", "-b", "feature", "main");
    write(cwd, "feature.txt", "feature\n");
    commit(cwd, "Feature");
    await record(divergent ? "diverged local prefers remote" : "local ahead keeps base", cwd, "git:history", { base: "main" });
  }
  const ownRemote = repo("own remote source");
  git(ownRemote, "update-ref", "refs/remotes/origin/topic", git(ownRemote, "rev-parse", "HEAD"));
  git(ownRemote, "checkout", "-b", "topic", "origin/topic");
  await record("own remote is not a creation base", ownRemote, "git:history", { limit: 0 });

  const paged = repo("history pagination");
  const tree = git(paged, "rev-parse", "HEAD^{tree}");
  git(paged, "checkout", "-b", "feature");
  let tip = git(paged, "rev-parse", "HEAD");
  for (let i = 0; i < 301; i++) tip = git(paged, "commit-tree", tree, "-p", tip, "-m", `Empty commit ${i}`);
  git(paged, "update-ref", "refs/heads/feature", tip);
  await record("history caps at 300", paged, "git:history", { base: "main", limit: 10000 });
  await record("history clamps negative", paged, "git:history", { base: "main", limit: -3 });
  await record("history noninteger defaults 30", paged, "git:history", { base: "main", limit: 1.5 });

  const conflicts = repo("conflicts");
  git(conflicts, "checkout", "-b", "side");
  write(conflicts, "README.md", "side\n");
  commit(conflicts, "Side");
  git(conflicts, "checkout", "main");
  write(conflicts, "README.md", "main\n");
  commit(conflicts, "Main");
  try {
    git(conflicts, "merge", "side");
  } catch {
    /* expected conflict */
  }
  await record("unresolved merge", conflicts, "git:changes");
  await record("unresolved diff list", conflicts, "git:diff-files", { mode: "uncommitted" });
  const orphanConflicts = repo("unmerged without operation");
  fs.copyFileSync(path.join(conflicts, ".git/index"), path.join(orphanConflicts, ".git/index"));
  // Object IDs refer to another disposable repository; provide those objects locally without a fetch.
  fs.writeFileSync(path.join(orphanConflicts, ".git/objects/info/alternates"), `${path.join(conflicts, ".git/objects")}\n`);
  await record("unresolved index only", orphanConflicts, "git:changes");
  for (const [file, op] of [
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
  ]) {
    const cwd = repo(`operation ${file}`);
    if (file.startsWith("rebase")) fs.mkdirSync(path.join(cwd, ".git", file));
    else write(cwd, `.git/${file}`, git(cwd, "rev-parse", "HEAD"));
    await record(`blocked ${op} ${file}`, cwd, "git:changes");
  }

  const huge = repo("large patch");
  write(huge, "large.txt", "line to fill the patch\n".repeat(60000));
  await record("large patch UTF16 cap", huge, "git:diff-file", { path: "large.txt", mode: "uncommitted", untracked: true });
  const unicodePatch = repo("UTF16 patch size");
  write(unicodePatch, "unicode.txt", "😀".repeat(400000) + "\n");
  await record("patch cap counts UTF16 not UTF8", unicodePatch, "git:diff-file", { path: "unicode.txt", mode: "uncommitted", untracked: true });
  const many = repo("file list limit");
  for (let i = 0; i < 1001; i++) write(many, `file-${i}.txt`, "a\n");
  git(many, "add", ".");
  write(many, "untracked.txt", "x\n");
  await record("1000 file list cap", many, "git:diff-files", { mode: "uncommitted" });
  await record("300 status cap", many, "git:changes");

  const helpers = repo("repository helpers");
  const helper = path.join(helpers, ".git/helper.sh"),
    marker = path.join(helpers, ".git/helper-ran");
  fs.writeFileSync(helper, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
  fs.chmodSync(helper, 0o700);
  write(helpers, ".gitattributes", "*.txt diff=trap filter=trap\n");
  write(helpers, "old.txt", "changed\n");
  for (const name of ["core.fsmonitor", "diff.external", "diff.trap.textconv", "filter.trap.clean", "filter.trap.smudge", "filter.trap.process"])
    git(helpers, "config", name, `sh '${helper}'`);
  git(helpers, "config", "filter.trap.required", "true");
  const hardened = createGitDiff({ env, analysisOnly: true });
  await record("configured helpers suppressed list", helpers, "git:diff-files", { mode: "uncommitted" }, hardened);
  await record("configured helpers suppressed patch", helpers, "git:diff-file", { path: "old.txt", mode: "uncommitted" }, hardened);
  if (fs.existsSync(marker)) throw new Error("The Node analysis-only oracle executed a helper");

  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  roots.push(plain);
  for (const method of ["git:changes", "git:diff-files", "git:history"]) await record(`not a repo ${method}`, plain, method);
  const inner = path.join(dirty, "inner");
  fs.mkdirSync(inner);
  roots.push(inner);
  await record("not top", inner, "git:changes");
  const alias = path.join(root, "root alias");
  fs.symlinkSync(stack, alias);
  await record("canonical alias", alias, "git:history", { limit: 0 });
  process.stdout.write(JSON.stringify({ roots, cases, outside, alias, helperMarker: marker, helpers }));
}
main().catch((error) => {
  process.stderr.write(error.stack);
  process.exitCode = 1;
});
