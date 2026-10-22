const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createComputerCaches } = require("./computer-cache.cjs");

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computer-cache-"));
  let clock = 1000;
  const caches = createComputerCaches({ dir, now: () => ++clock });
  t.after(async () => {
    caches.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return { dir, caches };
}

test("a computer's lists, states and chat windows are kept in its own cache.sqlite, and read back", async (t) => {
  const { dir, caches } = await setup(t);
  caches.put(ID, "recent", "", [{ path: "/p", name: "p" }]);
  caches.put(ID, "scope", "/p", { name: "p", state: { sessions: { 1: { id: 1 } } } });
  caches.put(ID, "chat", "/p#1", { messages: [{ id: 1, body: "hi" }], hasMore: false, total: 1 });
  assert.deepEqual(caches.get(ID, "recent", ""), [{ path: "/p", name: "p" }]);
  assert.deepEqual(caches.get(ID, "scope", "/p"), { name: "p", state: { sessions: { 1: { id: 1 } } } });
  assert.deepEqual(caches.get(ID, "chat", "/p#1").messages, [{ id: 1, body: "hi" }]);
  assert.equal(caches.get(ID, "chat", "/p#2"), null);
  assert.ok((await fs.stat(path.join(dir, ID, "cache.sqlite"))).isFile());
});

test("only the last 20 opened chats are kept, and removing the computer deletes its folder", async (t) => {
  const { dir, caches } = await setup(t);
  for (let id = 1; id <= 25; id++) caches.put(ID, "chat", `/p#${id}`, { messages: [], hasMore: false, total: 0 });
  assert.equal(caches.get(ID, "chat", "/p#5"), null, "the oldest five are gone");
  assert.notEqual(caches.get(ID, "chat", "/p#6"), null);
  assert.notEqual(caches.get(ID, "chat", "/p#25"), null);
  caches.put(ID, "chat", "/p#6", { messages: [{ id: 6 }], hasMore: false, total: 1 });
  caches.put(ID, "chat", "/p#26", { messages: [], hasMore: false, total: 0 });
  assert.notEqual(caches.get(ID, "chat", "/p#6"), null, "opened again, it is recent again");
  assert.equal(caches.get(ID, "chat", "/p#7"), null);
  await caches.remove(ID);
  await assert.rejects(fs.stat(path.join(dir, ID)), { code: "ENOENT" });
  assert.equal(caches.get(ID, "chat", "/p#6"), null);
});

test("an id that isn't a computer's is refused, so no path leaves the cache folder", async (t) => {
  const { caches } = await setup(t);
  assert.throws(() => caches.put("../x", "recent", "", []), /computer/);
  await assert.rejects(caches.remove(".."), /computer/);
});

test("after close() a late put or get is a no-op and opens nothing", async (t) => {
  const { caches } = await setup(t);
  caches.put(ID, "recent", "", [1]);
  caches.close();
  caches.put(ID, "recent", "", [2]);
  assert.equal(caches.get(ID, "recent", ""), null);
  caches.close();
});

test("a garbage file is closed and rebuilt, not left open", async (t) => {
  const { dir, caches } = await setup(t);
  await fs.mkdir(path.join(dir, ID), { recursive: true });
  await fs.writeFile(path.join(dir, ID, "cache.sqlite"), "this is not a database, just text ".repeat(50));
  assert.throws(() => caches.put(ID, "recent", "", [1]));
  caches.put(ID, "recent", "", [3]);
  assert.deepEqual(caches.get(ID, "recent", ""), [3]);
});
