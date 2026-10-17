const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { runTool } = require("./linked-tools.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

// waitUntil for a check that reads through the runtime.
async function eventually(check, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A runtime with one Chat on a fake agent, the routine clock and timer in the test's hands.
// `restart` ({ dir, clock }) starts a second runtime on the data an earlier one left, as Milagre does after a quit: it
// sends nothing of its own.
async function fixture(t, { enable = true, restart, open = true } = {}) {
  const dir = restart?.dir ?? (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runtime-routines-"))));
  const project = path.join(dir, "project");
  if (!restart) {
    await fs.mkdir(project);
    execFileSync("git", ["init", "-qb", "main", project]);
    // A commit to branch Worktrees from.
    execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
  }
  const sessions = [];
  const emitted = [];
  // What publishAgentEvent hands on, with whether the Chat's run still held its streamed text at that moment.
  const published = [];
  let clock = restart?.clock ?? Date.UTC(2026, 9, 16, 12, 0);
  let tickFn = null;
  let runtime;
  runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    cwd: project,
    worktreeRoot: path.join(dir, "worktrees"),
    // The Project registry lists only what the test opens, not folders found on this Mac.
    registryRoots: [],
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    observeAgentEvent: (chatId, event) =>
      published.push({ chatId, type: event.type, quiet: event.quiet, runText: runtime?.snapshot().runs.runs[chatId]?.text }),
    routines: {
      now: () => clock,
      setInterval: (fn) => {
        tickFn = fn;
        return { unref() {} };
      },
      clearInterval: () => {
        tickFn = null;
      },
    },
    createSession(provider, options) {
      const session = {
        provider,
        options,
        turns: [],
        turnActive: false,
        startTurn: async (request) => {
          session.turns.push(request);
          session.turnActive = true;
          // A native session, so the next turn resumes it instead of restoring the Chat from a brief.
          if (session.turns.length === 1) options.emit({ type: "session-started", nativeId: "native-1" });
          options.emit({ type: "turn-started", turnId: `turn-${session.turns.length}` });
          return { turnId: `turn-${session.turns.length}` };
        },
        interrupt: async () => {
          session.turnActive = false;
          options.emit({ type: "turn-cancelled" });
        },
        setPermissionMode: async (mode) => {
          if (session.failMode) throw new Error("the agent didn't take the mode");
          session.mode = mode;
        },
        close: async () => {},
        // Each string streams as text; a tool step runs between consecutive ones, as an agent's turn reads.
        finish: (...texts) => {
          session.turnActive = false;
          texts.forEach((text, index) => {
            if (index > 0) {
              const id = `step-${session.turns.length}-${index}`;
              options.emit({ type: "step-started", step: { id, kind: "shell", title: "Ran `gh pr checks`" } });
              options.emit({ type: "step-completed", id, status: "done" });
            }
            options.emit({ type: "text-delta", messageId: `reply-${session.turns.length}`, text });
          });
          options.emit({ type: "turn-completed" });
        },
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    if (!restart) await fs.rm(dir, { recursive: true, force: true });
  });
  if (enable && !restart) assert.deepEqual(await runtime.invoke("routines:enabled:save", [true]), { enabled: true });
  // `open: false` leaves the Project as a restart leaves it: listed, not opened by anyone yet.
  const opened = open ? await runtime.openProject(project) : null;
  const id = opened ? Object.values(opened.state.sessions)[0].id : null;
  const chatId = `${project}#${id}`;
  if (!restart) {
    await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "Watch CI", provider: "claude", model: "cm", permissionMode: "full" }]);
    await waitUntil(() => sessions.length === 1 && sessions[0].turns.length === 1);
  }
  const session = sessions[0];
  const messages = async () => (await runtime.invoke("project:snapshot", [project])).state.messages.filter((m) => m.session_id === id);
  const tool = (name) => session.options.linked.tools.find((item) => item.name === name);
  const list = async () => (await runtime.invoke("routines:list")).routines;
  const ends = () => published.filter((item) => item.type === "turn-completed").length;
  const finish = async (...texts) => {
    const before = ends();
    session.finish(...texts);
    await waitUntil(() => ends() > before);
  };
  // Moves the routine clock past the next beat and runs one tick, then waits for what it dispatched to settle.
  const beat = async () => {
    const [routine] = await list();
    clock = routine.nextRunAt + 1000;
    assert.ok(tickFn, "the scheduler is ticking");
    tickFn();
  };
  return {
    runtime,
    dir,
    project,
    id,
    chatId,
    session,
    sessions,
    emitted,
    published,
    messages,
    tool,
    list,
    finish,
    beat,
    advance: (ms) => (clock += ms),
    clock: () => clock,
    ticking: () => tickFn !== null,
    dataDir: path.join(dir, "data"),
    tick: () => tickFn?.(),
  };
}

const latestRun = async (f) => (await f.list())[0]?.runs[0];

test("the switch is off by default: no routine tools and no ticks", async (t) => {
  const f = await fixture(t, { enable: false });
  assert.deepEqual(await f.runtime.invoke("routines:enabled:read"), { enabled: false });
  assert.equal(f.tool("heartbeat_create"), undefined);
  assert.equal(f.tool("routine_list"), undefined);
  assert.deepEqual(await f.list(), []);
  await assert.rejects(f.runtime.invoke("routines:run-now", ["missing"]), /Routines are off/);
});

test("a heartbeat an agent sets fires into its Chat, and a (pass) reply ends quiet", async (t) => {
  const f = await fixture(t);
  assert.ok(
    f.emitted.some((item) => item.channel === "routines:changed"),
    "saving the switch says so",
  );
  const created = await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI on PR 77", every: "5m" });
  assert.equal(created.isError, false, created.text);
  const [routine] = await f.list();
  assert.equal(routine.name, "Babysit");
  assert.equal(routine.target.chatId, f.chatId);
  assert.equal(routine.provider, "claude");
  assert.equal(routine.permissionMode, "full");
  assert.deepEqual(routine.runs, []);
  assert.ok(f.emitted.filter((item) => item.channel === "routines:changed").length >= 2, "a tool's write says so too");
  await f.finish("Watching.");

  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  const divider = (await f.messages()).findLast((message) => message.role === "user");
  assert.equal(divider.context.kind, "routine-run");
  assert.equal(divider.context.routineId, routine.id);
  assert.equal(divider.context.name, "Babysit");
  assert.equal(divider.body, "Check CI on PR 77");
  assert.match(f.session.turns[1].prompt, /^Check CI on PR 77\n\nIf nothing needs doing, reply starting with "\(pass\)"/);
  assert.equal(f.session.turns[1].model, "cm");
  assert.equal(f.session.turns[1].permissionMode, "full");
  // Ruling 1: the routine's turn-started goes through publishAgentEvent.
  assert.ok(f.published.filter((item) => item.type === "turn-started").length >= 2);
  assert.equal((await latestRun(f)).status, "running");

  await f.finish("(pass) CI green");
  await eventually(async () => (await latestRun(f)).status === "quiet");
  const run = await latestRun(f);
  assert.equal(run.summary, "CI green");
  assert.equal(run.chatId, f.chatId);
  const end = f.published.findLast((item) => item.type === "turn-completed");
  // The terminal event is marked before anyone hears it, and the streamed run is already folded away by then (ruling 2).
  assert.equal(end.quiet, true);
  assert.equal(end.runText, undefined);
  await eventually(async () => (await f.messages()).find((message) => message.id === divider.id).context.quiet === true);
  const patched = (await f.messages()).find((message) => message.id === divider.id);
  assert.equal(patched.context.summary, "CI green");
  assert.equal(patched.context.runId, run.id);

  // The next beat acts: no quiet mark on its end.
  await f.beat();
  await waitUntil(() => f.session.turns.length === 3);
  await f.finish("CI failed, fixing the test.");
  await eventually(async () => (await latestRun(f)).status === "acted");
  assert.equal(f.published.findLast((item) => item.type === "turn-completed").quiet, undefined);
  const acted = (await f.messages()).findLast((message) => message.context?.kind === "routine-run");
  await eventually(async () => (await f.messages()).find((message) => message.id === acted.id).context.quiet === false);
});

test("a beat while the Chat's turn runs is skipped busy", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  // The first turn is still running.
  await f.beat();
  await eventually(async () => (await latestRun(f))?.status === "skipped-busy");
  assert.equal(f.session.turns.length, 1);
});

test("archiving the Chat ends its heartbeats", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("ok");
  assert.equal((await f.list()).length, 1);
  await f.runtime.invoke("chat:patch", [f.project, f.id, { archived: true }]);
  assert.deepEqual(await f.list(), []);
});

test("commands update, run now and delete a routine, each saying routines changed", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("ok");
  const [routine] = await f.list();
  const changes = () => f.emitted.filter((item) => item.channel === "routines:changed").length;

  let before = changes();
  const updated = await f.runtime.invoke("routines:update", [routine.id, { prompt: "Check CI and deploys" }]);
  assert.equal(updated.prompt, "Check CI and deploys");
  assert.ok(changes() > before);

  before = changes();
  const run = await f.runtime.invoke("routines:run-now", [routine.id]);
  assert.equal(run.status, "running");
  assert.ok(changes() > before);
  await waitUntil(() => f.session.turns.length === 2);
  await f.finish("(pass) nothing new");
  await eventually(async () => (await latestRun(f)).status === "quiet");

  before = changes();
  assert.deepEqual(await f.runtime.invoke("routines:delete", [routine.id]), { removed: true });
  assert.ok(changes() > before);
  assert.deepEqual(await f.list(), []);
  await assert.rejects(f.runtime.invoke("routines:update", [routine.id, { prompt: "x" }]), /Routine not found/);

  // Off again: the tools go, and the tick stops acting.
  assert.deepEqual(await f.runtime.invoke("routines:enabled:save", [false]), { enabled: false });
  assert.deepEqual(await f.runtime.invoke("routines:enabled:read"), { enabled: false });
});

test("a beat that checks with a tool, then ends with (pass), is quiet; a (pass) followed by real work acts", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("ok");
  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  await f.finish("Let me check CI.", "(pass) CI green");
  await eventually(async () => (await latestRun(f)).status === "quiet");
  assert.equal((await latestRun(f)).summary, "CI green");
  assert.equal(f.published.findLast((item) => item.type === "turn-completed").quiet, true);

  await f.beat();
  await waitUntil(() => f.session.turns.length === 3);
  await f.finish("(pass) looks fine at first.", "Actually CI failed, fixing the test.");
  await eventually(async () => (await latestRun(f)).status === "acted");
  assert.equal(f.published.findLast((item) => item.type === "turn-completed").quiet, undefined);
});

test("a live session's routine tools stop working once the switch is off", async (t) => {
  const f = await fixture(t);
  assert.equal((await runTool(f.tool("routine_list"), {})).isError, false);
  await f.runtime.invoke("routines:enabled:save", [false]);
  for (const [name, args] of [
    ["routine_list", {}],
    ["heartbeat_create", { name: "Babysit", prompt: "Check CI", every: "5m" }],
  ]) {
    const result = await runTool(f.tool(name), args);
    assert.equal(result.isError, true, name);
    assert.equal(result.text, "Routines are turned off in Settings › Experimental.");
  }
  assert.deepEqual(await f.list(), []);
});

test("a quiet beat leaves the Chat's unread mark as it was; a beat that acts marks it unread", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("Watching.");
  const unread = async () => (await f.runtime.invoke("project:snapshot", [f.project])).state.sessions[f.id].unread === true;
  await eventually(unread);
  await f.runtime.invoke("chat:patch", [f.project, f.id, { unread: false }]);
  assert.equal(await unread(), false);

  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  await f.finish("(pass) CI green");
  await eventually(async () => (await f.messages()).findLast((message) => message.context?.kind === "routine-run").context.quiet === true);
  assert.equal(await unread(), false, "a quiet beat leaves no unread mark");

  await f.beat();
  await waitUntil(() => f.session.turns.length === 3);
  await f.finish("CI failed, fixing the test.");
  await eventually(async () => (await latestRun(f)).status === "acted");
  assert.equal(await unread(), true, "a beat that acts marks the Chat unread");
});

// A Routine that starts a Chat of its own every 5 minutes, made through the command the Routines form uses.
async function createTriage(f, workspace = "worktree") {
  const { routine } = await f.runtime.invoke("routines:create", [
    {
      name: "Morning triage",
      prompt: "Triage the inbox on {{date}}",
      trigger: { kind: "schedule", cron: "*/5 * * * *", timezone: "UTC" },
      target: { kind: "new-chat", projectPath: f.project, workspace },
    },
  ]);
  return routine;
}
const snapshot = async (f) => (await f.runtime.invoke("project:snapshot", [f.project])).state;
// The Run's Chat, once its agent has the first message.
async function runChat(f) {
  await waitUntil(() => f.sessions.length === 2 && f.sessions[1].turns.length === 1, { timeoutMs: 10_000 });
  const state = await snapshot(f);
  const session = Object.values(state.sessions).find((item) => item.routine);
  return { state, session, agent: f.sessions[1], chatId: `${f.project}#${session.id}` };
}

test("a schedule Routine starts a Chat of its own in a new Worktree; a quiet Run archives it and removes the clean Worktree", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const before = Object.keys((await snapshot(f)).worktrees).length;
  const routine = await createTriage(f);
  assert.equal(routine.createdBy.kind, "user");
  assert.ok(f.emitted.some((item) => item.channel === "routines:changed"));
  await f.beat();
  const { state, session, agent, chatId } = await runChat(f);
  assert.equal(Object.keys(state.worktrees).length, before + 1, "one new Worktree");
  const run = await latestRun(f);
  assert.deepEqual(session.routine, { routineId: routine.id, runId: run.id });
  assert.equal(session.title, "Morning triage");
  assert.notEqual(state.worktrees[session.worktree_id].path, f.project);
  const first = state.messages.find((message) => message.session_id === session.id && message.role === "user");
  assert.equal(first.context.kind, "routine-run");
  assert.equal(first.context.label, "Routine · Morning triage");
  assert.equal(first.body, "Triage the inbox on 2026-10-16");
  assert.match(agent.turns[0].prompt, /^Triage the inbox on 2026-10-16\n\nIf nothing needs doing/);
  assert.equal(agent.turns[0].permissionMode, "auto");
  assert.equal(run.chatId, chatId);

  // No recursion: the Run's agent can't make or start Routines.
  const names = agent.options.linked.tools.map((tool) => tool.name);
  for (const name of ["heartbeat_create", "routine_create", "routine_run_now"]) assert.ok(!names.includes(name), name);
  assert.ok(f.tool("heartbeat_create"), "the Chat the user started keeps them");

  const worktreeId = session.worktree_id;
  agent.finish("(pass) inbox empty");
  await eventually(async () => (await latestRun(f)).status === "quiet");
  await eventually(async () => !(await snapshot(f)).worktrees[worktreeId], { timeoutMs: 10_000 });
});

test("a quiet Run keeps a Worktree with uncommitted work", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  await createTriage(f);
  await f.beat();
  const { state, session, agent } = await runChat(f);
  const worktree = state.worktrees[session.worktree_id];
  await fs.writeFile(path.join(worktree.path, "notes.md"), "keep me\n");
  agent.finish("(pass) nothing to do");
  await eventually(async () => (await snapshot(f)).sessions[session.id]?.archived === true);
  // The archive and its removal check are the scheduler's work off the tick: idle once they are done.
  await f.runtime.routines.idle();
  const latest = await snapshot(f);
  assert.ok(latest.worktrees[session.worktree_id], "the Worktree stays");
  await fs.access(path.join(worktree.path, "notes.md"));
});

test("a Routine on the Project folder makes no Worktree", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const before = Object.keys((await snapshot(f)).worktrees).length;
  await createTriage(f, "project");
  await f.beat();
  const { state, session } = await runChat(f);
  assert.equal(Object.keys(state.worktrees).length, before);
  assert.equal(state.worktrees[session.worktree_id].path, f.project);
  assert.notEqual(session.id, f.id);
});

test("routines:targets lists the registered Projects with their Chats", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const { projects } = await f.runtime.invoke("routines:targets");
  const project = projects.find((item) => item.path === f.project);
  assert.ok(project, "the Project is listed");
  assert.equal(project.name, "project");
  assert.deepEqual(
    project.chats.map((chat) => chat.chatId),
    [f.chatId],
  );
  assert.equal(project.chats[0].title, "Watch CI");
  assert.equal(typeof project.chats[0].lastAt, "number");
});

test("routines:linear-options answers with empty choices and the reason while Linear is off", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.runtime.invoke("routines:linear-options", [{ team: "ENG" }]), {
    workspaces: [],
    teams: [],
    labels: [],
    states: [],
    error: "Linear is off in Settings › Connections › Linear.",
  });
});

test("routines:create refuses a Project that isn't registered", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.runtime.invoke("routines:create", [
      {
        name: "Elsewhere",
        prompt: "Look",
        trigger: { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" },
        target: { kind: "new-chat", projectPath: "/nowhere", workspace: "worktree" },
      },
    ]),
    /Project/,
  );
  // An agent can't be named as the author from a command.
  const { routine } = await f.runtime.invoke("routines:create", [
    {
      name: "Daily",
      prompt: "Look",
      trigger: { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" },
      target: { kind: "new-chat", projectPath: f.project, workspace: "worktree" },
      createdBy: { kind: "agent", chatId: f.chatId },
    },
  ]);
  assert.deepEqual(routine.createdBy, { kind: "user" });
});

test("a beat runs in the permission mode the user switched the Chat to after its last turn", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("Watching.");
  assert.equal((await f.list())[0].permissionMode, "full");
  // The composer's mode picker: Full → Ask with no turn running.
  await f.runtime.invoke("agent:set-permission-mode", [{ chatId: f.chatId, mode: "ask" }]);
  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  assert.equal(f.session.turns[1].permissionMode, "ask");
  assert.equal(f.session.turns[1].model, "cm");
});

test("a beat a quit cut off never resumes on restart: its Run shows interrupted and the next slot beats", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("Watching.");
  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  await eventually(async () => (await latestRun(f))?.status === "running");
  await f.runtime.close();

  const g = await fixture(t, { restart: { dir: f.dir, clock: f.clock() } });
  try {
    // Opening the Project is when a quit's stopped turns continue, and the fixture opened it: a resume's message (and the
    // run it starts) is saved before openProject answers.
    assert.equal(g.runtime.snapshot().runs.runs[g.chatId], undefined, "nothing resumes the beat");
    assert.equal(g.sessions.length, 0, "no agent started");
    assert.equal((await g.runtime.invoke("project:snapshot", [g.project])).state.sessions[g.id].resumeTurn, undefined);
    const run = await latestRun(g);
    assert.deepEqual([run.status, run.error], ["failed", "daemon restarted"]);
    await g.beat();
    await waitUntil(() => g.sessions.length === 1 && g.sessions[0].turns.length === 1);
    assert.match(g.sessions[0].turns[0].prompt, /^Check CI\n\nIf nothing needs doing/);
    await eventually(async () => (await latestRun(g)).status === "running");
  } finally {
    await g.runtime.close();
  }
});

test("a quiet beat leaves the Chat read when the user read it during the beat", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("Watching.");
  const unread = async () => (await f.runtime.invoke("project:snapshot", [f.project])).state.sessions[f.id].unread === true;
  await eventually(unread);

  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  // Unread when the beat went out; the user reads the Chat while it runs.
  await f.runtime.invoke("chat:patch", [f.project, f.id, { unread: false }]);
  await f.finish("(pass) CI green");
  await eventually(async () => (await f.messages()).findLast((message) => message.context?.kind === "routine-run").context.quiet === true);
  assert.equal(await unread(), false, "the mark the user cleared stays cleared");
});

test("a heartbeat and a Chat of its own fill in {{date}} and {{time}} the same way", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const prompt = "Look on {{date}} at {{time}}";
  const trigger = { kind: "schedule", cron: "*/5 * * * *", timezone: "America/Sao_Paulo" };
  const { routine: heartbeat } = await f.runtime.invoke("routines:create", [
    { name: "Beat", prompt, trigger, target: { kind: "chat", chatId: f.chatId }, maxRuns: 5 },
  ]);
  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  const beatAt = f.clock();
  const divider = (await f.messages()).findLast((message) => message.role === "user");
  await f.finish("(pass) fine");
  await eventually(async () => (await latestRun(f)).status === "quiet");
  await f.runtime.invoke("routines:delete", [heartbeat.id]);

  await f.runtime.invoke("routines:create", [{ name: "Own", prompt, trigger, target: { kind: "new-chat", projectPath: f.project, workspace: "project" } }]);
  await f.beat();
  const { state, session } = await runChat(f);
  const first = state.messages.find((message) => message.session_id === session.id && message.role === "user");
  const expected = (at) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const part = (type) => parts.find((item) => item.type === type).value;
    return `Look on ${part("year")}-${part("month")}-${part("day")} at ${part("hour")}:${part("minute")}`;
  };
  assert.equal(divider.body, expected(beatAt));
  assert.equal(first.body, expected(f.clock()));
});

test("the mode the user switched the Chat to holds for its beats after a restart", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("Watching.");
  assert.equal((await f.list())[0].permissionMode, "full");
  await f.runtime.invoke("agent:set-permission-mode", [{ chatId: f.chatId, mode: "ask" }]);
  await f.runtime.close();

  const g = await fixture(t, { restart: { dir: f.dir, clock: f.clock() } });
  try {
    await g.beat();
    await waitUntil(() => g.sessions.length === 1 && g.sessions[0].turns.length === 1);
    assert.equal(g.sessions[0].turns[0].permissionMode, "ask");
  } finally {
    await g.runtime.close();
  }
});

test("a Routine's target can only change to a Project Milagre lists: an unknown folder or a symlink out is refused and nothing changes", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const routine = await createTriage(f);
  const elsewhere = path.join(f.dir, "elsewhere");
  await fs.mkdir(elsewhere);
  const alias = path.join(f.project, "alias-out");
  await fs.symlink(elsewhere, alias);
  for (const projectPath of [elsewhere, alias, path.join(f.dir, "missing")]) {
    await assert.rejects(
      f.runtime.invoke("routines:update", [routine.id, { target: { kind: "new-chat", projectPath, workspace: "worktree" } }]),
      /Project/,
      projectPath,
    );
  }
  assert.deepEqual((await f.list())[0].target, { kind: "new-chat", projectPath: f.project, workspace: "worktree" });
  // The same Project by another spelling is stored as Milagre lists it.
  const updated = await f.runtime.invoke("routines:update", [
    routine.id,
    { target: { kind: "new-chat", projectPath: path.join(f.project, "sub", ".."), workspace: "project" } },
  ]);
  assert.deepEqual(updated.target, { kind: "new-chat", projectPath: f.project, workspace: "project" });
});

test("a Heartbeat from the Routines form needs a Chat that exists in a Project Milagre lists", async (t) => {
  const f = await fixture(t);
  const heartbeat = (chatId) => ({
    name: "Beat",
    prompt: "Look",
    trigger: { kind: "schedule", cron: "*/5 * * * *", timezone: "UTC" },
    target: { kind: "chat", chatId },
    maxRuns: 3,
  });
  await assert.rejects(f.runtime.invoke("routines:create", [heartbeat(`${f.project}#999`)]), /Chat/);
  await assert.rejects(f.runtime.invoke("routines:create", [heartbeat("/nowhere#1")]), /Project|Chat/);
  const { routine } = await f.runtime.invoke("routines:create", [heartbeat(f.chatId)]);
  assert.equal(routine.target.chatId, f.chatId);
  await assert.rejects(f.runtime.invoke("routines:update", [routine.id, { target: { kind: "chat", chatId: `${f.project}#999` } }]), /Chat/);
  assert.equal((await f.list())[0].target.chatId, f.chatId);
});

test("a mode the live agent couldn't take is still saved on the Chat for its next beat", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  f.session.failMode = true;
  await assert.rejects(f.runtime.invoke("agent:set-permission-mode", [{ chatId: f.chatId, mode: "ask" }]), /didn't take the mode/);
  assert.equal((await f.runtime.invoke("project:snapshot", [f.project])).state.sessions[f.id].permissionMode, "ask");
  await f.finish("Watching.");
  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  assert.equal(f.session.turns[1].permissionMode, "ask");
});

// Webhook Routines (Task C2): the relay hands deliveries to runtime.routines.receiveHook(s).
const crypto = require("node:crypto");
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const hmac = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");
const hookFile = (f) => path.join(f.dataDir, "routine-hooks.json");
const storedDeliveries = async (f) => Object.keys(JSON.parse(await fs.readFile(hookFile(f), "utf8")).deliveries);
let deliveryCount = 0;
const delivery = (hookId, body = '{"level":"error","title":"TypeError in checkout"}', headers = {}, extra = {}) => ({
  id: `d${++deliveryCount}`,
  hookId,
  receivedAt: Date.now(),
  headers: { "content-type": "application/json", ...headers },
  query: {},
  body: new TextEncoder().encode(body),
  ...extra,
});
async function createWebhook(f, extra = {}) {
  return f.runtime.invoke("routines:create", [
    {
      name: "Sentry",
      prompt: "Look at this error: {{body}} Title: {{body.title}}",
      trigger: { kind: "webhook" },
      target: { kind: "new-chat", projectPath: f.project, workspace: "worktree" },
      ...extra,
    },
  ]);
}
const secretOf = (url) => url.split("/hook/")[1];

test("a webhook Routine gets a URL; a delivery starts a Run whose first message holds the payload as untrusted data", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const { routine, hookUrl } = await createWebhook(f);
  assert.match(hookUrl, /^https:\/\/relay\.milagre\.cloud\/hook\/[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(routine.trigger, { kind: "webhook", hookId: sha256(secretOf(hookUrl)), signed: false });
  assert.deepEqual(await f.runtime.invoke("routines:hook", [routine.id]), { url: hookUrl, signed: false, signingHeader: "sentry-hook-signature" });
  assert.deepEqual(f.runtime.routines.hookIds(), [routine.trigger.hookId]);
  // The secret and the owner key live only in the hook store: never in the Routine list or routines.json.
  const owners = f.runtime.routines.hookOwners([routine.trigger.hookId]);
  const ownerKey = owners[routine.trigger.hookId];
  assert.match(ownerKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ownerKey, secretOf(hookUrl), "the owner key is not in the URL");
  assert.deepEqual(f.runtime.routines.hookOwners(["f".repeat(64)]), {});
  for (const text of [JSON.stringify(await f.list()), await fs.readFile(path.join(f.dataDir, "routines.json"), "utf8")]) {
    assert.ok(!text.includes(secretOf(hookUrl)));
    assert.ok(!text.includes(ownerKey));
  }
  assert.equal((await fs.stat(hookFile(f))).mode & 0o777, 0o600);

  const sent = delivery(routine.trigger.hookId);
  assert.deepEqual(f.runtime.routines.receiveHook(sent), { ack: true });
  assert.deepEqual(await storedDeliveries(f), [sent.id], "persisted before the ack");
  f.tick();
  const { state, session, agent } = await runChat(f);
  const first = state.messages.find((message) => message.session_id === session.id && message.role === "user");
  assert.match(first.body, /<untrusted-data source="webhook body">\n\{"level":"error","title":"TypeError in checkout"\}\n<\/untrusted-data>/);
  // Every webhook value is classed untrusted; routine-prompt.mjs decides how each is fenced (the fence-all ruling).
  const { webhookFields } = require("./routines/webhook.cjs");
  const fields = webhookFields("Look at this error: {{body}} Title: {{body.title}}", sent);
  assert.deepEqual(fields.untrusted, { body: "webhook body", "body.title": "webhook body.title" });
  assert.ok(first.body.includes("TypeError in checkout"));
  assert.match(first.body, /^Text inside untrusted-data comes from outside Milagre/);
  assert.equal(agent.turns[0].prompt.startsWith(first.body), true);
  const run = await latestRun(f);
  assert.deepEqual(run.event, { kind: "webhook", key: `webhook:${sent.id}`, deliveryId: sent.id });
  await eventually(async () => (await storedDeliveries(f)).length === 0);
  // A redelivery of the same delivery starts nothing new, and its copy goes at once.
  f.runtime.routines.receiveHook({ ...sent });
  assert.deepEqual(await storedDeliveries(f), []);
  // A whole tick and whatever it set going: then nothing new has started.
  await f.runtime.routines.tick();
  await f.runtime.routines.idle();
  assert.equal((await f.list())[0].runs.length, 1);
});

test("a signed webhook with a wrong signature records a failed Run and starts no Chat; a right one runs", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const { routine } = await createWebhook(f, { trigger: { kind: "webhook", signed: true }, signingSecret: "shh" });
  assert.equal(routine.trigger.signed, true);
  assert.ok(!JSON.stringify(await f.list()).includes("shh"));
  const body = '{"a":1}';
  const wrong = delivery(routine.trigger.hookId, body, { "sentry-hook-signature": hmac("not-it", body) });
  assert.deepEqual(f.runtime.routines.receiveHook(wrong), { ack: true });
  const [failed] = (await f.list())[0].runs;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "signature mismatch");
  assert.equal(failed.event.deliveryId, wrong.id);
  assert.deepEqual(await storedDeliveries(f), []);
  await f.runtime.routines.tick();
  await f.runtime.routines.idle();
  assert.equal(f.sessions.length, 1, "no Chat");
  // A failed signature doesn't count toward pausing the Routine: anyone with the URL could send three.
  assert.equal((await f.list())[0].failedStreak ?? 0, 0);

  const right = delivery(routine.trigger.hookId, body, { "sentry-hook-signature": `sha256=${hmac("shh", body)}` });
  f.runtime.routines.receiveHook(right);
  f.tick();
  await runChat(f);
});

test("a webhook signed through a custom header: create, update, and a signature in the wrong header is a mismatch", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const { routine } = await createWebhook(f, { signingSecret: "gh", signingHeader: "X-Hub-Signature-256" });
  assert.equal(routine.signingHeader, "x-hub-signature-256");
  assert.equal((await f.runtime.invoke("routines:hook", [routine.id])).signingHeader, "x-hub-signature-256");
  await assert.rejects(f.runtime.invoke("routines:update", [routine.id, { signingHeader: "not a header" }]), /header name/);
  const body = '{"action":"opened"}';
  // Right HMAC, but in the default header instead of the Routine's.
  f.runtime.routines.receiveHook(delivery(routine.trigger.hookId, body, { "sentry-hook-signature": hmac("gh", body) }));
  assert.equal((await f.list())[0].runs[0].error, "signature mismatch");
  const moved = await f.runtime.invoke("routines:update", [routine.id, { signingHeader: "X-Signature" }]);
  assert.equal(moved.signingHeader, "x-signature");
  assert.equal(moved.trigger.signed, true, "a header change keeps the signing secret");
  f.runtime.routines.receiveHook(delivery(routine.trigger.hookId, body, { "x-hub-signature-256": `sha256=${hmac("gh", body)}` }));
  assert.equal((await f.list())[0].runs.filter((run) => run.error === "signature mismatch").length, 2, "the old header no longer counts");
  f.runtime.routines.receiveHook(delivery(routine.trigger.hookId, body, { "x-signature": `sha256=${hmac("gh", body)}` }));
  f.tick();
  await runChat(f);
  const reset = await f.runtime.invoke("routines:update", [routine.id, { signingHeader: "" }]);
  assert.equal(reset.signingHeader, undefined);
  assert.equal((await f.runtime.invoke("routines:hook", [routine.id])).signingHeader, "sentry-hook-signature");
});

test("rotating a webhook kills the old hook id, keeps it signed, and a delivery for the old id starts nothing", async (t) => {
  const f = await fixture(t);
  const { routine, hookUrl } = await createWebhook(f, { trigger: { kind: "webhook", signed: true }, signingSecret: "shh", signingHeader: "X-Signature" });
  const changes = () => f.emitted.filter((item) => item.channel === "routines:changed").length;
  const before = changes();
  const ownerBefore = f.runtime.routines.hookOwners([routine.trigger.hookId])[routine.trigger.hookId];
  const { url } = await f.runtime.invoke("routines:rotate-hook", [routine.id]);
  const ownerAfter = f.runtime.routines.hookOwners([sha256(secretOf(url))])[sha256(secretOf(url))];
  assert.match(ownerAfter, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ownerAfter, ownerBefore, "rotation makes a new owner key too");
  assert.ok(changes() > before, "the relay hears about it");
  assert.notEqual(url, hookUrl);
  const [rotated] = await f.list();
  assert.deepEqual(rotated.trigger, { kind: "webhook", hookId: sha256(secretOf(url)), signed: true });
  assert.deepEqual(f.runtime.routines.hookIds(), [rotated.trigger.hookId]);
  assert.deepEqual(await f.runtime.invoke("routines:hook", [routine.id]), { url, signed: true, signingHeader: "x-signature" });
  const body = "{}";
  assert.deepEqual(f.runtime.routines.receiveHook(delivery(routine.trigger.hookId, body, { "x-signature": hmac("shh", body) })), { ack: true });
  assert.deepEqual((await f.list())[0].runs, []);
  assert.deepEqual(await storedDeliveries(f), []);
});

test("a delivery for a deleted or paused Routine is acked, dropped and starts nothing", async (t) => {
  const f = await fixture(t);
  const { routine } = await createWebhook(f);
  const { routine: paused } = await createWebhook(f, { name: "Paused" });
  await f.runtime.invoke("routines:update", [paused.id, { enabled: false }]);
  assert.deepEqual(f.runtime.routines.hookIds(), [routine.trigger.hookId]);
  await f.runtime.invoke("routines:delete", [routine.id]);
  assert.deepEqual(f.runtime.routines.hookIds(), []);
  await assert.rejects(f.runtime.invoke("routines:hook", [routine.id]), /Routine not found/);
  assert.deepEqual(f.runtime.routines.receiveHook(delivery(routine.trigger.hookId)), { ack: true });
  assert.deepEqual(f.runtime.routines.receiveHook(delivery(paused.trigger.hookId)), { ack: true });
  assert.deepEqual(await storedDeliveries(f), []);
  await f.runtime.routines.tick();
  await f.runtime.routines.idle();
  assert.deepEqual((await f.list()).find((item) => item.id === paused.id).runs, []);
  assert.equal(f.sessions.length, 1);
});

test("several deliveries at once queue in one batch, each its own Run", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const { routine } = await createWebhook(f);
  const writes = f.emitted.filter((item) => item.channel === "routines:changed").length;
  assert.deepEqual(f.runtime.routines.receiveHooks([delivery(routine.trigger.hookId), delivery(routine.trigger.hookId)]), { ack: true });
  assert.equal(f.emitted.filter((item) => item.channel === "routines:changed").length, writes + 1, "one change for the batch");
  f.tick();
  await waitUntil(() => f.sessions.length === 3 && f.sessions.slice(1).every((session) => session.turns.length === 1), { timeoutMs: 10_000 });
});

test("webhook signing: signed: false clears the secret, a new secret signs again, and signed without a secret is refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(createWebhook(f, { trigger: { kind: "webhook", signed: true } }), /signing secret/);
  const { routine } = await createWebhook(f, { signingSecret: "first" });
  assert.equal(routine.trigger.signed, true, "a signing secret signs it");
  const off = await f.runtime.invoke("routines:update", [routine.id, { trigger: { kind: "webhook", signed: false } }]);
  assert.deepEqual(off.trigger, routine.trigger.signed ? { ...routine.trigger, signed: false } : routine.trigger);
  assert.equal((await f.runtime.invoke("routines:hook", [routine.id])).signed, false);
  await assert.rejects(f.runtime.invoke("routines:update", [routine.id, { trigger: { kind: "webhook", signed: true } }]), /signing secret/);
  const ownerKey = f.runtime.routines.hookOwners([routine.trigger.hookId])[routine.trigger.hookId];
  const on = await f.runtime.invoke("routines:update", [routine.id, { signingSecret: "second", signingHeader: "x-hub" }]);
  assert.equal(f.runtime.routines.hookOwners([routine.trigger.hookId])[routine.trigger.hookId], ownerKey, "an update keeps the owner key");
  assert.equal(on.trigger.signed, true);
  assert.equal(on.trigger.hookId, routine.trigger.hookId, "update never changes the URL");
  assert.deepEqual(await f.runtime.invoke("routines:hook", [routine.id]), {
    url: (await f.runtime.invoke("routines:hook", [routine.id])).url,
    signed: true,
    signingHeader: "x-hub",
  });
  await assert.rejects(f.runtime.invoke("routines:update", [routine.id, { trigger: { kind: "webhook", hookId: "b".repeat(64) } }]), /Rotate/);
  const listed = JSON.stringify(await f.list());
  assert.ok(!listed.includes("second") && !listed.includes("first"));
});

test("hooks stay off with the Routines switch, and a hook the relay refuses shows on its Routine until it is taken", async (t) => {
  const f = await fixture(t);
  const { routine } = await createWebhook(f);
  f.runtime.routines.hooksRefused([routine.trigger.hookId]);
  assert.match((await f.list())[0].lastError, /relay/);
  f.runtime.routines.hooksRefused([]);
  assert.equal((await f.list())[0].lastError, undefined);
  await f.runtime.invoke("routines:enabled:save", [false]);
  assert.deepEqual(f.runtime.routines.hookIds(), []);
  assert.deepEqual(f.runtime.routines.receiveHook(delivery(routine.trigger.hookId)), { ack: true });
  assert.deepEqual(await storedDeliveries(f), []);
});

test("a redelivery of one still waiting in the queue keeps the copy its Run needs", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const { routine } = await createWebhook(f);
  const sent = delivery(routine.trigger.hookId);
  f.runtime.routines.receiveHook(sent);
  f.runtime.routines.receiveHook({ ...sent });
  assert.deepEqual(await storedDeliveries(f), [sent.id]);
  f.tick();
  await runChat(f);
});

test("routines:targets lists a Project's Chats without opening it, so nothing a quit stopped resumes", async (t) => {
  const f = await fixture(t);
  // The user's turn is running when Milagre quits: it is saved to resume once its Project opens.
  await f.runtime.close();
  const g = await fixture(t, { restart: { dir: f.dir, clock: f.clock() }, open: false });
  try {
    const { projects } = await g.runtime.invoke("routines:targets");
    const project = projects.find((item) => item.path === f.project);
    assert.ok(project, "the Project is listed");
    assert.deepEqual(
      project.chats.map((chat) => chat.chatId),
      [f.chatId],
    );
    // Opening a Project resumes what a quit stopped before it answers (resumeInterrupted saves the resume message and
    // the Chat's run starts with it), so a run here means the lookup opened the Project.
    assert.equal(g.runtime.snapshot().runs.runs[f.chatId], undefined, "nothing resumed");
    assert.equal(g.sessions.length, 0, "no agent started");
  } finally {
    await g.runtime.close();
  }
});

test("routines:targets within a folder reads only the Projects inside it", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const inside = await f.runtime.invoke("routines:targets", [{ within: f.project }]);
  assert.deepEqual(
    inside.projects.map((project) => project.path),
    [f.project],
  );
  const elsewhere = await f.runtime.invoke("routines:targets", [{ within: path.join(f.dir, "elsewhere") }]);
  assert.deepEqual(elsewhere.projects, []);
});

test("an agent's routine_delete of a webhook Routine forgets its URL secret too", async (t) => {
  const f = await fixture(t);
  await f.finish("ok");
  const { routine, hookUrl } = await createWebhook(f);
  const secrets = async () => JSON.parse(await fs.readFile(hookFile(f), "utf8")).secrets;
  assert.ok((await secrets())[routine.id], "the secret is stored");
  const deleted = await runTool(f.tool("routine_delete"), { id: routine.id });
  assert.equal(deleted.isError, false, deleted.text);
  assert.equal((await secrets())[routine.id], undefined, "the secret is gone");
  assert.ok(!(await fs.readFile(hookFile(f), "utf8")).includes(secretOf(hookUrl)));
});
