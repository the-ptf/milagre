const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeBabysitSettings } = require("@milagre/shared/babysit");

function read(file) {
  try {
    return normalizeBabysitSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return normalizeBabysitSettings(null);
  }
}

function createBabysitSettings({ file, emit = () => {} }) {
  function save(patch) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error("Babysit settings must be an object");
    }
    const value = normalizeBabysitSettings({ ...read(file), ...patch });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
    emit("babysit:settings", value);
    return value;
  }
  return { read: () => read(file), save };
}

module.exports = { createBabysitSettings };
