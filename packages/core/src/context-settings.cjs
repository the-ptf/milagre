const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeContextSettings } = require("@milagre/shared/context-settings");

// Host-owned thresholds: Settings on the desktop, phone and paired computers edit the same configuration.

function read(file) {
  try {
    return normalizeContextSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return normalizeContextSettings(null);
  }
}

/** The settings, saved in `file`. A save goes out as `context:settings` so every open Settings view follows it at once. */
function createContextSettings({ file, emit = () => {} }) {
  function save(patch) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error("Context settings must be an object");
    }
    const value = normalizeContextSettings({ ...read(file), ...patch });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
    emit("context:settings", value);
    return value;
  }
  return { read: () => read(file), save };
}

module.exports = { createContextSettings };
