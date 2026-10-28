// @ts-check
const fs = require("node:fs");
const path = require("node:path");

/** Preferences live outside the installed bundle and Chromium's origin-specific storage. */
function createPreferencesStore(/** @type {string} */ file) {
  /** @type {Record<string, string | null>} */
  let values = Object.create(null);
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid preferences");
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value === "string" || value === null) values[key] = value;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return {
    get(/** @type {string} */ key) {
      return values[key];
    },
    set(/** @type {string} */ key, /** @type {string | null} */ value) {
      if (!/^milagre[.:-]/.test(key) || (typeof value !== "string" && value !== null)) throw new Error("Invalid preference");
      if (values[key] === value) return;
      const next = { ...values, [key]: value };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, file);
      values = next;
    },
  };
}
module.exports = { createPreferencesStore };
