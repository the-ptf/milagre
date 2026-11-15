// @ts-check
const fs = require("node:fs");

// The update log keeps the last stretch of updates: a check every five minutes writes a line or two.
const MAX_BYTES = 512 * 1024;

/**
 * updates.log in the data folder: each step of a check, download and install, and every updater error. The main
 * process has no log of its own, and while an install runs the host (daemon.log) is stopped, so without this a failed
 * install leaves no trace. Writing never throws.
 * @param {string} file
 * @param {{ now?: () => Date, maxBytes?: number }} [options]
 */
function createUpdateLog(file, { now = () => new Date(), maxBytes = MAX_BYTES } = {}) {
  /** @param {string} line */
  const write = (line) => {
    try {
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${now().toISOString()} ${line.replace(/\s+/g, " ").slice(0, 2000)}\n`, { mode: 0o600 });
    } catch {}
  };
  const text = (value) => (value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value));
  return {
    line: write,
    /** For electron-updater's `logger`: its info, warnings and errors, not its debug lines. */
    logger: {
      info: (/** @type {unknown} */ value) => write(`electron-updater: ${text(value)}`),
      warn: (/** @type {unknown} */ value) => write(`electron-updater warning: ${text(value)}`),
      error: (/** @type {unknown} */ value) => write(`electron-updater error: ${text(value)}`),
    },
  };
}

module.exports = { createUpdateLog };
