const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const VERSION = "4.0";
const SHA256 = "84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a";
async function prepareSimulatorHelper(options = {}) {
  const target =
    options.target ?? path.join(path.dirname(require.resolve("expo-device-hub/package.json")), "vendor/serve-emu/vendor", `scrcpy-server-v${VERSION}`);
  const expected = options.sha256 ?? SHA256;
  const verified = (bytes) => createHash("sha256").update(bytes).digest("hex") === expected;
  try {
    if (verified(await fs.readFile(target))) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const download =
    options.download ??
    (async () => {
      const response = await fetch(`https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`Android capture server download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    });
  const bytes = await download();
  if (!verified(bytes)) throw new Error("Android capture server checksum mismatch. Refusing to package it.");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
module.exports = { prepareSimulatorHelper };
if (require.main === module)
  prepareSimulatorHelper()
    .then(() => console.log("Android capture server verified."))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
