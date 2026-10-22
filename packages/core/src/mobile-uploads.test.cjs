const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMobileUploads, RETENTION_MS } = require("./mobile-uploads.cjs");

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-uploads-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let time = Date.now();
  const create = () => createMobileUploads({ dataDir, now: () => time });
  return {
    dataDir,
    create,
    advance: (ms) => (time += ms),
    request: { projectPath: "/project", name: "notes.txt", base64: Buffer.from("hello").toString("base64") },
  };
}

test("uploads reuse verified content across restart and isolate scope, content and filename", async (t) => {
  const { create, request } = await fixture(t);
  const first = await create().upload(request);
  const store = create();
  assert.deepEqual(await store.upload(request), first);
  assert.deepEqual(await store.upload({ projectPath: request.projectPath, reuse: first.id }), first);
  assert.equal(await store.upload({ projectPath: "/other", reuse: first.id }), null);
  for (const changed of [{ projectPath: "/other" }, { name: "other.txt" }, { base64: "d29ybGQ=" }])
    assert.notEqual((await store.upload({ ...request, ...changed })).path, first.path);
  await fs.unlink(first.path);
  assert.equal(await store.upload({ projectPath: request.projectPath, reuse: first.id }), null);
  const next = await store.upload(request);
  assert.notEqual(next.path, first.path);
  await fs.writeFile(next.path, "WRONG");
  assert.equal(await store.upload({ projectPath: request.projectPath, reuse: next.id }), null);
  assert.notEqual((await store.upload(request)).path, next.path);
});

test("only abandoned managed files expire; claimed, legacy and originals survive", async (t) => {
  const { dataDir, create, advance, request } = await fixture(t);
  const store = create();
  const kept = await store.upload(request);
  const stale = await store.upload({ ...request, name: "stale.txt" });
  const legacy = path.join(dataDir, "mobile-attachments", "legacy", "original.txt");
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(legacy, "legacy");
  await store.claim({ files: [kept.path, legacy] });
  advance(RETENTION_MS - 1);
  await store.sweep();
  assert.equal(await fs.readFile(stale.path, "utf8"), "hello");
  advance(2);
  await create().sweep();
  await assert.rejects(fs.stat(stale.path), { code: "ENOENT" });
  assert.equal(await fs.readFile(kept.path, "utf8"), "hello");
  assert.equal(await fs.readFile(legacy, "utf8"), "legacy");
});

test("reuse renews retention and claims serialize against cleanup", async (t) => {
  const { create, advance, request } = await fixture(t);
  const store = create();
  const file = await store.upload(request);
  advance(RETENTION_MS - 1);
  await store.upload({ projectPath: request.projectPath, reuse: file.id });
  advance(2);
  await store.sweep();
  await Promise.all([store.claim({ body: `read ${file.path}` }), store.sweep()]);
  advance(RETENTION_MS + 1);
  await create().sweep();
  assert.equal(await fs.readFile(file.path, "utf8"), "hello");
});

test("cleanup refuses symlinks and unexpected contents", async (t) => {
  const { dataDir, create, advance, request } = await fixture(t);
  const store = create();
  const linked = await store.upload(request);
  const extra = await store.upload({ ...request, name: "extra.txt" });
  const original = path.join(dataDir, "original.txt");
  await fs.writeFile(original, "original");
  await fs.unlink(linked.path);
  await fs.symlink(original, linked.path);
  await fs.writeFile(path.join(path.dirname(extra.path), "unowned.txt"), "keep");
  advance(RETENTION_MS + 1);
  await store.sweep();
  assert.equal(await fs.readFile(original, "utf8"), "original");
  assert.equal(await fs.readFile(extra.path, "utf8"), "hello");
  assert.ok((await fs.lstat(linked.path)).isSymbolicLink());
});

test("desktop attachment aliases retain the managed original", async (t) => {
  const { dataDir, create, advance, request } = await fixture(t);
  const store = create();
  const file = await store.upload(request);
  const alias = path.join(dataDir, "desktop-alias.txt");
  await fs.symlink(file.path, alias);
  await store.claim({ files: [alias] });
  advance(RETENTION_MS + 1);
  await create().sweep();
  assert.equal(await fs.readFile(file.path, "utf8"), "hello");
});

test("upload refuses symlinked storage parents before writing any bytes", async (t) => {
  const { dataDir, create, request } = await fixture(t);
  const outside = path.join(dataDir, "originals");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(dataDir, "mobile-attachments"));
  await assert.rejects(create().upload(request), /symbolic link/);
  assert.deepEqual(await fs.readdir(outside), []);
});
