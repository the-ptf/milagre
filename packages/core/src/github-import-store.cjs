const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

/** Operation receipts contain target IDs, never authentication or imported issue bodies. */
function createGitHubImportStore(dataDir) {
  const directory = path.join(dataDir, "github-imports");
  const file = (key) => path.join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  return {
    async load(key) {
      try {
        return JSON.parse(await fs.readFile(file(key), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async save(key, receipt) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = file(key);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(receipt));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
  };
}

module.exports = { createGitHubImportStore };
