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
  let cached;
  function read() {
    if (cached) return cached;
    try {
      cached = normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      cached = normalize(null);
    }
    return cached;
  }

  function resolve(request) {
    const saved = read();
    return {
      replies: ["concise", "normal"].includes(request.replies) ? request.replies : saved.replies,
      tldrEnabled: typeof request.tldrEnabled === "boolean" ? request.tldrEnabled : saved.tldrEnabled,
    };
  }

  function remember(request) {
    const saved = read();
    const value = resolve(request);
    if (value.replies === saved.replies && value.tldrEnabled === saved.tldrEnabled) return value;
    cached = value;
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(temp, JSON.stringify(value));
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    } catch (error) {
      console.warn("Could not save turn defaults:", error.message);
    }
    return value;
  }

  return { read, resolve, remember };
}

module.exports = { createTurnDefaults };
