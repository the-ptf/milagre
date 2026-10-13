const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// A missing setting enables Designs. An unreadable setting disables only Designs, not the host.
// Saving is atomic and never changes memory on failure.
function createDesignSettings(file) {
  let enabled = true;
  try {
    enabled = JSON.parse(fs.readFileSync(file, "utf8"))?.enabled === true;
  } catch (error) {
    enabled = error.code === "ENOENT";
  }
  return {
    enabled: () => enabled,
    save(value) {
      if (typeof value !== "boolean") throw new Error("Designs enabled must be a boolean.");
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
