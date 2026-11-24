const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

/** Private per-Chat page sharing histories: one JSON file per Chat, named by a hash of its id, written atomically. */
function createShareHistory(directory) {
  const file = (chatId) => path.join(directory, `${createHash("sha256").update(chatId).digest("base64url")}.json`);
  const readFile = async (filename) => {
    try {
      const data = JSON.parse(await fs.readFile(filename, "utf8"));
      if (!Array.isArray(data)) throw Error("Invalid share history");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw Error("The saved page sharing history could not be read.", { cause: error });
    }
  };
  const read = (chatId) => readFile(file(chatId));
  const writeFile = async (filename, entries) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
      await fs.rename(temporary, filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  };
  const historyQueues = new Map();
  const updateHistory = (filename, update) => {
    const result = (historyQueues.get(filename) ?? Promise.resolve()).then(async () => {
      const entries = await readFile(filename);
      const value = update(entries);
      await writeFile(filename, entries);
      return value;
    });
    const tail = result.catch(() => {});
    historyQueues.set(filename, tail);
    void tail.finally(() => {
      if (historyQueues.get(filename) === tail) historyQueues.delete(filename);
    });
    return result;
  };
  const histories = async function* () {
    const names = await fs.readdir(directory).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{43}\.json$/.test(name)) continue;
      const filename = path.join(directory, name);
      try {
        yield { filename, entries: await readFile(filename) };
      } catch {
        console.warn(`Skipping unreadable page sharing history: ${filename}`);
      }
    }
  };
  return { file, readFile, read, updateHistory, histories };
}

module.exports = { createShareHistory };
