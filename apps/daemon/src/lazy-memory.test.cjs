const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { largeProject } = require("./large-project-fixture.cjs");
const { savedRows } = require("@milagre/core/message-store");

// Lazy message memory (#321) on the large Project #389 measures (79 Chats, 881 messages, 5.4 MB of them): once its
// Chats are idle the daemon holds none of their messages, and every reader still gets all 881, in order.
test("the large Project's idle Chats leave the daemon's memory, and every reader still gets every message", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-lazy-large-")));
  const dataDir = path.join(root, "profile");
  const project = path.join(root, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  await fs.mkdir(path.join(project, ".milagre"));
  const fixture = largeProject({ projectPath: project });
  await fs.writeFile(path.join(project, ".milagre/coordination.json"), JSON.stringify(fixture));
  const daemon = await startDaemon({
    dataDir,
    homeDir: dataDir,
    version: "test",
    runtimeOptions: {
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null, problem: "No provider in this check" }), { invalidate() {} }),
      lazyMessages: { idleMs: 0, sweepMs: 0 },
    },
  });
  const desktop = await connect({ dataDir });
  const older = await connect({ dataDir });
  t.after(async () => {
    desktop.close();
    older.close();
    await daemon.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await desktop.call("daemon:state-patches", [{ messages: false, transcripts: false }]);
  const opened = await desktop.call("project:open", [project]);
  const chats = Object.keys(opened.state.sessions).map(Number);
  // The first save moves the messages from coordination.json to chats.db; nothing leaves memory before that.
  await desktop.call("chat:patch", [project, chats[0], { title: "Large" }]);
  await desktop.call("daemon:flush");
  assert.equal(savedRows(project).size, fixture.messages.length);
  await daemon.unloadIdle();
  assert.equal(savedRows(project).size, 0, "no message of an idle Chat stays in memory");

  const ids = (messages) => messages.map((message) => message.id);
  const expected = ids(fixture.messages);
  assert.deepEqual(ids(await desktop.call("chat:all-messages", [project])), expected);
  assert.deepEqual(ids((await older.call("state:read", [project])).state.messages), expected, "an older desktop's whole state");
  const summaries = (await desktop.call("state:read", [project])).state.sessions;
  for (const chat of chats)
    assert.equal(summaries[chat].summary.count, fixture.messages.filter((message) => message.session_id === chat).length, `Chat ${chat}'s summary`);
  // Its finished subagents' transcripts left memory too: a client taking tails gets the same tails, an older one the
  // whole transcripts, and so does anyone opening one.
  const whole = (await older.call("state:read", [project])).state.sessions;
  const lean = (await desktop.call("state:read", [project])).state.sessions;
  for (const session of Object.values(fixture.sessions))
    for (const agent of session.subagents ?? []) {
      const taken = lean[session.id].subagents.find((item) => item.id === agent.id);
      const tail = agent.transcript.length > 4 ? [agent.transcript.slice(-4), agent.transcript.length] : [agent.transcript, undefined];
      assert.deepEqual([taken.transcript, taken.transcriptLength], tail);
      assert.deepEqual(whole[session.id].subagents.find((item) => item.id === agent.id).transcript, agent.transcript);
      assert.deepEqual((await desktop.call("chat:subagent", [project, session.id, agent.id])).transcript, agent.transcript);
    }
  // The long Chat reads back page by page, and only it comes back into memory.
  const longest = chats[0];
  const page = await desktop.call("chat:messages", [project, longest, { turns: 10 }]);
  assert.equal(page.total, fixture.messages.filter((message) => message.session_id === longest).length);
  assert.ok([...savedRows(project).values()].every((row) => row.chat === longest));
});

test("a state with every message for a client that takes transcript tails expires with the whole-state cache", async (t) => {
  const { leanState } = require("./server.cjs");
  const { ProjectStates } = require("@milagre/core/project-states");
  const { saveProjectState, readProjectState, compactProjectState } = require("@milagre/core/project-store");
  const { forgetRest, REST_TTL_MS, unloadedChats } = require("@milagre/core/message-store");
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-lean-expiry-")));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const messages = [1, 2, 3].map((id) => ({ id, session_id: id, role: "user", body: `ask ${id}`, context: null }));
  await saveProjectState(project, { next_id: 10, sessions: { 1: { id: 1 }, 2: { id: 2 }, 3: { id: 3 } }, messages, tasks: {} });
  let now = 1_000_000;
  const states = new ProjectStates({
    read: readProjectState,
    save: saveProjectState,
    compact: compactProjectState,
    debounceMs: 0,
    messages: { directory: (key) => key, idleMs: 1000, sweepMs: 0, active: () => false, now: () => now },
  });
  t.after(() => states.close());
  await states.get(project);
  now += 2000;
  await states.unloadIdle();
  const state = await states.get(project);
  assert.equal(unloadedChats(state).size, 3);
  const form = { messages: true, transcripts: false };
  const lean = leanState(state, form);
  assert.equal(lean.messages.length, 3);
  assert.equal(leanState(state, form), lean, "the same copy while whole states are read");
  // The expiry a minute after the last whole read: the state lives on, but no copy with every message stays for it.
  forgetRest(project, { now: Date.now() + REST_TTL_MS + 1 });
  const again = leanState(state, form);
  assert.notEqual(again, lean);
  assert.equal(again.messages.length, 3);
});
