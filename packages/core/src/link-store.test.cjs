const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLinkStore } = require("./link-store.cjs");
const { stateFile, readProjectState } = require("./project-store.cjs");

test("Link persistence failures publish, survive reads, retry current state and never reach disk", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-link-save-"));
  const events = [];
  const store = createLinkStore({ dataDir, persistenceChanged: (id, state) => events.push({ id, state }), lazyMessages: { sweepMs: 0 } });
  t.after(async () => {
    await store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const id = "11111111-1111-4111-8111-111111111111";
  await store.update(id, (state) => ({ ...state, next_id: 2 }));
  await store.flush(id);
  const file = stateFile(store.directory(id));
  const backup = `${file}.check`;
  await fs.rename(file, backup);
  await fs.mkdir(file);
  try {
    await store.update(id, (state) => ({ ...state, next_id: 3 }));
    await assert.rejects(store.flush(id));
    assert.ok((await store.get(id)).persistence.error);
    assert.ok(events.at(-1).state.persistence.error);
    assert.equal((await store.get("22222222-2222-4222-8222-222222222222")).persistence, undefined);
  } finally {
    await fs.rmdir(file);
    await fs.rename(backup, file);
  }
  await store.retry(id);
  assert.equal(events.at(-1).state.persistence, undefined);
  const saved = await readProjectState(store.directory(id));
  assert.equal(saved.next_id, 3);
  assert.equal(saved.persistence, undefined);
});
