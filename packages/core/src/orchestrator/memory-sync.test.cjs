const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOrchestratorStore } = require("./store.cjs");
const { createMemorySync } = require("./memory-sync.cjs");

function storeAt(t, name, memory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `milagre-memory-sync-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrchestratorStore({ file: path.join(dir, "orchestrator.json") });
  store.update((current) => ({ ...current, memory: { ...current.memory, ...memory } }));
  return store;
}

const note = (id, text) => ({ id, text, group: "work", source: "Milagre", enabled: true, createdAt: 1 });

test("the newer memory wins on both computers in one exchange", async (t) => {
  const here = storeAt(t, "here", { notes: [note("a", "Short replies")], updatedAt: 200 });
  const there = storeAt(t, "there", { notes: [note("b", "Old note")], updatedAt: 100 });
  const thereSync = createMemorySync({ store: there, remote: null });
  const remote = { enabled: () => true, list: () => [{ id: "studio" }], invoke: async (_id, _method, [memory]) => thereSync.merge(memory) };
  const sync = createMemorySync({ store: here, remote });
  await sync.pushNow();
  assert.deepEqual(
    there.read().memory.notes.map((entry) => entry.text),
    ["Short replies"],
  );
  assert.equal(here.read().memory.updatedAt, 200);
});

test("an older memory from another computer is ignored, and the newer one comes back", async (t) => {
  const here = storeAt(t, "here", { notes: [note("a", "Mine")], updatedAt: 100 });
  const there = storeAt(t, "there", { notes: [note("b", "Newer elsewhere")], updatedAt: 300 });
  const thereSync = createMemorySync({ store: there, remote: null });
  const remote = { enabled: () => true, list: () => [{ id: "studio" }], invoke: async (_id, _method, [memory]) => thereSync.merge(memory) };
  await createMemorySync({ store: here, remote }).pushNow();
  assert.deepEqual(
    here.read().memory.notes.map((entry) => entry.text),
    ["Newer elsewhere"],
  );
  assert.deepEqual(
    there.read().memory.notes.map((entry) => entry.text),
    ["Newer elsewhere"],
  );
});

test("a change is pushed once after a pause, not on every write", (t) => {
  const store = storeAt(t, "debounce", { updatedAt: 1 });
  const timers = [];
  const sync = createMemorySync({ store, remote: { enabled: () => false }, schedule: (run) => timers.push(run) });
  store.update((current) => ({ ...current, memory: { ...current.memory, updatedAt: 2 } }));
  sync.changed();
  sync.changed();
  assert.equal(timers.length, 1);
});
