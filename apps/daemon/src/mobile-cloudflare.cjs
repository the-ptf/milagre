const { assertPrivate } = require("@milagre/core/private-files");
const fs = require("node:fs/promises");
const path = require("node:path");

/** Reads `<dataDir>/cloudflare.json`, which `npm run mobile:cloudflare` writes (0600; it holds the tunnel and Access secrets). */
async function readCloudflare(dataDir) {
  const file = path.join(dataDir, "cloudflare.json");
  let config;
  try {
    assertPrivate(file);
    config = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("No Cloudflare tunnel is set up for this profile. Run `npm run mobile:cloudflare -- --domain your.domain` first.", { cause: error });
    throw error;
  }
  const info = await fs.stat(file);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
    throw new Error(`${file} must have permissions 0600; it holds the tunnel and Access secrets.`);
  if (!config.hostname || !config.connectorToken || !config.access?.id || !config.access?.secret || !Number.isInteger(config.port))
    throw new Error(`${file} is incomplete. Run mobile:cloudflare again.`);
  return config;
}

module.exports = { readCloudflare };
