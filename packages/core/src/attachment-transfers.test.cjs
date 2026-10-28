const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createMobileUploads } = require("./mobile-uploads.cjs");
const { createAttachmentTransfers } = require("./attachment-transfers.cjs");
const { uploadAttachment } = require("@milagre/shared/attachment-upload");

async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "attachment-transfers-")));
  const uploads = createMobileUploads({ dataDir });
  const transfers = createAttachmentTransfers({ dataDir, upload: (request) => uploads.upload(request) });
  t.after(async () => {
    await transfers.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, uploads, transfers };
}
test("50 MiB files cross bounded chunks and arrive byte-for-byte", async (t) => {
  const { transfers } = await fixture(t);
  const bytes = Buffer.alloc(50 * 1024 * 1024, 42);
  let largest = 0;
  const file = await uploadAttachment(
    async (request) => {
      largest = Math.max(largest, JSON.stringify(request).length);
      return transfers.receive(request);
    },
    { projectPath: "/project", name: "recording.bin", base64: bytes.toString("base64") },
  );
  assert.ok(largest < 1024 * 1024);
  assert.deepEqual(await fs.readFile(file.path), bytes);
});
test("a lost chunk or completion acknowledgement can be retried without duplicate bytes", async (t) => {
  const { transfers } = await fixture(t);
  const transferId = randomUUID();
  const first = { projectPath: "/p", name: "note.txt", transferId, offset: 0, totalBytes: 6, base64: Buffer.from("abc").toString("base64") };
  assert.equal(await transfers.receive(first), null);
  assert.equal(await transfers.receive(first), null);
  await assert.rejects(transfers.receive({ ...first, projectPath: "/other" }), /scope|match/);
  await assert.rejects(transfers.receive({ ...first, offset: 1 }), /offset|order/);
  const last = { ...first, offset: 3, base64: Buffer.from("def").toString("base64") };
  const file = await transfers.receive(last);
  assert.deepEqual(await transfers.receive(last), file);
  assert.equal(await fs.readFile(file.path, "utf8"), "abcdef");
});
test("oversize transfers and chunks fail before storage", async (t) => {
  const { transfers } = await fixture(t);
  const request = { projectPath: "/p", name: "x.bin", transferId: randomUUID(), offset: 0, totalBytes: 50 * 1024 * 1024 + 1, base64: "YWJj" };
  await assert.rejects(transfers.receive(request), /50 MiB/);
  await assert.rejects(transfers.receive({ ...request, totalBytes: 1024 * 1024, base64: Buffer.alloc(1024 * 1024).toString("base64") }), /chunk/);
});

test("uploaded images resolve only in their Project and must still match the saved bytes", async (t) => {
  const { uploads } = await fixture(t);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = await uploads.upload({ projectPath: "/p", name: "image.png", base64: png.toString("base64") });
  const images = [{ id: "image", name: "image.png", path: file.path }];
  const resolved = await uploads.resolveImages("/p", images);
  assert.equal(resolved[0].dataUrl, `data:image/png;base64,${png.toString("base64")}`);
  await assert.rejects(uploads.resolveImages("/other", images), /missing or changed/);
  await fs.writeFile(file.path, "changed");
  await assert.rejects(uploads.resolveImages("/p", images), /missing or changed/);
});

test("partial uploads count against the confined computer's quota and close removes them", async (t) => {
  const { dataDir, transfers } = await fixture(t);
  const first = { projectPath: "/p", name: "x", transferId: randomUUID(), offset: 0, totalBytes: 6, base64: "YWJj", quota: 4 };
  await transfers.receive(first);
  await assert.rejects(transfers.receive({ ...first, transferId: randomUUID() }), /full/);
  await transfers.close();
  assert.deepEqual(
    (await fs.readdir(dataDir)).filter((name) => name.startsWith("attachment-transfer-")),
    [],
  );
});

test("cleanup removes stale crash leftovers while preserving unrelated files", async (t) => {
  const { dataDir, transfers } = await fixture(t);
  const folder = await fs.mkdtemp(path.join(dataDir, "attachment-transfer-"));
  const file = path.join(folder, "data");
  await fs.writeFile(file, "partial");
  await fs.utimes(file, 0, 0);
  const other = await fs.mkdtemp(path.join(dataDir, "attachment-transfer-"));
  await fs.writeFile(path.join(other, "keep"), "unrelated");
  await transfers.sweep();
  await assert.rejects(fs.stat(folder), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(other, "keep"), "utf8"), "unrelated");
});
test("progress follows each acknowledged chunk and ends at the file size", async (t) => {
  const { transfers } = await fixture(t);
  const bytes = Buffer.alloc(1024 * 1024 + 7, 9);
  const progress = [];
  await uploadAttachment(
    (request) => transfers.receive(request),
    { projectPath: "/project", name: "archive.zip", base64: bytes.toString("base64") },
    undefined,
    (sent, total) => progress.push([sent, total]),
  );
  assert.deepEqual(progress[0], [0, bytes.length]);
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
  assert.ok(progress.every(([sent], i) => i === 0 || sent > progress[i - 1][0]));
});
