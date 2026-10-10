const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ProjectStates } = require("./project-states.cjs");
const { saveProjectState, readProjectState, compactProjectState, stateFile } = require("./project-store.cjs");
const { readMessages, dbFile } = require("./chat-db.cjs");
const { unloadedChats, wholeState, isFromDisk } = require("./message-store.cjs");

// Lazy message memory (#321): a Chat nobody touched for a while leaves memory, and chats.db is its only copy. These
// checks hold the rules that keep that safe: nothing on disk is lost, the order stays, and anything that names a Chat
// gets all of it.

async function tempProject(t) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-lazy-"));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  return projectPath;
}

const user = (id, session_id, body = `ask ${id}`) => ({ id, session_id, role: "user", body, context: null });
const reply = (id, session_id, body = `reply ${id}`) => ({ id, session_id, role: "assistant", body, context: null, outcome: "completed" });

/** Three Chats interleaved in the Project's array, saved, as a fresh run reads them. */
async function seed(projectPath, messages = [user(1, 1), user(2, 2), reply(3, 1), user(4, 3), reply(5, 2), reply(6, 3), user(7, 1), reply(8, 1)]) {
  const sessions = { 1: { id: 1, worktree_id: 1 }, 2: { id: 2, worktree_id: 1 }, 3: { id: 3, worktree_id: 1 } };
  await saveProjectState(projectPath, { next_id: 100, worktrees: { 1: { id: 1, path: projectPath } }, sessions, messages, tasks: {} });
  return messages;
}

function harness(projectPath, { active = () => false } = {}) {
  let now = 1_000_000;
  const states = new ProjectStates({
    read: (key) => readProjectState(key),
    save: (key, state) => saveProjectState(key, state),
    compact: compactProjectState,
    debounceMs: 0,
    messages: { directory: (key) => key, idleMs: 1000, sweepMs: 0, active, now: () => now },
  });
  return {
    states,
    advance: (ms) => (now += ms),
    /** Every message as a fresh run would read it from disk. */
    async onDisk() {
      return readMessages(projectPath);
    },
  };
}

const ids = (messages) => messages.map((message) => message.id);
const chatsOf = (messages) => new Set(messages.map((message) => message.session_id));

test("an idle Chat leaves memory once saved; a Chat touched lately and a busy one stay", async (t) => {
  const projectPath = await tempProject(t);
  await seed(projectPath);
  const busy = new Set([3]);
  const { states, advance } = harness(projectPath, { active: (_key, chat) => busy.has(chat) });
  await states.get(projectPath);
  advance(500);
  await states.load(projectPath, [2]);
  advance(600);
  await states.unloadIdle();
  const state = await states.get(projectPath);
  assert.deepEqual([...unloadedChats(state)], [1], "Chat 1 is idle; 2 was touched 600 ms ago; 3 is busy");
  assert.deepEqual(ids(state.messages), [2, 4, 5, 6]);
  assert.equal(state.sessions[1].summary.count, 4, "an unloaded Chat keeps its summary");
});

test("inbox reads keep only bounded last replies for unread outcomes, with loaded and unloaded Chats", async (t) => {
  const projectPath = await tempProject(t);
  const long = "x".repeat(10000);
  await seed(projectPath, [reply(1, 1, "older"), reply(2, 1, long), reply(3, 2, "failed reply"), reply(4, 3, "read reply")]);
  const { states, advance } = harness(projectPath);
  t.after(() => states.close());
  await states.update(projectPath, (state) => ({
    ...state,
    sessions: {
      ...state.sessions,
      1: { ...state.sessions[1], unread: true },
      2: { ...state.sessions[2], unread: true, summary: { ...state.sessions[2].summary, lastOutcome: "failed" } },
    },
  }));
  await states.flush();
  const before = await states.inboxState(projectPath);
  assert.deepEqual(
    before.messages.map(({ session_id, body }) => [session_id, body]),
    [
      [1, long.slice(0, 240)],
      [2, "failed reply"],
    ],
  );
  advance(2000);
  await states.load(projectPath, [2]);
  await states.unloadIdle();
  const after = await states.inboxState(projectPath);
  assert.deepEqual(
    after.messages.toSorted((a, b) => a.session_id - b.session_id),
    before.messages,
  );
  assert.deepEqual([...unloadedChats(await states.get(projectPath))], [1, 3]);
});

test("a save with unloaded Chats keeps their rows, and deletes only what a loaded Chat lost", async (t) => {
  const projectPath = await tempProject(t);
  const all = await seed(projectPath);
  const { states, advance, onDisk } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.load(projectPath, [2]);
  await states.unloadIdle();
  assert.deepEqual([...unloadedChats(await states.get(projectPath))].toSorted(), [1, 3]);
  // A change to Chat 2 only: take back its reply, add a message.
  await states.update(projectPath, (state) => ({ ...state, next_id: 101, messages: [...state.messages.filter((message) => message.id !== 5), user(100, 2)] }), {
    chats: [2],
  });
  await states.flush(projectPath);
  assert.deepEqual(ids(await onDisk()), [1, 2, 3, 4, 6, 7, 8, 100], "Chats 1 and 3 are untouched on disk; 5 is gone; 100 comes last");
  // A fresh run reads it back the same.
  const back = await readProjectState(projectPath);
  assert.deepEqual(ids(back.messages), [1, 2, 3, 4, 6, 7, 8, 100]);
  assert.deepEqual(
    back.messages.filter((message) => message.session_id !== 2),
    all.filter((message) => message.session_id !== 2),
  );
});

test("positions on disk stay 0..n-1 in the Project's order, as releases before this one write and read them", async (t) => {
  const projectPath = await tempProject(t);
  await seed(projectPath);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.load(projectPath, [1]);
  await states.unloadIdle();
  // Chat 1 in memory, 2 and 3 not: a message taken back from the middle and one re-sent at the end leave gaps.
  await states.update(
    projectPath,
    (state) => {
      const taken = state.messages.filter((message) => message.id !== 3);
      const resent = taken.find((message) => message.id === 1);
      return { ...state, messages: [...taken.filter((message) => message !== resent), reply(100, 1), resent] };
    },
    { chats: [1] },
  );
  await states.flush(projectPath);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbFile(projectPath));
  const rows = db.prepare("SELECT id, position FROM messages ORDER BY position").all();
  db.close();
  assert.deepEqual(
    rows.map((row) => row.position),
    rows.map((_row, index) => index),
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [2, 4, 5, 6, 7, 8, 100, 1],
  );
  // And the next save, with nothing moved, writes nothing: the map of saved rows follows the new numbers.
  const stats = { written: 0 };
  const { writeMessages } = require("./chat-db.cjs");
  const { savedRows } = require("./message-store.cjs");
  const state = await states.get(projectPath);
  await writeMessages(projectPath, state.messages, savedRows(projectPath), { keep: unloadedChats(state), stats });
  assert.equal(stats.written, 0);
});

test("a Chat loaded after the store forgot its saved rows (50 other Projects saved) still goes back in place", async (t) => {
  const { resetStore } = require("./message-store.cjs");
  const projectPath = await tempProject(t);
  const all = await seed(projectPath);
  const { states, advance, onDisk } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.load(projectPath, [1]);
  await states.unloadIdle();
  // What project-store does to the oldest Project once 50 others were saved this run.
  resetStore(projectPath);
  const back = await states.load(projectPath, [2, 3]);
  assert.deepEqual(back.messages, all);
  assert.deepEqual(ids(await states.allMessages(projectPath)), ids(all));
  await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, reply(100, 2)] }), { chats: [2] });
  await states.flush(projectPath);
  assert.deepEqual(ids(await onDisk()), [...ids(all), 100]);
});

test("50 other Projects saved don't make a Project with unloaded Chats forget its rows, even with a load during a save", async (t) => {
  const projectPath = await tempProject(t);
  const all = await seed(projectPath, [user(1, 1), user(2, 2), user(3, 3), reply(4, 1), reply(5, 2), reply(6, 3)]);
  let duringSave = () => {};
  let now = 1_000_000;
  const states = new ProjectStates({
    read: (key) => readProjectState(key),
    save: (key, state) => {
      const saving = saveProjectState(key, state);
      duringSave();
      return saving;
    },
    compact: compactProjectState,
    debounceMs: 0,
    messages: { directory: (key) => key, idleMs: 1000, sweepMs: 0, active: () => false, now: () => now },
  });
  await states.get(projectPath);
  now += 2000;
  await states.load(projectPath, [1]);
  await states.unloadIdle();
  // project-store remembers the saved rows of the last 50 Projects it saved.
  for (let index = 0; index < 51; index++) {
    const other = await tempProject(t);
    await saveProjectState(other, { next_id: 2, sessions: { 1: { id: 1 } }, messages: [user(1, 1)] });
  }
  // A change that reads no messages is saved, and Chat 2 loads while that save is under way.
  duringSave = () => {
    duringSave = () => {};
    void states.load(projectPath, [2]);
  };
  await states.update(projectPath, (state) => ({ ...state, next_id: 101 }), { chats: [] });
  await states.flush(projectPath);
  await states.load(projectPath, [2]);
  assert.deepEqual(ids(await states.allMessages(projectPath)), ids(all));
  await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, reply(100, 1)] }), { chats: [1] });
  await states.flush(projectPath);
  assert.deepEqual(ids(await readMessages(projectPath)), [...ids(all), 100]);
});

test("a store that forgot its rows anyway (read again) keeps a Chat loaded during a save in place", async (t) => {
  const projectPath = await tempProject(t);
  const all = await seed(projectPath, [user(1, 1), user(2, 2), user(3, 3), reply(4, 1), reply(5, 2), reply(6, 3)]);
  let duringSave = () => {};
  let now = 1_000_000;
  const states = new ProjectStates({
    read: (key) => readProjectState(key),
    save: (key, state) => {
      const saving = saveProjectState(key, state);
      duringSave();
      return saving;
    },
    compact: compactProjectState,
    debounceMs: 0,
    messages: { directory: (key) => key, idleMs: 1000, sweepMs: 0, active: () => false, now: () => now },
  });
  await states.get(projectPath);
  now += 2000;
  await states.load(projectPath, [1]);
  await states.unloadIdle();
  // As if the store were dropped while the state lives on: the saves and loads below fill its rows from chats.db.
  require("./message-store.cjs").resetStore(projectPath);
  // A change that reads no messages is saved, and Chat 2 loads while that save is under way.
  duringSave = () => {
    duringSave = () => {};
    void states.load(projectPath, [2]);
  };
  await states.update(projectPath, (state) => ({ ...state, next_id: 101 }), { chats: [] });
  await states.flush(projectPath);
  await states.load(projectPath, [2]);
  assert.deepEqual(ids(await states.allMessages(projectPath)), ids(all));
  await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, reply(100, 1)] }), { chats: [1] });
  await states.flush(projectPath);
  assert.deepEqual(ids(await readMessages(projectPath)), [...ids(all), 100]);
});

test("once no whole state was asked for in a minute, the cached whole states let go of their messages", async (t) => {
  const { forgetRest, REST_TTL_MS } = require("./message-store.cjs");
  const projectPath = await tempProject(t);
  const all = await seed(projectPath);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  const state = await states.get(projectPath);
  const whole = wholeState(state);
  assert.deepEqual(whole.messages, all);
  assert.equal(wholeState(state), whole, "cached while whole states are read");
  // The sweep's expiry, a minute after the last whole read: the state lives on (the runtime and the daemon hold it).
  forgetRest(projectPath, { now: Date.now() + REST_TTL_MS + 1 });
  const again = wholeState(state);
  assert.notEqual(again, whole, "the old whole state is no longer kept for this state");
  assert.deepEqual(again.messages, all);
});

test("a store is kept while its Project has unloaded Chats, and can be forgotten again once they are all back", async (t) => {
  const { forgetStore, savedRows } = require("./message-store.cjs");
  const projectPath = await tempProject(t);
  const all = await seed(projectPath);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  forgetStore(projectPath);
  assert.ok(savedRows(projectPath), "kept: Chats are unloaded");
  await states.load(projectPath, [1, 2]);
  forgetStore(projectPath);
  assert.ok(savedRows(projectPath), "kept: Chat 3 is still unloaded");
  await states.load(projectPath, [3]);
  forgetStore(projectPath);
  assert.equal(savedRows(projectPath), null, "forgotten once every Chat is back");
  assert.deepEqual((await states.get(projectPath)).messages, all);
  // It still saves and unloads correctly afterwards.
  await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, reply(100, 2)] }), { chats: [2] });
  await states.flush(projectPath);
  advance(2000);
  await states.unloadIdle();
  assert.deepEqual(ids(await states.allMessages(projectPath)), [...ids(all), 100]);
  assert.deepEqual(ids(await readMessages(projectPath)), [...ids(all), 100]);
});

test("a loaded Chat goes back to its place in the Project's order", async (t) => {
  const projectPath = await tempProject(t);
  const all = await seed(projectPath);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  assert.deepEqual((await states.get(projectPath)).messages, []);
  const loaded = await states.load(projectPath, [2, 1]);
  assert.deepEqual(ids(loaded.messages), [1, 2, 3, 5, 7, 8]);
  assert.ok(loaded.messages.every(isFromDisk));
  const whole = await states.load(projectPath, [3]);
  assert.deepEqual(whole.messages, all);
  assert.equal(unloadedChats(whole).size, 0);
});

test("a change that touches an unloaded Chat without naming it gets the whole Chat back", async (t) => {
  const projectPath = await tempProject(t);
  await seed(projectPath);
  const { states, advance, onDisk } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  // chats: [] promises no messages are read, then appends to Chat 1 anyway.
  const { state } = await states.update(projectPath, (latest) => ({ ...latest, messages: [...latest.messages, reply(100, 1)] }), { chats: [] });
  assert.deepEqual(ids(state.messages), [1, 3, 7, 8, 100]);
  assert.deepEqual([...unloadedChats(state)].toSorted(), [2, 3]);
  assert.equal(state.sessions[1].summary.count, 5, "its summary counts the whole Chat");
  await states.flush(projectPath);
  assert.deepEqual(ids(await onDisk()), [1, 2, 3, 4, 5, 6, 7, 8, 100]);
});

test("a change that names no Chats has every Chat loaded first", async (t) => {
  const projectPath = await tempProject(t);
  const all = await seed(projectPath);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  let seen;
  await states.update(projectPath, (state) => {
    seen = state.messages;
    return state;
  });
  assert.deepEqual(seen, all);
});

test("a Chat with anything not saved yet stays in memory", async (t) => {
  const projectPath = await tempProject(t);
  await seed(projectPath);
  const { states, advance, onDisk } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  // A message added and not saved: the sweep waits for the save.
  await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, reply(100, 2)] }), { chats: [2] });
  advance(2000);
  await states.unloadIdle();
  assert.equal(unloadedChats(await states.get(projectPath)).size, 0, "nothing is unloaded while a save is due");
  await states.flush(projectPath);
  await states.unloadIdle();
  assert.deepEqual([...unloadedChats(await states.get(projectPath))].toSorted(), [1, 2, 3]);
  const back = await states.load(projectPath, [2]);
  assert.deepEqual(ids(back.messages), [2, 5, 100]);
  assert.deepEqual(ids(await onDisk()), [1, 2, 3, 4, 5, 6, 7, 8, 100]);
});

test("a Chat removed while unloaded loses its rows, as it did when every Chat was in memory", async (t) => {
  const projectPath = await tempProject(t);
  await seed(projectPath);
  const { states, advance, onDisk } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  await states.update(
    projectPath,
    (state) => {
      const { 3: _gone, ...sessions } = state.sessions;
      return { ...state, sessions };
    },
    { chats: [] },
  );
  await states.flush(projectPath);
  assert.deepEqual(ids(await onDisk()), [1, 2, 3, 5, 7, 8]);
});

test("a Chat removed while unloaded is never read back, so its rows don't return after the save deletes them", async (t) => {
  const projectPath = await tempProject(t);
  await seed(projectPath);
  const { states, advance, onDisk } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  await states.update(
    projectPath,
    (state) => {
      const { 1: _gone, ...sessions } = state.sessions;
      return { ...state, sessions };
    },
    { chats: [] },
  );
  // Before the save: a stale page read of it, and a change that names no Chats (which loads every unloaded one).
  const read = await states.load(projectPath, [1]);
  assert.deepEqual(ids(read.messages), []);
  let seen;
  await states.update(projectPath, (state) => {
    seen = state.messages;
    return state;
  });
  assert.deepEqual(ids(seen), [2, 4, 5, 6]);
  assert.deepEqual(ids(await states.allMessages(projectPath)), [2, 4, 5, 6]);
  assert.deepEqual(ids(wholeState(await states.get(projectPath)).messages), [2, 4, 5, 6]);
  await states.flush(projectPath);
  assert.deepEqual(ids(await onDisk()), [2, 4, 5, 6]);
  await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, reply(100, 2)] }), { chats: [2] });
  await states.flush(projectPath);
  assert.deepEqual(ids(await onDisk()), [2, 4, 5, 6, 100]);
});

test("a whole state has every message in the Project's order, the same object for the same state", async (t) => {
  const projectPath = await tempProject(t);
  const all = await seed(projectPath);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.unloadIdle();
  const state = await states.load(projectPath, [3]);
  assert.deepEqual(ids(state.messages), [4, 6]);
  const whole = wholeState(state);
  assert.deepEqual(whole.messages, all);
  assert.equal(wholeState(state), whole);
  // The next state shares the cached rows, so a patch between the two whole states is small.
  const { state: next } = await states.update(projectPath, (latest) => ({ ...latest, messages: [...latest.messages, reply(100, 3)] }), { chats: [3] });
  const nextWhole = wholeState(next);
  assert.deepEqual(ids(nextWhole.messages), [...ids(all), 100]);
  assert.ok(whole.messages.every((message, index) => nextWhole.messages[index] === message));
  await states.flush(projectPath);
  // A message made in this run, unloaded while whole states are read (its object kept for them) and loaded back, is
  // one clients already have, like any message read back from chats.db.
  advance(2000);
  await states.unloadIdle();
  const back = await states.load(projectPath, [3]);
  const made = back.messages.find((message) => message.id === 100);
  assert.equal(made, nextWhole.messages.at(-1), "the same object, from the whole-state cache");
  assert.equal(isFromDisk(made), true);
});

test("reads across Chats see unloaded ones: every message, a search's bodies, a lookup by id or operation", async (t) => {
  const projectPath = await tempProject(t);
  const all = await seed(projectPath, [user(1, 1), { ...user(2, 2), operationId: "op-2" }, reply(3, 1, "needle here"), user(4, 3)]);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  advance(2000);
  await states.load(projectPath, [3]);
  await states.unloadIdle();
  assert.deepEqual(await states.allMessages(projectPath), all);
  assert.equal(unloadedChats(await states.get(projectPath)).size, 2, "reading every message loads nothing");
  assert.deepEqual(
    (await states.searchableMessages(projectPath, [1])).map((message) => [message.id, message.body]),
    [
      [1, "ask 1"],
      [3, "needle here"],
    ],
  );
  assert.deepEqual(await states.findMessage(projectPath, "id", 3), all[2]);
  assert.deepEqual(await states.findMessage(projectPath, "operationId", "op-2"), all[1]);
  assert.equal(await states.findMessage(projectPath, "operationId", "missing"), undefined);
});

test("a sweep of details sidecars keeps the ones unloaded Chats point at", async (t) => {
  const projectPath = await tempProject(t);
  const long = "x".repeat(5000);
  const withDetail = (id, session_id) => ({ ...reply(id, session_id), steps: [{ id: `s${id}`, kind: "shell", status: "done", detail: `${long}${id}` }] });
  await seed(projectPath, [withDetail(1, 1), withDetail(2, 2)]);
  const { states, advance } = harness(projectPath);
  const read = await states.get(projectPath);
  assert.ok(
    read.messages.every((message) => message.detailFile),
    "details moved to sidecars",
  );
  advance(2000);
  await states.load(projectPath, [2]);
  await states.unloadIdle();
  // A save that writes a new sidecar sweeps the folder.
  await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, withDetail(3, 2)] }), { chats: [2] });
  await states.flush(projectPath);
  // The sweep keeps young files; look at what it would remove by aging them all.
  const folder = path.join(projectPath, ".milagre", "details");
  const old = new Date(Date.now() - 3600_000);
  for (const name of await fs.readdir(folder)) await fs.utimes(path.join(folder, name), old, old);
  await saveProjectState(projectPath, { ...(await states.get(projectPath)) }, { sweepMinAgeMs: 0 });
  const whole = await states.allMessages(projectPath);
  const left = new Set(await fs.readdir(folder));
  for (const message of whole) assert.ok(left.has(message.detailFile), `the sidecar of message ${message.id} is kept`);
});

for (const fuzzSeed of [7, 11, 23, 42, 99, 123])
  test(`unloads, loads, saves, streaming and reads racing each other lose nothing and keep the order (seed ${fuzzSeed})`, async (t) => {
    await race(t, fuzzSeed);
  });

async function race(t, fuzzSeed) {
  // A seeded mix of operations fired without waiting for each other, against slow saves, checked against a model of
  // what the Project should hold.
  const projectPath = await tempProject(t);
  let model = await seed(projectPath);
  let rng = fuzzSeed;
  let sawUnloaded = 0;
  const random = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let now = 1_000_000;
  const states = new ProjectStates({
    read: (key) => readProjectState(key),
    save: async (key, state) => {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 4)));
      return saveProjectState(key, state);
    },
    compact: compactProjectState,
    debounceMs: 0,
    messages: { directory: (key) => key, idleMs: 5, sweepMs: 0, active: () => false, now: () => now },
  });
  await states.get(projectPath);
  let nextId = 100;
  const pending = [];
  const failures = [];
  for (let step = 0; step < 400; step++) {
    if (step === 200) {
      // Halfway, a quiet moment unloads every Chat for certain; the second half races against that.
      await Promise.all(pending.splice(0));
      await states.flush(projectPath);
      now += 100;
      await states.unloadIdle();
      const unloaded = unloadedChats(states.states.get(projectPath)).size;
      assert.ok(unloaded > 0, "a quiet Project unloads its idle Chats");
      sawUnloaded += unloaded;
    }
    const roll = random();
    const chat = 1 + Math.floor(random() * 3);
    if (roll < 0.35) {
      // A streamed reply lands in a Chat, named.
      const message = reply(nextId++, chat);
      model = [...model, message];
      pending.push(states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, message] }), { chats: [chat] }));
    } else if (roll < 0.45) {
      // A message changes in place (an image captured, a divider marked done).
      const target = model.filter((message) => message.session_id === chat).at(-1);
      if (!target) continue;
      model = model.map((message) => (message.id === target.id ? { ...message, body: `${message.body}!` } : message));
      pending.push(
        states.update(
          projectPath,
          (state) => ({ ...state, messages: state.messages.map((message) => (message.id === target.id ? { ...message, body: `${message.body}!` } : message)) }),
          { chats: [chat] },
        ),
      );
    } else if (roll < 0.5) {
      // A message taken back.
      const target = model.filter((message) => message.session_id === chat).at(-1);
      if (!target) continue;
      model = model.filter((message) => message.id !== target.id);
      pending.push(
        states.update(projectPath, (state) => ({ ...state, messages: state.messages.filter((message) => message.id !== target.id) }), { chats: [chat] }),
      );
    } else if (roll < 0.55) {
      // A change that doesn't say which Chat it touches.
      const message = user(nextId++, chat);
      model = [...model, message];
      pending.push(states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, message] }), { chats: [] }));
    } else if (roll < 0.75) {
      now += Math.floor(random() * 10);
      // Half the time the sweep comes after the saves settle, so Chats do go, with more operations racing behind it.
      const sweep = () =>
        states.unloadIdle().then(() => {
          if (unloadedChats(states.states.get(projectPath)).size) sawUnloaded++;
        });
      pending.push(random() < 0.5 ? sweep() : states.flush(projectPath).then(sweep));
    } else if (roll < 0.85) {
      const expected = model;
      pending.push(
        states.allMessages(projectPath).then((messages) => {
          try {
            assert.deepEqual(messages, expected);
          } catch (error) {
            failures.push(error);
          }
        }),
      );
    } else if (roll < 0.9) {
      pending.push(states.load(projectPath, [chat]));
    } else if (roll < 0.95) {
      const expected = model;
      pending.push(
        states.get(projectPath).then((state) => {
          try {
            if (unloadedChats(state).size) sawUnloaded++;
            assert.deepEqual(wholeState(state).messages, expected);
          } catch (error) {
            failures.push(error);
          }
        }),
      );
    } else if (roll < 0.975) {
      // A change that names no Chats sees every message.
      const expected = model;
      pending.push(
        states.update(projectPath, (state) => {
          try {
            assert.deepEqual(state.messages, expected);
          } catch (error) {
            failures.push(error);
          }
          return state;
        }),
      );
    } else pending.push(states.flush(projectPath));
    if (random() < 0.3) await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 3)));
  }
  await Promise.all(pending);
  await states.flush(projectPath);
  assert.deepEqual(failures, []);
  assert.deepEqual(await states.allMessages(projectPath), model);
  assert.deepEqual((await readProjectState(projectPath)).messages, model, "a fresh run reads exactly the model");
  assert.ok(sawUnloaded > 0, "Chats were unloaded along the way");
}

test("a Named Link's shared Chats leave memory the same way, under the Link's own folder", async (t) => {
  const { createLinkStore } = require("./link-store.cjs");
  const dataDir = await tempProject(t);
  const store = createLinkStore({ dataDir, active: () => false, lazyMessages: { idleMs: 0, sweepMs: 0 } });
  t.after(() => store.close());
  const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
  await store.update(id, (state) => ({
    ...state,
    next_id: 10,
    sessions: { 1: { id: 1, agent_name: "shared", worktrees: [] } },
    messages: [user(2, 1, "shared question"), { ...reply(3, 1), operationId: "op-3" }],
  }));
  await store.flush(id);
  await store.unloadIdle();
  assert.deepEqual((await store.get(id)).messages, []);
  assert.deepEqual(ids(await store.allMessages(id)), [2, 3]);
  assert.equal((await store.findMessage(id, "operationId", "op-3")).id, 3);
  // A change to the Link that reads no messages saves without touching the shared Chat's rows.
  await store.update(id, (state) => ({ ...state, preparations: { a: { chatId: 9, members: [] } } }), { chats: [] });
  await store.flush(id);
  assert.deepEqual(ids((await readProjectState(store.directory(id))).messages), [2, 3]);
});

test("a fresh run reads every Chat back: nothing is lost across unloads, loads and saves", async (t) => {
  const projectPath = await tempProject(t);
  await seed(projectPath);
  const { states, advance } = harness(projectPath);
  await states.get(projectPath);
  for (let round = 0; round < 5; round++) {
    advance(2000);
    await states.unloadIdle();
    const chat = (round % 3) + 1;
    await states.update(projectPath, (state) => ({ ...state, messages: [...state.messages, reply(200 + round, chat)] }), { chats: [chat] });
    await states.flush(projectPath);
  }
  const back = await readProjectState(projectPath);
  assert.deepEqual(ids(back.messages), [1, 2, 3, 4, 5, 6, 7, 8, 200, 201, 202, 203, 204]);
  for (const chat of [1, 2, 3]) assert.ok(chatsOf(back.messages).has(chat));
  assert.ok(JSON.parse(await fs.readFile(stateFile(projectPath), "utf8")).messages.storedIn, "coordination.json still points at chats.db");
  await fs.access(dbFile(projectPath));
});
