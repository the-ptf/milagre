const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

// Each Chat has one atomic private file. Failed writes never become accepted in-memory state.
function createAdvisorStore({ dataDir }) {
  const directory = path.join(dataDir, "advisors");
  const queues = new Map();
  let closed = false;
  const filename = (chatId) => path.join(directory, `${createHash("sha256").update(chatId).digest("hex")}.json`);
  async function readDisk(chatId) {
    try {
      return JSON.parse(await fs.readFile(filename(chatId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  return {
    async read(chatId) {
      await queues.get(chatId)?.catch(() => {});
      return readDisk(chatId);
    },
    update(chatId, change) {
      if (closed) return Promise.reject(new Error("Advisor storage is closed."));
      const work = (queues.get(chatId) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const previous = await readDisk(chatId);
          // eslint-disable-next-line promise/no-callback-in-promise -- this is a host port, not a Node callback
          const next = await change(previous);
          if (next === previous) return next;
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = `${filename(chatId)}.${randomUUID()}.tmp`;
          try {
            const file = await fs.open(temporary, "wx", 0o600);
            try {
              // eslint-disable-next-line promise/no-callback-in-promise -- next is record data, not a callback
              await file.writeFile(JSON.stringify(next));
              await file.sync();
            } finally {
              await file.close();
            }
            await fs.rename(temporary, filename(chatId));
          } finally {
            await fs.rm(temporary, { force: true }).catch(() => {});
          }
          return next;
        });
      queues.set(chatId, work);
      const forget = () => {
        if (queues.get(chatId) === work) queues.delete(chatId);
      };
      work.then(forget, forget);
      return work;
    },
    async flush() {
      await Promise.all(queues.values());
    },
    async close() {
      closed = true;
      await Promise.all(queues.values());
    },
  };
}
module.exports = { createAdvisorStore };
