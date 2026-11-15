#!/usr/bin/env node
// lefthook pre-push: runs the macOS desktop smoke (`npm test -- --only test-desktop`) when a pushed commit changes
// apps/desktop/electron, as AGENTS.md asks of a desktop PR; CI runs it only on main.
// Not lefthook's {push_files}: on a branch's first push it lists every file in the tree, so every new branch would run it.
// Reads git's pre-push lines (<local ref> <local sha> <remote ref> <remote sha>) on stdin.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ZERO = /^0+$/;

/**
 * Git exports GIT_DIR (and in a linked worktree more) to hooks. A check that runs `git init` in a temp folder with it
 * set re-initializes this repository instead, and flips the shared core.bare to true. Children get none of them.
 */
function withoutGitEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}

const touchesElectron = (files) => files.some((file) => file.startsWith("apps/desktop/electron/"));

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: withoutGitEnv(process.env) }).trim();
}

/** Files the pushed commits change: since the remote ref when it exists here, else since the branch left origin/main. */
function pushedFiles(stdin) {
  const files = [];
  for (const line of stdin.split("\n").filter(Boolean)) {
    const [, local, , remote] = line.split(" ");
    if (!local || ZERO.test(local)) continue; // a deleted ref pushes no files
    let base = !ZERO.test(remote ?? "0") ? remote : null;
    if (base) {
      try {
        git(["cat-file", "-e", `${base}^{commit}`]);
      } catch {
        base = null;
      }
    }
    base ??= git(["merge-base", local, "origin/main"]);
    files.push(
      ...git(["diff", "--name-only", `${base}...${local}`])
        .split("\n")
        .filter(Boolean),
    );
  }
  return files;
}

if (require.main === module) {
  let files;
  try {
    files = pushedFiles(fs.readFileSync(0, "utf8"));
  } catch (error) {
    // No origin/main to compare with (a fresh clone of a fork, say): CI and the PR checklist still cover it.
    console.log(`Skipping the desktop smoke: could not list the pushed files (${error.message.split("\n")[0]}).`);
    process.exit(0);
  }
  if (!touchesElectron(files)) process.exit(0);
  console.log("The push changes apps/desktop/electron: running the macOS desktop smoke (npm test -- --only test-desktop).");
  const result = spawnSync("npm", ["test", "--", "--only", "test-desktop"], {
    cwd: root,
    stdio: "inherit",
    env: withoutGitEnv(process.env),
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

module.exports = { withoutGitEnv, touchesElectron, pushedFiles };
