const fs = require("node:fs/promises");
const path = require("node:path");
const { MAX_ATTACHMENT_BYTES } = require("@milagre/shared/limits");
const { ATTACHMENT_CHUNK_CHARS } = require("@milagre/shared/attachment-upload");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const RETENTION_MS = 30 * 60 * 1000;

/** Each transfer owns a temporary file. Retransmitted chunks must match the bytes already written. */
function createAttachmentTransfers({ dataDir, upload }) {
  const pending = new Map();
  let queue = Promise.resolve();
  const serial = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  async function remove(entry) {
    clearTimeout(entry.timer);
    if (entry.folder) {
      await fs.unlink(path.join(entry.folder, "data")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await fs.rmdir(entry.folder);
      entry.folder = null;
    }
  }
  function refresh(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void serial(async () => {
        pending.delete(id);
        await remove(entry);
      }).catch(() => {});
    }, RETENTION_MS);
    entry.timer.unref();
  }
  // A crash can leave a partial file behind. Delete only our old, single-file transfer folders.
  async function sweep() {
    const active = new Set([...pending.values()].map((entry) => entry.folder));
    for (const folder of await fs.readdir(dataDir, { withFileTypes: true })) {
      if (!folder.isDirectory() || !/^attachment-transfer-[A-Za-z0-9]{6}$/.test(folder.name)) continue;
      const directory = path.join(dataDir, folder.name);
      if (active.has(directory)) continue;
      const contents = await fs.readdir(directory, { withFileTypes: true });
      if (contents.length !== 1 || contents[0].name !== "data" || !contents[0].isFile()) continue;
      const file = path.join(directory, "data");
      if (Date.now() - (await fs.stat(file)).mtimeMs < RETENTION_MS) continue;
      await fs.unlink(file);
      await fs.rmdir(directory);
    }
  }
  return {
    sweep: () => serial(sweep),
    receive: (request) =>
      serial(async () => {
        if (request.transferId === undefined) return upload(request);
        const { transferId, projectPath, name, base64, offset, totalBytes, quota } = request;
        if (!UUID.test(transferId) || typeof projectPath !== "string" || !projectPath || typeof name !== "string" || !name)
          throw failure("Invalid attachment transfer");
        if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_ATTACHMENT_BYTES)
          throw failure("Each attachment must be 50 MiB or smaller.", 413);
        if (typeof base64 !== "string" || base64.length > ATTACHMENT_CHUNK_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
          throw failure("Invalid attachment chunk");
        const bytes = Buffer.from(base64, "base64");
        if (!bytes.length || bytes.toString("base64") !== base64) throw failure("Invalid attachment chunk");
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > totalBytes) throw failure("Invalid attachment chunk offset");
        let entry = pending.get(transferId);
        if (!entry) {
          if (offset !== 0) throw failure("Attachment upload was interrupted. Restart it from offset 0.");
          entry = { projectPath, name, totalBytes, quota, received: 0, folder: await fs.mkdtemp(path.join(dataDir, "attachment-transfer-")), result: null };
          pending.set(transferId, entry);
          refresh(transferId, entry);
          await fs.writeFile(path.join(entry.folder, "data"), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
        }
        refresh(transferId, entry);
        if (entry.projectPath !== projectPath || entry.name !== name || entry.totalBytes !== totalBytes || entry.quota !== quota)
          throw failure("Attachment transfer scope and metadata must match");
        if (entry.result) return entry.result;
        if (offset > entry.received || (offset < entry.received && offset + bytes.length > entry.received))
          throw failure("Attachment chunks arrived out of order or at an invalid offset");
        const file = path.join(entry.folder, "data");
        if (offset < entry.received) {
          const handle = await fs.open(file, "r");
          try {
            const previous = Buffer.alloc(bytes.length);
            const { bytesRead } = await handle.read(previous, 0, previous.length, offset);
            if (bytesRead !== bytes.length || !previous.equals(bytes)) throw failure("Retried attachment chunk does not match");
          } finally {
            await handle.close();
          }
        } else {
          if (quota !== undefined) {
            if (!Number.isSafeInteger(quota) || quota < 0) throw failure("Invalid attachment quota");
            const staged = [...pending.values()].reduce((total, item) => total + (item.result ? 0 : item.received), 0);
            const stored = await require("./upload-bytes.cjs").folderBytes(path.join(dataDir, "mobile-attachments"));
            if (stored + staged + bytes.length > quota) throw failure("This demo computer is full.", 507);
          }
          await fs.appendFile(file, bytes);
          entry.received += bytes.length;
        }
        if (entry.received !== totalBytes) return null;
        const complete = await fs.readFile(file);
        entry.result = await upload({ projectPath, name, base64: complete.toString("base64"), ...(quota === undefined ? {} : { quota }) });
        await remove(entry);
        refresh(transferId, entry);
        return entry.result;
      }),
    close: () =>
      serial(async () => {
        for (const entry of pending.values()) await remove(entry);
        pending.clear();
      }),
  };
}
module.exports = { createAttachmentTransfers };
