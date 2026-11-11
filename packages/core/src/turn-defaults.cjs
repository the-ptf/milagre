const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function normalize(value) {
  return {
    replies: value?.replies === "normal" ? "normal" : "concise",
    tldrEnabled: value?.tldrEnabled !== false,
  };
}

// The host keeps the last explicit choices so clients without these controls inherit them.
function createTurnDefaults({ file }) {
  function read() {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return normalize(null);
    }
  }

  function resolve(request) {
    const saved = read();
    const value = {
      replies: ["concise", "normal"].includes(request.replies) ? request.replies : saved.replies,
      tldrEnabled: typeof request.tldrEnabled === "boolean" ? request.tldrEnabled : saved.tldrEnabled,
    };
    if (value.replies !== saved.replies || value.tldrEnabled !== saved.tldrEnabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(value));
      fs.renameSync(temp, file);
    }
    return value;
  }

  return { read, resolve };
}

module.exports = { createTurnDefaults };
