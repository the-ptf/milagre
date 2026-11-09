const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Whether this host keeps the Mac awake (keep-awake.cjs). Off until someone turns it on: the desktop's Settings, the phone
// and a paired desktop edit the same file, and the daemon reads it before anything else can ask, so a Mac started with no
// window open (a login item, `milagre serve`) follows it too.

const normalize = (value) => ({ enabled: value?.enabled === true });

function read(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return normalize(null);
  }
}

/** The setting, saved in `file`. A save goes out as `keep-awake:settings` so every open Settings view follows it. */
function createKeepAwakeSettings({ file, emit = () => {} }) {
  function save(patch) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("Keep awake settings must be an object");
    const value = normalize({ ...read(file), ...patch });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
    emit("keep-awake:settings", value);
    return value;
  }
  return { read: () => read(file), save };
}

module.exports = { createKeepAwakeSettings };
