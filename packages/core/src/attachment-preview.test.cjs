const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { insideRoots, readAttachment } = require("./attachment-preview.cjs");

test("attachment previews read text, limit large files, and identify binary data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-preview-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "ui.tsx");
  await fs.writeFile(file, 'export const ui = "hello";');
  assert.deepEqual(await readAttachment(file, [root]), { text: 'export const ui = "hello";', truncated: false, binary: false });
  await fs.writeFile(file, "");
  assert.equal((await readAttachment(file, [root])).text, "");
  await fs.writeFile(file, "x".repeat(300_000));
  const large = await readAttachment(file, [root]);
  assert.equal(large.truncated, true);
  assert.equal(large.text.length, 256 * 1024);
  await fs.writeFile(file, Buffer.from([0, 1, 2]));
  assert.equal((await readAttachment(file, [root])).binary, true);
});

test("previews reject paths outside open roots and symlink escapes, but allow explicitly attached files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inside = path.join(root, "project");
  await fs.mkdir(inside);
  const external = path.join(root, "private.txt");
  await fs.writeFile(external, "attached");
  await assert.rejects(readAttachment(external, [inside]), /attached file|open Worktree/);
  await fs.symlink(external, path.join(inside, "escape.txt"));
  await assert.rejects(readAttachment(path.join(inside, "escape.txt"), [inside]), /attached file|open Worktree/);
  assert.equal((await readAttachment(external, [inside], [external])).text, "attached");
  await assert.rejects(readAttachment(inside, [inside]), /regular file/);
});

test("named pipes are rejected without waiting for a writer", { skip: process.platform === "win32" }, async (t) => {
  const { execFileSync, spawnSync } = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-pipe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fifo = path.join(root, "waiting.txt");
  execFileSync("mkfifo", [fifo]);
  const script = `require(${JSON.stringify(require.resolve("./attachment-preview.cjs"))}).readAttachment(process.argv[1], [process.argv[2]]).then(() => process.exit(1), error => process.exit(/regular file/.test(error.message) ? 0 : 2));`;
  const child = spawnSync(process.execPath, ["-e", script, fifo, root], { timeout: 2000, encoding: "utf8" });
  assert.equal(child.error, undefined, "Opening a named pipe must not block");
  assert.equal(child.status, 0, child.stderr);
});

test("a file inside an open Worktree is known without a search of the Chats; others, links out and missing files are not", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-inside-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-outside-"));
  t.after(() => Promise.all([root, outside].map((dir) => fs.rm(dir, { recursive: true, force: true }))));
  await fs.writeFile(path.join(root, "import.sql"), "select 1;");
  await fs.writeFile(path.join(outside, "secret.sql"), "select 2;");
  await fs.symlink(path.join(outside, "secret.sql"), path.join(root, "link.sql"));
  assert.equal(await insideRoots(path.join(root, "import.sql"), [root]), true);
  assert.equal(await insideRoots(path.join(outside, "secret.sql"), [root]), false);
  assert.equal(await insideRoots(path.join(root, "link.sql"), [root]), false);
  assert.equal(await insideRoots(path.join(root, "missing.sql"), [root]), false);
  assert.equal(await insideRoots("relative.sql", [root]), false);
});
