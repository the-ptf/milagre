#!/usr/bin/env node
// lefthook pre-push: runs the macOS desktop smoke (`npm test -- --only test-desktop`) when a pushed commit changes
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ZERO = /^0+$/;

function withoutGitEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
}

const touchesElectron = (files) => files.some((file) => file.startsWith("apps/desktop/electron/"));

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: withoutGitEnv(process.env) }).trim();
}

function pushedFiles(stdin) {
  const files = [];
  for (const line of stdin.split("\n").filter(Boolean)) {
    const [, local, , remote] = line.split(" ");
    if (!local || ZERO.test(local)) continue;
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
