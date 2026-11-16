const fs = require("node:fs/promises");
const path = require("node:path");
const { hostIdOf, fromB64url } = require("@milagre/shared/relay-crypto");

/**
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
