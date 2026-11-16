const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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

function ensureProjectIgnore(projectPath) {
  const directory = path.join(projectPath, ".milagre");
  if (fs.lstatSync(directory).isSymbolicLink()) return;
  const temporary = path.join(directory, `.gitignore.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, RULES, { flag: "wx", mode: 0o600 });
    try {
      fs.linkSync(temporary, path.join(directory, ".gitignore"));
    } catch (error) {
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
