const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createDesignSettings(file, { name = "Designs", missing = true } = {}) {
  let enabled = missing;
  try {
    enabled = JSON.parse(fs.readFileSync(file, "utf8"))?.enabled === true;
  } catch (error) {
    enabled = error.code === "ENOENT" && missing;
  }
  return {
    enabled: () => enabled,
    save(value) {
      if (typeof value !== "boolean") throw new Error(`${name} enabled must be a boolean.`);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ enabled: value }), { mode: 0o600 });
        fs.renameSync(temporary, file);
        enabled = value;
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return { enabled };
    },
  };
}

module.exports = { createDesignSettings };
