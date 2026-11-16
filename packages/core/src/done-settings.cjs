const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeDoneSettings } = require("@milagre/shared/done");

function read(file) {
  try {
    return normalizeDoneSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return normalizeDoneSettings(null);
  }
}

function createDoneSettings({ file, emit = () => {} }) {
  function save(patch) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("Done settings must be an object");
    const value = normalizeDoneSettings({ ...read(file), ...patch });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
    emit("done:settings", value);
    return value;
  }
  return { read: () => read(file), save };
}

module.exports = { createDoneSettings };
