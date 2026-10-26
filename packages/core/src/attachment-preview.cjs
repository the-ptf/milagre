const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const LIMIT = 256 * 1024;

/** Both previews and downloads use the same file authorization and regular-file checks. Caller closes the handle. */
async function openAttachment(file, roots, attached = []) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Choose an attached file or a file in an open Worktree.");
  const real = await fs.realpath(file);
  const canonicalRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => null)));
  const inside = canonicalRoots.some((root) => root && (real === root || real.startsWith(root + path.sep)));
  if (!inside && !attached.includes(file)) throw new Error("Choose an attached file or a file in an open Worktree.");
  if (!(await fs.stat(real)).isFile()) throw new Error("Only a regular file can be previewed.");
  // A file can be replaced after stat; nonblocking open also rejects a raced-in FIFO without waiting for a writer.
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only a regular file can be previewed.");
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read a bounded text preview from an open Worktree or an explicitly shared attachment. */
async function readAttachment(file, roots, attached = []) {
  const { handle, stat } = await openAttachment(file, roots, attached);
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, LIMIT + 1));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const content = buffer.subarray(0, Math.min(count, LIMIT));
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content, { stream: count > LIMIT });
    } catch {
      return { text: "", binary: true, truncated: false };
    }
    if (content.includes(0)) return { text: "", binary: true, truncated: false };
    return { text, binary: false, truncated: count > LIMIT };
  } finally {
    await handle.close();
  }
}
module.exports = { readAttachment, openAttachment };
