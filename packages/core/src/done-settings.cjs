const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeDoneSettings } = require("@milagre/shared/done");

// How long a Chat stays in the Done list before this host archives it. The daemon keeps it, so the desktop's Settings,
// the phone and a paired desktop edit the same file and the sweep (done-sweep.cjs) reads what they see.

function read(file) {
  try {
    return normalizeDoneSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return normalizeDoneSettings(null);
  }
}

/** The settings, saved in `file`. A save goes out as `done:settings` so every open Settings view and Done list follows it. */
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
