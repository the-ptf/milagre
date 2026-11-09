const fs = require("node:fs/promises");
const path = require("node:path");
const { hostIdOf, fromB64url } = require("@milagre/shared/relay-crypto");

/**
 * This Mac's relay host id, read from the daemon's relay-identity.json (apps/daemon/src/relay-identity.cjs) without
 * creating it: Add computer refuses this Mac's own pairing link with it. Null when phone access never ran or the file
 * can't be read.
 * @param {string} dataDir
 * @returns {Promise<string | null>}
 */
async function readOwnHostId(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, "relay-identity.json"), "utf8"));
    return hostIdOf(fromB64url(value.sign.publicKey));
  } catch {
    return null;
  }
}

module.exports = { readOwnHostId };
