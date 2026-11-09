const assert = require("node:assert/strict");
const test = require("node:test");
const { ChatHost } = require("./chat-host.cjs");
const { ProjectStates } = require("../project-states.cjs");

const PROJECT = "/projects/recovery";
const CWD = "/worktrees/recovery";
const CHAT = `${PROJECT}#1`;
const child = (id, extra = {}) => ({ id, title: `Task ${id}`, status: "unknown", startedAt: 10, updatedAt: 100, transcript: [], ...extra });
const completed = (agent, status = "completed") => ({ type: "subagent-update", agent: { ...agent, status, updatedAt: 200, endedAt: 200 } });
const sessionEdit = (state, patch) => ({ ...state, sessions: { ...state.sessions, 1: { ...state.sessions[1], ...patch } } });
function projectState(agents = [child("child")]) {
  return {
    next_id: 3,
    projects: { 1: { id: 1, name: "Recovery" } },
    worktrees: { 1: { id: 1, name: "main", path: CWD } },
    sessions: { 1: { id: 1, worktree_id: 1, provider: "codex", native_session_id: "native-parent", status: "Idle", subagents: agents } },
    messages: [{ id: 2, session_id: 1, role: "user", body: "Review this change", context: null }],
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function harness({ state = projectState(), reader, loaded = true } = {}) {
  const reads = [],
    saved = [],
    broadcasts = [],
    published = [],
    started = [];
  const states = new ProjectStates({
    read: async (path) => {
      reads.push(path);
      return state;
    },
    save: async (path, next) => {
      saved.push({ path, state: next });
    },
  });
  if (loaded) await states.get(PROJECT);
  const host = new ChatHost({
    states,
    startTurn: async (request) => {
      started.push(request);
    },
    publish: (...args) => {
      published.push(args);
    },
    broadcast: (path, next) => {
      broadcasts.push({ path, state: next });
    },
    ...(reader ? { readSubagents: reader } : {}),
  });
  return { host, states, reads, saved, broadcasts, published, started };
}

test("recovery reads only eligible unknown children and saves terminal outcomes without a turn", async () => {
  const oldEntry = { id: "partial", kind: "message", text: "Partial result" };
  const eligible = [child("done", { transcript: [oldEntry] }), child("failed"), child("cancelled")];
  const excluded = [
    child("archived", { archived: true }),
    child("running", { status: "running" }),
    child("finished", { status: "completed" }),
    child("native-parent"),
    child("advisor:owned", { source: "milagre-advisor" }),
  ];
  const state = projectState([...eligible, ...excluded]);
  const calls = [];
  const recovered = eligible.map((agent, index) => completed(agent, ["completed", "failed", "cancelled"][index]));
  recovered[0].agent.transcript = [{ id: "final", kind: "message", text: "Final result" }];
  const { host, states, saved, broadcasts, published, started } = await harness({
    state,
    reader: async (request) => {
      calls.push(request);
      return recovered;
    },
  });

  await host.recoverSubagents(CHAT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, CWD);
  assert.deepEqual(
    calls[0].agents.map((agent) => agent.id),
    ["done", "failed", "cancelled"],
  );
  calls[0].agents.forEach((agent, index) => assert.equal(agent, eligible[index]));
  const next = await states.get(PROJECT);
  const children = next.sessions[1].subagents;
  assert.deepEqual(
    children.slice(0, 3).map((agent) => agent.status),
    ["completed", "failed", "cancelled"],
  );
  assert.deepEqual(children[0].transcript, [oldEntry, recovered[0].agent.transcript[0]]);
  for (const untouched of excluded.filter((agent) => agent.id !== "native-parent"))
    assert.equal(
      children.find((agent) => agent.id === untouched.id),
      untouched,
    );
  await states.flush(PROJECT);
  assert.equal(saved.length, 1);
  assert.deepEqual(broadcasts, [{ path: PROJECT, state: next }]);
  assert.equal(next.messages, state.messages);
  assert.equal(next.next_id, state.next_id);
  assert.deepEqual(started, []);
  assert.deepEqual(published, []);
  assert.deepEqual(host.snapshot(), { runs: {}, seq: 0 });
});

test("simultaneous refreshes share one read and an empty result can be retried", async () => {
  const reading = deferred(),
    entered = deferred();
  let calls = 0;
  const { host, saved, broadcasts } = await harness({
    reader: async () => {
      calls++;
      entered.resolve();
      return reading.promise;
    },
  });
  const first = host.recoverSubagents(CHAT);
  const second = host.recoverSubagents(CHAT);
  await entered.promise;
  assert.equal(calls, 1);
  reading.resolve([]);
  await Promise.all([first, second]);
  assert.deepEqual(saved, []);
  assert.deepEqual(broadcasts, []);
  await host.recoverSubagents(CHAT);
  assert.equal(calls, 2);
});

test("reader errors propagate to all waiters and clear the pending recovery for retry", async () => {
  const failed = deferred(),
    entered = deferred();
  const problem = new Error("Provider history is unavailable");
  let calls = 0;
  const { host, states, saved, broadcasts } = await harness({
    reader: async ({ agents }) => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        return failed.promise;
      }
      return [completed(agents[0])];
    },
  });
  const first = host.recoverSubagents(CHAT),
    second = host.recoverSubagents(CHAT);
  const firstFailure = assert.rejects(first, (error) => error === problem);
  const secondFailure = assert.rejects(second, (error) => error === problem);
  await entered.promise;
  failed.reject(problem);
  await Promise.all([firstFailure, secondFailure]);
  assert.equal(calls, 1);
  assert.equal((await states.get(PROJECT)).sessions[1].subagents[0].status, "unknown");
  assert.deepEqual(saved, []);
  assert.deepEqual(broadcasts, []);
  await host.recoverSubagents(CHAT);
  assert.equal(calls, 2);
  assert.equal((await states.get(PROJECT)).sessions[1].subagents[0].status, "completed");
  assert.equal(broadcasts.length, 1);
});

test("the optional reader defaults to leaving saved state unchanged", async () => {
  const { host, saved, broadcasts } = await harness();
  await host.recoverSubagents(CHAT);
  assert.deepEqual(saved, []);
  assert.deepEqual(broadcasts, []);
});

test("ineligible chats never read provider history", async (t) => {
  const cases = [
    ["project not loaded", (state) => state, { loaded: false }],
    ["chat missing", (state) => ({ ...state, sessions: {} })],
    ["different provider", (state) => sessionEdit(state, { provider: "claude" })],
    ["native session missing", (state) => sessionEdit(state, { native_session_id: undefined })],
    ["chat archived", (state) => sessionEdit(state, { archived: true })],
    ["worktree missing", (state) => ({ ...state, worktrees: {} })],
    ["worktree path missing", (state) => ({ ...state, worktrees: { 1: { id: 1 } } })],
    ["only archived unknown children", (state) => sessionEdit(state, { subagents: [child("archived", { archived: true })] })],
    ["only known children", (state) => sessionEdit(state, { subagents: [child("running", { status: "running" }), child("done", { status: "completed" })] })],
    ["parent is the only unknown entry", (state) => sessionEdit(state, { subagents: [child("native-parent")] })],
    [
      "turn running",
      (state) => state,
      {},
      (host) => {
        host.runs[CHAT] = { text: "Working" };
      },
    ],
    [
      "host quitting",
      (state) => state,
      {},
      (host) => {
        host.quitting = true;
      },
    ],
  ];
  for (const [name, prepare, options, configure] of cases)
    await t.test(name, async () => {
      let calls = 0;
      const { host, reads, saved, broadcasts } = await harness({
        state: prepare(projectState()),
        ...options,
        reader: async () => {
          calls++;
          return [];
        },
      });
      configure?.(host);
      await host.recoverSubagents(CHAT);
      assert.equal(calls, 0);
      assert.deepEqual(saved, []);
      assert.deepEqual(broadcasts, []);
      if (options?.loaded === false) assert.deepEqual(reads, []);
    });
});

test("chat identity and lifecycle changes during a read discard the recovered snapshot", async (t) => {
  const cases = [
    ["native session changed", (state) => sessionEdit(state, { native_session_id: "replacement-native" })],
    ["provider changed", (state) => sessionEdit(state, { provider: "claude" })],
    ["chat archived", (state) => sessionEdit(state, { archived: true })],
    ["chat removed", (state) => ({ ...state, sessions: {} })],
    ["worktree removed", (state) => ({ ...state, worktrees: {} })],
    ["worktree path changed", (state) => ({ ...state, worktrees: { 1: { ...state.worktrees[1], path: "/worktrees/replacement" } } })],
    [
      "worktree identity changed at the same path",
      (state) => ({ ...sessionEdit(state, { worktree_id: 2 }), worktrees: { ...state.worktrees, 2: { id: 2, path: CWD } } }),
    ],
    [
      "turn starts",
      (state) => state,
      (host) => {
        host.runs[CHAT] = { text: "New turn" };
      },
    ],
    [
      "host starts quitting",
      (state) => state,
      (host) => {
        host.quitting = true;
      },
    ],
  ];
  for (const [name, change, configure] of cases)
    await t.test(name, async () => {
      const reading = deferred(),
        entered = deferred();
      const { host, states, saved, broadcasts } = await harness({
        reader: async (request) => {
          entered.resolve(request);
          return reading.promise;
        },
      });
      const pending = host.recoverSubagents(CHAT);
      const request = await entered.promise;
      await states.update(PROJECT, change);
      configure?.(host);
      const latest = await states.get(PROJECT);
      const savesBeforeRecovery = saved.length;
      reading.resolve([completed(request.agents[0])]);
      await pending;
      assert.equal(await states.get(PROJECT), latest);
      assert.equal(saved.length, savesBeforeRecovery);
      assert.deepEqual(broadcasts, []);
    });
});

test("new child objects and archives win while unchanged siblings can still recover", async (t) => {
  const cases = [
    ["live child update", (agent) => ({ ...agent, status: "running", latestActivity: "New live activity", updatedAt: 201 })],
    ["same-status replacement", (agent) => ({ ...agent, latestActivity: "New unknown activity" })],
    ["child archived", (agent) => ({ ...agent, archived: true })],
    ["child removed", () => null],
  ];
  for (const [name, changeChild] of cases)
    await t.test(name, async () => {
      const reading = deferred(),
        entered = deferred();
      const { host, states, broadcasts } = await harness({
        state: projectState([child("changed"), child("unchanged")]),
        reader: async (request) => {
          entered.resolve(request);
          return reading.promise;
        },
      });
      const pending = host.recoverSubagents(CHAT);
      const request = await entered.promise;
      let replacement;
      await states.update(PROJECT, (state) => {
        replacement = changeChild(state.sessions[1].subagents[0]);
        return sessionEdit(state, { subagents: [replacement, state.sessions[1].subagents[1]].filter(Boolean) });
      });
      reading.resolve(request.agents.map((agent) => completed(agent)));
      await pending;
      const agents = (await states.get(PROJECT)).sessions[1].subagents;
      assert.equal(
        agents.find((agent) => agent.id === "changed"),
        replacement ?? undefined,
      );
      assert.equal(agents.find((agent) => agent.id === "unchanged").status, "completed");
      assert.equal(broadcasts.length, 1);
    });
});

test("unrelated edits survive recovery instead of replacing the latest project state", async () => {
  const reading = deferred(),
    entered = deferred();
  const { host, states, broadcasts } = await harness({
    reader: async (request) => {
      entered.resolve(request);
      return reading.promise;
    },
  });
  const pending = host.recoverSubagents(CHAT);
  const request = await entered.promise;
  await states.update(PROJECT, (state) => sessionEdit(state, { title: "Renamed during history read", unread: true }));
  reading.resolve([completed(request.agents[0])]);
  await pending;
  const session = (await states.get(PROJECT)).sessions[1];
  assert.equal(session.title, "Renamed during history read");
  assert.equal(session.unread, true);
  assert.equal(session.subagents[0].status, "completed");
  assert.equal(broadcasts.length, 1);
});

test("nonterminal, unrelated, and older events do not save or broadcast unchanged state", async () => {
  const { host, states, saved, broadcasts, published, started } = await harness({
    reader: async ({ agents }) => [
      { type: "turn-started", turnId: "unexpected" },
      completed(child("unrequested")),
      { type: "subagent-update", agent: { ...agents[0], status: "running", updatedAt: 300 } },
      { type: "subagent-update", agent: { ...agents[0], status: "completed", updatedAt: 99 } },
    ],
  });
  const before = await states.get(PROJECT);
  await host.recoverSubagents(CHAT);
  assert.equal(await states.get(PROJECT), before);
  assert.deepEqual(saved, []);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(published, []);
  assert.deepEqual(started, []);
  assert.deepEqual(host.snapshot(), { runs: {}, seq: 0 });
});

test("an Antigravity chat recovers its unknown children from the transcripts, passing the provider and native session", async () => {
  const calls = [];
  const agy = projectState();
  const { host, states } = await harness({
    state: sessionEdit(agy, { provider: "antigravity", native_session_id: "agy-parent" }),
    reader: async (request) => {
      calls.push(request);
      return request.agents.map((agent) => completed(agent));
    },
  });
  await host.recoverSubagents(CHAT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "antigravity");
  assert.equal(calls[0].nativeSessionId, "agy-parent");
  assert.equal(calls[0].cwd, CWD);
  assert.equal((await states.get(PROJECT)).sessions[1].subagents[0].status, "completed");
});
