const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Keep local state out of `git status` and `git add .` without hiding shared configuration such as worktree.json
// or checkpoint-ignore. New runtime files belong here too. Existing ignore files remain the user's choice.
const RULES = [
  "# Milagre local runtime state (shared configuration stays visible)",
  "/.gitignore",
  "/.gitignore.*.tmp",
  "/chats.db",
  "/chats.db-*",
  "/coordination.json",
  "/coordination.json.*",
  "/runtime.lock",
  "/runtime.lock.*",
  "/details/",
  "/images/",
  "/subagents/",
  "/runtime/",
  "/worktrees/",
  "",
].join("\n");

// Called synchronously while taking Project ownership: no concurrent open can observe partial initialization.
function ensureProjectIgnore(projectPath) {
  const directory = path.join(projectPath, ".milagre");
  // Ownership supports legacy metadata symlinks; do not write an ignore file into their external destination.
  if (fs.lstatSync(directory).isSymbolicLink()) return;
  const temporary = path.join(directory, `.gitignore.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, RULES, { flag: "wx", mode: 0o600 });
    // A hard link publishes the complete file atomically and refuses to replace any existing file or symlink.
    try {
      fs.linkSync(temporary, path.join(directory, ".gitignore"));
    } catch (error) {
      // Some supported Project filesystems cannot hard-link. Keep opening usable without a rename/copy
      // fallback: those could replace a user's rules or expose an incomplete ignore file to Git.
      if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) {
        console.warn(
          `Milagre couldn't create ${path.join(directory, ".gitignore")}: hard links are unsupported (${error.code}); automatic runtime-state ignore protection was skipped.`,
        );
        return;
      }
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { ensureProjectIgnore };
