const fs = require("node:fs/promises");
const path = require("node:path");

async function folderBytes(folder) {
  let total = 0;
  for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) total += await folderBytes(file);
    else if (entry.isFile()) total += (await fs.stat(file)).size;
  }
  return total;
}
module.exports = { folderBytes };
