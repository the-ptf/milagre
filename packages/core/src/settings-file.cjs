const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createSettingsFile({ file, normalize, event, name, emit = () => {} }) {
  function read() {
    try {
      return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return normalize(null);
    }
  }
  function save(patch) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error(`${name} must be an object`);
    const value = normalize({ ...read(), ...patch });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, file);
    emit(event, value);
    return value;
  }
  return { read, save };
}

module.exports = { createSettingsFile };
