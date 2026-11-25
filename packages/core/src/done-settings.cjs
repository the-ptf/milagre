const { normalizeDoneSettings } = require("@milagre/shared/done");
const { createSettingsFile } = require("./settings-file.cjs");

const createDoneSettings = ({ file, emit }) =>
  createSettingsFile({ file, emit, normalize: normalizeDoneSettings, event: "done:settings", name: "Done settings" });

module.exports = { createDoneSettings };
