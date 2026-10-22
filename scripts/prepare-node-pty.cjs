// node-pty's prebuilt macOS helper is published without its execute bit, and npm may skip node-pty's own install
// script. Without the bit every Terminal fails with "posix_spawnp failed", so set it before running or packaging.
const fs = require("node:fs");
const path = require("node:path");

// node-pty is @milagre/core's dependency, so it is found from there.
const fromCore = require("node:module").createRequire(require.resolve("@milagre/core"));

function prepareNodePty(root = path.dirname(fromCore.resolve("node-pty/package.json"))) {
  const helpers = [path.join(root, "build", "Release", "spawn-helper")];
  const prebuilds = path.join(root, "prebuilds");
  if (fs.existsSync(prebuilds)) for (const target of fs.readdirSync(prebuilds)) helpers.push(path.join(prebuilds, target, "spawn-helper"));
  const prepared = [];
  for (const helper of helpers) {
    if (!fs.existsSync(helper)) continue;
    fs.chmodSync(helper, 0o755);
    prepared.push(helper);
  }
  return prepared;
}

module.exports = { prepareNodePty };
if (require.main === module) {
  try {
    prepareNodePty();
  } catch (error) {
    // An install without @milagre/core's dependencies has no Terminal to prepare.
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
}
