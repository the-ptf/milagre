// @ts-check
const fs = require("node:fs");

const MAX_BYTES = 512 * 1024;

/**
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
    logger: {
      info: (/** @type {unknown} */ value) => write(`electron-updater: ${text(value)}`),
      warn: (/** @type {unknown} */ value) => write(`electron-updater warning: ${text(value)}`),
      error: (/** @type {unknown} */ value) => write(`electron-updater error: ${text(value)}`),
    },
  };
}

module.exports = { createUpdateLog };
