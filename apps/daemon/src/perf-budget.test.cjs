// Performance budgets on a large Project (#321): what #300 won back stays won. The Project is made up at test time
// (large-project-fixture.cjs), shaped like the big one #300 measured, so its sizes are the same on every machine and are
// held to byte budgets with a little headroom. A save's time depends on the machine and on what else runs beside it (a
// CI runner's disk is several times slower than a laptop's), so a save is held to what it writes, which is the same
// everywhere, and its time only to a loose ceiling.
//
// On the real Project these were, when this check was added: a save 6 to 7 ms, a lean desktop's state on open 2.63 MB
// before archived subagents went as summaries (0.32 MB after), a subagent update 26 KB (median). What this fixture gives
// is beside each budget. A budget that fails here means a change sends or saves more than it used to: find what grew
// before raising it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const store = require("@milagre/core/project-store");
const { startDaemon, formOf, agentEventAsTaken, eventFrame } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { largeProject } = require("./large-project-fixture.cjs");

// What the desktop asks the host for (apps/desktop/electron/daemon-runtime.cjs).
const DESKTOP = { messages: false, transcripts: false, archivedSubagents: false };

const BUDGET = {
  // The fixture's lean state on open, on read and nested in a reply: 2,845,987 bytes before archived subagents went as
  // summaries, 359,007 after.
  leanStateBytes: 395_000,
  // A running subagent's update, the whole event frame: median 28,077 bytes, largest 73,221.
  updateMedianBytes: 30_500,
  updateLargestBytes: 80_000,
  // An archived one's goes as a summary: a 452-byte frame at most.
  archivedUpdateLargestBytes: 1_000,
  // A save after one changed message writes that message's row and nothing else to chats.db, no sidecar, and a
  // coordination.json of 1,651,800 bytes (Chats, and subagents with their last entry; 1.4 MB on the real Project). Before
  // chats.db (#301), every save also wrote every message into that file.
  saveRowsWritten: 1,
  saveStateBytes: 1_800_000,
  // 3 to 7 ms on a laptop, tens of ms on a busy CI runner; only a save gone badly wrong takes this long.
  saveMedianMs: 1_000,
};

const median = (values) => values.toSorted((a, b) => a - b)[values.length >> 1];
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

async function tempProject(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-perf-budget-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, "project");
  await fs.mkdir(path.join(project, ".milagre"), { recursive: true });
  const state = largeProject({ projectPath: project });
  await fs.writeFile(path.join(project, ".milagre", "coordination.json"), JSON.stringify(state));
  return { directory, project, state };
}

test("a lean desktop opens the large Project within its budget", async (t) => {
  const { directory, project } = await tempProject(t);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const dataDir = path.join(directory, "profile");
  const daemon = await startDaemon({
    dataDir,
    version: "9.8.7",
    runtimeOptions: {
      cwd: project,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: "/fake/codex" }), { invalidate() {} }),
    },
  });
  let openBytes;
  let readBytes;
  let nestedBytes;
  const desktop = await connect({ dataDir });
  try {
    await desktop.call("daemon:state-patches", [DESKTOP]);
    const opened = await desktop.call("project:open", [project]);
    assert.equal(Object.keys(opened.state.sessions).length, 79);
    openBytes = bytes(opened.state);
    readBytes = bytes((await desktop.call("state:read", [project])).state);
    // worktree:create and the Linear link and unlink reply with the Project nested: `project: { path, name, state }`.
    nestedBytes = bytes((await desktop.call("worktree:unlink-issue", [{ projectPath: project, worktreeId: 1 }])).project.state);
  } finally {
    desktop.close();
    await daemon.close();
  }
  t.diagnostic(`lean state on open: ${openBytes} bytes (budget ${BUDGET.leanStateBytes}); on read: ${readBytes}; nested in a reply: ${nestedBytes}`);
  assert.ok(openBytes <= BUDGET.leanStateBytes, `opening sent ${openBytes} bytes of state, over the budget of ${BUDGET.leanStateBytes}`);
  assert.ok(readBytes <= BUDGET.leanStateBytes, `state:read sent ${readBytes} bytes of state, over the budget of ${BUDGET.leanStateBytes}`);
  assert.ok(nestedBytes <= BUDGET.leanStateBytes, `worktree:unlink-issue sent ${nestedBytes} bytes of state, over the budget of ${BUDGET.leanStateBytes}`);
});

test("a subagent update to a lean desktop stays within its budget", async (t) => {
  const { project } = await tempProject(t);
  const state = await store.readProjectState(project);
  const agents = Object.values(state.sessions).flatMap((session) => session.subagents ?? []);
  const form = formOf(DESKTOP);
  // The whole event frame the desktop reads for every subagent, as an update of a running child on the track, and as
  // an archived one's.
  const frame = (agent) => {
    const payload = { chatId: `${project}#2`, event: { type: "subagent-update", agent } };
    return eventFrame("agent:event", agentEventAsTaken("agent:event", payload, form) ?? payload, 1, Infinity).bytes;
  };
  const running = agents.map(({ archived: _archived, ...agent }) => frame({ ...agent, status: "running" }));
  const archived = agents.map((agent) => frame({ ...agent, archived: true }));
  t.diagnostic(`update median ${median(running)} bytes, largest ${Math.max(...running)}; archived largest ${Math.max(...archived)}`);
  assert.ok(median(running) <= BUDGET.updateMedianBytes, `the median update is ${median(running)} bytes, over ${BUDGET.updateMedianBytes}`);
  assert.ok(Math.max(...running) <= BUDGET.updateLargestBytes, `the largest update is ${Math.max(...running)} bytes, over ${BUDGET.updateLargestBytes}`);
  assert.ok(
    Math.max(...archived) <= BUDGET.archivedUpdateLargestBytes,
    `an archived subagent's update is ${Math.max(...archived)} bytes, over ${BUDGET.archivedUpdateLargestBytes}`,
  );
});

test("a save of the large Project after one change writes only that change", async (t) => {
  const { project } = await tempProject(t);
  let state = await store.readProjectState(project);
  state = await store.compactProjectState(project, state, null);
  // The first save moves the messages into chats.db and writes every transcript's sidecar; a routine one doesn't.
  await store.saveProjectState(project, state, { sweepMinAgeMs: 1e12 });
  await store.saveProjectState(project, state, { sweepMinAgeMs: 1e12 });
  // A streaming turn: the last message of one Chat replaced, as each delta of a reply does.
  const saves = [];
  for (let run = 0; run < 15; run++) {
    const last = state.messages.at(-1);
    const next = await store.compactProjectState(
      project,
      { ...state, messages: [...state.messages.slice(0, -1), { ...last, body: `${last.body} more` }] },
      state,
    );
    const started = performance.now();
    const wrote = await store.saveProjectState(project, next, { sweepMinAgeMs: 1e12 });
    saves.push(performance.now() - started);
    if (run === 0) t.diagnostic(`a save wrote ${JSON.stringify(wrote)}`);
    assert.ok(wrote.rowsWritten <= BUDGET.saveRowsWritten, `a save wrote ${wrote.rowsWritten} message rows for one changed message`);
    assert.equal(wrote.rowsRemoved, 0);
    assert.equal(wrote.sidecarsWritten, false, "a save wrote a sidecar though no transcript or tool output changed");
    assert.ok(wrote.stateBytes <= BUDGET.saveStateBytes, `a save wrote ${wrote.stateBytes} bytes of coordination.json, over ${BUDGET.saveStateBytes}`);
    state = next;
  }
  t.diagnostic(`save median ${median(saves).toFixed(1)} ms`);
  assert.ok(median(saves) <= BUDGET.saveMedianMs, `a save took ${median(saves).toFixed(1)} ms (median)`);
  // The saved Project reads back as it was.
  assert.equal((await store.readProjectState(project)).messages.at(-1).body, state.messages.at(-1).body);
});
