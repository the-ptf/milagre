const { openAttachment } = require("./attachment-preview.cjs");
const CHUNK_BYTES = 256 * 1024;
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

/** A bounded chunk, carried over the same authenticated connection as the Chat. */
async function readAttachmentChunk(file, offset, version, roots, attached) {
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && typeof version !== "string")) throw new Error("Invalid file download offset.");
  const { handle, stat } = await openAttachment(file, roots, attached);
  try {
    const current = stamp(stat);
    if (version !== undefined && version !== current) throw new Error("The file changed during download. Try again.");
    if (offset > stat.size) throw new Error("Invalid file download offset.");
    const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - offset));
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, offset + count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== bytes.length || stamp(await handle.stat()) !== current) throw new Error("The file changed during download. Try again.");
    return { base64: bytes.toString("base64"), size: stat.size, version: current };
  } finally {
    await handle.close();
  }
}
module.exports = { readAttachmentChunk, CHUNK_BYTES };
