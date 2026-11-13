// Production domain oracle. The Rust test creates this private repository first;
// no existing user repository, network, profile, or global config is admitted.
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = fs.realpathSync(input.root);
if (!path.basename(root).startsWith("milagre-rust-git-write-") || !fs.existsSync(path.join(root, ".milagre-isolated-git")))
  throw new Error("Isolated fixture root required");
for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  GNUPGHOME: path.join(root, "home/gnupg"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
});
delete process.env.SSH_AUTH_SOCK;
delete process.env.GPG_TTY;
const { createGitActions } = require("../../../packages/core/src/git-actions.cjs");
const { createWorktree } = require("../../../packages/core/src/worktrees.cjs");
const { worktreeStatus, removeWorktree } = require("../../../packages/core/src/worktree-cleanup.cjs");
const { createGit } = require("../../../packages/core/src/git/client.cjs");
const within = (value) => {
  const real = fs.realpathSync(value);
  if (!real.startsWith(root + path.sep)) throw new Error("Outside fixture");
  return real;
};
async function run() {
  const args = input.args;
  switch (input.method) {
    case "commit":
      return createGitActions({ env: process.env }).commit({ ...args, cwd: within(args.cwd) });
    case "create":
      return createWorktree({
        ...args,
        projectPath: within(args.projectPath),
        root: path.join(root, "worktrees"),
        fetched: true,
        copyPatterns: ["# fixture copy disabled"],
      });
    case "status":
      return worktreeStatus(within(args.path), args.base);
    case "list":
      return createGit().read.worktreeList(within(args.cwd));
    case "remove":
      return removeWorktree({ ...args, path: within(args.path), projectPath: within(args.projectPath), root: path.join(root, "worktrees") });
    default:
      throw new Error("Unknown fixture operation");
  }
}
run().then(
  (value) => process.stdout.write(JSON.stringify({ value })),
  (error) => process.stdout.write(JSON.stringify({ error: error.message })),
);
