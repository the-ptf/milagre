const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const { withoutGitEnv, touchesElectron, pushedFiles } = require("./pre-push-desktop-smoke.cjs");

test("the desktop smoke's child processes never see the hook's GIT_ variables", () => {
  assert.deepEqual(withoutGitEnv({ GIT_DIR: "/repo/.git/worktrees/x", GIT_INDEX_FILE: "i", HOME: "/home", PATH: "/bin" }), { HOME: "/home", PATH: "/bin" });
});

test("only a change under apps/desktop/electron runs the smoke", () => {
  assert.equal(touchesElectron(["apps/desktop/electron/main.cjs"]), true);
  assert.equal(touchesElectron(["apps/desktop/app/src/App.tsx", "apps/desktop/electron-builder.yml", "scripts/test-desktop.cjs"]), false);
});

test("a deleted ref pushes no files", () => {
  assert.deepEqual(pushedFiles(`(delete) ${"0".repeat(40)} refs/heads/gone ${"a".repeat(40)}\n`), []);
});

test("a new branch is compared with where it left origin/main, not the whole tree", (t) => {
  const root = path.resolve(__dirname, "..");
  const has = (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root, env: withoutGitEnv(process.env) }).status === 0;
  if (!has("origin/main") || !has("HEAD")) return t.skip("needs a checkout with origin/main");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: withoutGitEnv(process.env) }).stdout.trim();
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: root, encoding: "utf8", env: withoutGitEnv(process.env) });
  if (base.status !== 0) return t.skip("shallow checkout without a merge base");
  const files = pushedFiles(`refs/heads/x ${head} refs/heads/x ${"0".repeat(40)}\n`);
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8", env: withoutGitEnv(process.env) })
    .stdout.split("\n")
    .filter(Boolean);
  assert.ok(files.length < tracked.length, `${files.length} of ${tracked.length} files`);
});
