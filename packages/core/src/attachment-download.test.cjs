const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { readAttachmentChunk, CHUNK_BYTES } = require("./attachment-download.cjs");
const { downloadAttachment } = require("@milagre/shared/attachment-download");

test("binary downloads preserve every byte across bounded chunks and reject changed or unauthorized files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-download-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "archive.zip");
  const bytes = Buffer.alloc(CHUNK_BYTES + 73);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  await fs.writeFile(file, bytes);
  const chunks = [];
  const progress = [];
  await downloadAttachment(
    (offset, version) => readAttachmentChunk(file, offset, version, [root]),
    (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
    (received) => progress.push(received),
  );
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.deepEqual(progress, [CHUNK_BYTES, bytes.length]);
  await assert.rejects(readAttachmentChunk(file, 0, undefined, []), /attached file|open Worktree/);
  await fs.symlink(file, path.join(root, "alias.zip"));
  assert.equal((await readAttachmentChunk(file, 0, undefined, [], [file])).size, bytes.length);
  for (const offset of [-1, 0.5, bytes.length + 1]) await assert.rejects(readAttachmentChunk(file, offset, "old", [root]));
  const first = await readAttachmentChunk(file, 0, undefined, [root]);
  await fs.appendFile(file, "changed");
  await assert.rejects(readAttachmentChunk(file, CHUNK_BYTES, first.version, [root]), /changed during download/);
});

test("empty files download successfully", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "empty.txt");
  await fs.writeFile(file, "");
  assert.equal(
    await downloadAttachment(
      (offset, version) => readAttachmentChunk(file, offset, version, [root]),
      () => {},
    ),
    0,
  );
});
